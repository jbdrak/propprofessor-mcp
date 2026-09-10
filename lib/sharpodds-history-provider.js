'use strict';

// Bounded SharpOdds exact-lookup history fallback (Task 5).
//
// Wraps the injected SharpOdds client (lib/sharpodds-client.js), the history
// normalizer (lib/sharpodds-history.js), and the conservative matcher
// (lib/sharpodds-match.js) behind a single `resolve(row)` seam used by
// ranked scans and exact single-game detail paths. Broad scans should reuse a
// request-scoped provider so the board is not refetched for every pair.
//
// Rules:
// - Standard main markets only (Moneyline -> ML, Point Spread/Run Line/
//   Puck Line/Game Handicap -> SPREAD, Total Games/Points/Runs/Goals ->
//   TOTAL). Anything else, or a non-full-game segment, returns a structured
//   unavailable result — never a guess.
// - One board fetch per provider instance (cached promise) plus a per
//   event/market/side/book history cache, so one exact lookup with many
//   rows does not refetch the board. No file writes, no polling.
// - History is returned only when the board event matches via
//   matchSharpOddsEvent (teams + league + start time) AND the normalized
//   history is usable (>= 2 real timestamped points).
// - Client failures (timeout, empty/partial, mismatch, parse) return
//   unavailable with a reason; they never throw into the PP path unless the
//   injected error is explicitly marked fatal (`error.fatal === true`).

const {
  normalizeSharpOddsHistory,
  parseTimezoneOffsetMinutes
} = require('./sharpodds-history');
const { matchSharpOddsEvent, normalizeTeamName, normalizeLeague, normalizeSegment } = require('./sharpodds-match');
const { getLocalTimezone } = require('./mcp-runtime-config');

const DEFAULT_SHARP_BOOKS = ['Pinnacle', 'Circa', 'BetOnline'];

// Full-game-only market map. Keys are lowercase exact PP market names.
const MARKET_MAP = new Map([
  ['moneyline', 'ML'],
  ['point spread', 'SPREAD'],
  ['run line', 'SPREAD'],
  ['puck line', 'SPREAD'],
  ['game handicap', 'SPREAD'],
  ['spread', 'SPREAD'],
  ['total games', 'TOTAL'],
  ['total points', 'TOTAL'],
  ['total runs', 'TOTAL'],
  ['total goals', 'TOTAL'],
  ['total', 'TOTAL']
]);

const HISTORY_MARKET_NAMES = { ML: 'moneyline', SPREAD: 'spread', TOTAL: 'total' };

// Any hint of a non-full-game segment fails closed.
const NON_FULLGAME_RE = /(1st|2nd|3rd|4th|first|second|third|fourth|half|quarter|period|inning|live|1h|2h|1q|2q|3q|4q|1p|2p|3p|\bq[1-4]\b|\bp[1-3]\b)/i;
const FULLGAME_RE = /^(game|full[-\s]?game|fulltime|full time|regulation|match|main)$/i;

function mapRowMarket(market) {
  const key = String(market ?? '').trim().toLowerCase();
  if (!key) return null;
  if (NON_FULLGAME_RE.test(key)) return null;
  return MARKET_MAP.get(key) || null;
}

function rowSegmentSupported(row) {
  if (!row || typeof row !== 'object') return true;
  const segment = row.segment ?? row.period ?? row.gameSegment;
  if (segment === undefined || segment === null || String(segment).trim() === '') return true;
  return FULLGAME_RE.test(String(segment).trim());
}

function marketTextIndicatesSegment(row) {
  const text = String(row?.market ?? row?.playType ?? '');
  return NON_FULLGAME_RE.test(text);
}

function normalizeSideToken(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'away' || key === 'a') return 'away';
  if (key === 'home' || key === 'h') return 'home';
  if (key === 'over' || key === 'o') return 'over';
  if (key === 'under' || key === 'u') return 'under';
  return null;
}

// Derive the history column side ('away' | 'home'). Totals encode over in
// the away column and under in the home column. Returns null when the side
// cannot be determined confidently — the caller fails closed.
function deriveSide(row, tMarket) {
  const explicit = normalizeSideToken(row?.side ?? row?.requestedSide);
  if (explicit === 'away' || explicit === 'home') return explicit;
  if (explicit === 'over') return tMarket === 'TOTAL' ? 'away' : null;
  if (explicit === 'under') return tMarket === 'TOTAL' ? 'home' : null;

  const pickText = String(row?.pick ?? row?.selection ?? row?.participant ?? '').trim();
  const totalMatch = pickText.match(/^(over|under)\b/i);
  if (totalMatch) {
    if (tMarket !== 'TOTAL') return null;
    return totalMatch[1].toLowerCase() === 'over' ? 'away' : 'home';
  }

  // Team-side markets: match the selection text against the row's teams.
  const home = normalizeTeamName(row?.homeTeam ?? row?.home);
  const away = normalizeTeamName(row?.awayTeam ?? row?.away);
  if (!home || !away) return null;
  const candidates = [
    row?.selection,
    row?.pick,
    row?.participant,
    // Spread-style pick: "Team -1.5" -> "Team".
    pickText.replace(/\s+[+-]\d+(?:\.\d+)?$/, ''),
    // SelectionId suffix: "Market:Label" -> "Label".
    String(row?.selectionId ?? row?.selection_id ?? '').split(':').pop()
  ];
  for (const candidate of candidates) {
    const normalized = normalizeTeamName(candidate);
    if (!normalized) continue;
    if (normalized === home) return 'home';
    if (normalized === away) return 'away';
  }
  return null;
}

function parseStartMs(row) {
  const raw =
    row?.startTime ?? row?.start_time ?? row?.start ?? row?.startTimestamp ??
    row?.gameTime ?? row?.commenceTime ?? row?.game?.startTime ?? null;
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw < 1e12 && raw >= 1e9 ? Math.floor(raw * 1000) : Math.floor(raw);
  }
  const ms = Date.parse(String(raw).trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Convert an IANA timezone to numeric offset minutes east of UTC
 * (local minus UTC) at the event start. DST-aware via Intl. Returns null
 * when the zone cannot be converted deterministically — callers fail
 * closed rather than guessing.
 */
function ianaOffsetMinutes(timezone, startMs) {
  const zone = String(timezone ?? '').trim();
  if (!zone || !Number.isFinite(startMs)) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const parts = {};
    for (const part of formatter.formatToParts(new Date(startMs))) {
      if (part.type !== 'literal') parts[part.type] = part.value;
    }
    const asUtcMs = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    if (!Number.isFinite(asUtcMs)) return null;
    const offset = Math.round((asUtcMs - startMs) / 60000);
    return Math.abs(offset) > 18 * 60 ? null : offset;
  } catch {
    return null;
  }
}

// Numeric offset minutes east of UTC (local minus UTC). An explicit numeric
// option ('-0400', minutes) is used verbatim; an IANA option is converted at
// the event start. The default is the PP local timezone (America/Chicago),
// NOT the machine zone, which may be UTC in production. Anything
// unconvertible fails closed.
function resolveOffsetMinutes(timezoneOption, startMs) {
  if (timezoneOption !== undefined && timezoneOption !== null && String(timezoneOption).trim() !== '') {
    const numeric = parseTimezoneOffsetMinutes(timezoneOption);
    if (numeric !== null) return numeric;
    return ianaOffsetMinutes(timezoneOption, startMs);
  }
  return ianaOffsetMinutes(getLocalTimezone(), startMs);
}

function formatOffsetParam(offsetMinutes) {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(Math.trunc(offsetMinutes));
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}

function flipHistorySide(side) {
  if (side === 'home') return 'away';
  if (side === 'away') return 'home';
  return side;
}

function isFullGameHistoryPeriod(value) {
  if (value === null || value === undefined || String(value).trim() === '') return true;
  const normalized = normalizeSegment(value);
  return normalized === 'full-game' || String(value).trim() === '0';
}

function historyTeamsMatch(left, right) {
  const leftName = normalizeTeamName(left);
  const rightName = normalizeTeamName(right);
  if (!leftName || !rightName) return false;
  if (leftName === rightName) return true;
  const initials = (name) => name.split(' ').map((part) => part[0]).join('');
  return (
    (initials(leftName).length >= 3 && initials(leftName) === rightName) ||
    (initials(rightName).length >= 3 && initials(rightName) === leftName)
  );
}

function historyIdentityMatches(normalized, { homeTeam, awayTeam, league, dateKey, selectedBook }) {
  const event = normalized?.event || {};
  const historyHome = event.homeTeam;
  const historyAway = event.awayTeam;
  const teamsMatch =
    (historyTeamsMatch(historyHome, homeTeam) && historyTeamsMatch(historyAway, awayTeam)) ||
    (historyTeamsMatch(historyHome, awayTeam) && historyTeamsMatch(historyAway, homeTeam));
  if (!teamsMatch) return false;
  if (event.date && String(event.date).trim() !== String(dateKey).trim()) return false;
  if (!isFullGameHistoryPeriod(event.period)) return false;
  if (event.sportsbook && String(event.sportsbook).trim().toLowerCase() !== String(selectedBook).trim().toLowerCase()) return false;
  if (event.league && league && normalizeLeague(event.league) !== normalizeLeague(league)) return false;
  return true;
}

function requestDateKey(startMs, offsetMinutes) {
  return new Date(startMs + offsetMinutes * 60 * 1000).toISOString().slice(0, 10);
}

function readLeague(row) {
  return row?.league ?? row?.sport ?? row?.leagueName ?? null;
}

// --- Board extraction (defensive across board envelope shapes) ---

function pushBoardEntries(value, groupLeague, out) {
  if (!Array.isArray(value)) return false;
  let pushed = false;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.games)) {
      // League group: { league, games: [game...] } — the live board shape.
      const league = entry.league ?? entry.sport ?? entry.leagueName ?? groupLeague ?? null;
      pushed = pushBoardEntries(entry.games, league, out) || pushed;
    } else {
      out.push({ event: entry, groupLeague });
      pushed = true;
    }
  }
  return pushed;
}

function collectBoardEvents(boardData) {
  const out = [];
  if (!boardData) return out;
  if (Array.isArray(boardData)) {
    pushBoardEntries(boardData, null, out);
    return out;
  }
  if (typeof boardData !== 'object') return out;
  for (const key of ['data', 'events', 'games', 'rows']) {
    if (pushBoardEntries(boardData[key], null, out)) return out;
  }
  // League-grouped object: { MLB: [...], ... } at top level or under `data`.
  for (const container of [boardData, boardData.data]) {
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
    let pushed = false;
    for (const [groupKey, list] of Object.entries(container)) {
      if (groupKey === 'books') continue;
      if (pushBoardEntries(list, groupKey, out)) pushed = true;
    }
    if (pushed) return out;
  }
  return out;
}

function extractBooks(rawEvent) {
  const raw = rawEvent?.books ?? rawEvent?.sportsbooks ?? null;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const id = entry.id ?? entry.bookId ?? entry.bid ?? null;
        const name = entry.name ?? entry.book ?? entry.bookName ?? entry.sn ?? null;
        if (name === null || name === undefined || String(name).trim() === '') return null;
        return { id: id === null || id === undefined ? null : id, name: String(name).trim() };
      })
      .filter(Boolean);
  }
  if (typeof raw === 'object') {
    return Object.entries(raw)
      .map(([key, value]) => {
        // Live board root shape: books: { '0': { id: 25, name: 'Pinnacle' } }.
        if (value && typeof value === 'object') {
          const id = value.id ?? value.bookId ?? value.bid ?? null;
          const name = value.name ?? value.book ?? value.bookName ?? value.sn ?? null;
          if (name === null || name === undefined || String(name).trim() === '') return null;
          return { id: id === null || id === undefined ? null : id, name: String(name).trim() };
        }
        if (typeof value === 'string' && /^\d+$/.test(key.trim())) return { id: key.trim(), name: value.trim() };
        if (typeof value === 'number' && key.trim()) return { id: value, name: key.trim() };
        return null;
      })
      .filter(Boolean);
  }
  return [];
}

function pickSharpBooks(books, preferredList) {
  const lowered = new Map();
  for (const book of books) lowered.set(String(book.name).toLowerCase(), book);
  return preferredList.map((preferred) => lowered.get(String(preferred).toLowerCase())).filter(Boolean);
}

function unavailable(reason, warning) {
  return {
    lineHistoryAvailable: false,
    lineHistory: [],
    lineHistorySource: null,
    historyProvider: 'sharpodds',
    historyWarning: warning || reason,
    historyReason: reason
  };
}

// Fetch + normalize + usable-gate for one cached history entry. Extracted
// from resolve() so the lint complexity budget holds; behavior unchanged
// (fatal errors rethrow, all other failures return unavailable results).
async function fetchHistoryEntry({
  client,
  tMarket,
  side,
  offsetParam,
  dateKey,
  eventId,
  selectedBook,
  eventAway,
  eventHome,
  historyLeague
}) {
  let payload;
  try {
    const response = await client.fetchHistory({
      market: tMarket,
      date: dateKey,
      gameId: String(eventId),
      // Full-game period. The public endpoint accepts an omitted
      // sport id, so no sport-ID map is built.
      period: '0',
      timezone: offsetParam,
      bookName: selectedBook.name,
      awayTeam: String(eventAway),
      homeTeam: String(eventHome),
      ...(selectedBook.id !== null && selectedBook.id !== undefined ? { bookId: selectedBook.id } : {}),
      ...(historyLeague ? { league: historyLeague } : {})
    });
    payload = response && response.data !== undefined ? response.data : response;
  } catch (error) {
    if (error && error.fatal === true) throw error;
    const category = error && error.category;
    return unavailable(
      category === 'timeout' ? 'timeout' : 'history_error',
      category === 'timeout'
        ? 'SharpOdds history request timed out.'
        : `SharpOdds history request failed (${(error && error.message) || 'unknown error'}).`
    );
  }
  let normalized;
  try {
    normalized = normalizeSharpOddsHistory(payload, {
      market: HISTORY_MARKET_NAMES[tMarket],
      side,
      timezone: offsetParam,
      book: selectedBook.name
    });
  } catch (error) {
    return unavailable('history_parse_error', `SharpOdds history could not be parsed (${(error && error.message) || 'parse error'}).`);
  }
  if (!normalized || normalized.lineHistoryUsable !== true) {
    const warnings = Array.isArray(normalized?.warnings) ? normalized.warnings.join(', ') : '';
    return unavailable(
      'history_unusable',
      `SharpOdds history is not usable for this game${warnings ? ` (${warnings}).` : '.'}`
    );
  }
  if (
    !historyIdentityMatches(normalized, {
      homeTeam: eventHome,
      awayTeam: eventAway,
      league: historyLeague,
      dateKey,
      selectedBook: selectedBook.name
    })
  ) {
    return unavailable('history_identity_mismatch', 'SharpOdds history metadata did not match the matched event.');
  }
  return {
    lineHistoryAvailable: true,
    // Canonical PP point shape. `pub` is preserved verbatim as raw
    // provider context only — ticket/money percentages are never
    // invented.
    lineHistory: normalized.points.map((point) => ({
      time: point.time,
      line: point.line,
      odds: point.odds,
      book: point.book,
      liquidity: null,
      pub: point.pub ?? null
    })),
    lineHistorySource: 'sharpodds',
    historyProvider: 'sharpodds',
    historyGameId: String(eventId),
    historyMatchedBy: 'sharpodds_event',
    historyMatchKey: 'sharpodds_event',
    historySportsbooksRequested: [selectedBook.name],
    movementSourceBook: selectedBook.name,
    movementMode: 'same_book',
    lineFieldMissingCount: 0
  };
}

function validateResolveInput(clientValid, row) {
  if (!clientValid) return unavailable('provider_misconfigured', 'SharpOdds provider is not configured.');
  if (!row || typeof row !== 'object') return unavailable('row_missing', 'No row supplied for SharpOdds lookup.');
  return null;
}

async function resolveSelectedBookHistory({
  selectedBooks,
  historyCache,
  maxHistoryCacheEntries,
  client,
  tMarket,
  side,
  offsetParam,
  dateKey,
  eventId,
  eventAway,
  eventHome,
  historyLeague,
  cacheKey
}) {
  let lastUnavailable = null;
  for (const selectedBook of selectedBooks) {
    const key = cacheKey({ eventId: String(eventId), tMarket, side, bookName: selectedBook.name });
    if (!historyCache.has(key)) {
      if (historyCache.size >= maxHistoryCacheEntries) {
        const oldestKey = historyCache.keys().next().value;
        if (oldestKey !== undefined) historyCache.delete(oldestKey);
      }
      historyCache.set(
        key,
        fetchHistoryEntry({
          client,
          tMarket,
          side,
          offsetParam,
          dateKey,
          eventId,
          selectedBook,
          eventAway,
          eventHome,
          historyLeague
        })
      );
    }
    const result = await historyCache.get(key);
    if (result?.lineHistoryAvailable === true) return result;
    lastUnavailable = result;
  }
  return lastUnavailable || unavailable('history_unusable', 'No preferred SharpOdds book returned usable history.');
}

function createProviderCaches({ client, boardTtlMs, historyCacheMaxEntries }) {
  const boardCacheTtlMs = Number.isFinite(Number(boardTtlMs)) && Number(boardTtlMs) > 0 ? Number(boardTtlMs) : 30_000;
  const maxHistoryCacheEntries =
    Number.isFinite(Number(historyCacheMaxEntries)) && Number(historyCacheMaxEntries) > 0
      ? Math.trunc(Number(historyCacheMaxEntries))
      : 512;
  let boardPromise = null;
  let boardFetchedAt = 0;
  const historyCache = new Map();

  return {
    historyCache,
    maxHistoryCacheEntries,
    getBoard() {
      const now = Date.now();
      if (!boardPromise || now - boardFetchedAt >= boardCacheTtlMs) {
        boardFetchedAt = now;
        boardPromise = Promise.resolve()
          .then(() => client.fetchBoard())
          .catch((error) => {
            boardPromise = null;
            boardFetchedAt = 0;
            throw error;
          });
      }
      return boardPromise;
    }
  };
}

/**
 * @param {{ client?: any, sharpBooks?: string[], timezone?: any, boardTtlMs?: number, historyCacheMaxEntries?: number }} [options]
 */
function createSharpOddsHistoryProvider(options = {}) {
  const { client, sharpBooks, timezone: defaultTimezone, boardTtlMs, historyCacheMaxEntries } = options || {};
  const clientValid =
    client && typeof client.fetchBoard === 'function' && typeof client.fetchHistory === 'function';
  const defaultSharpBooks =
    Array.isArray(sharpBooks) && sharpBooks.length
      ? sharpBooks.map((book) => String(book).trim()).filter(Boolean)
      : [...DEFAULT_SHARP_BOOKS];

  const { historyCache, maxHistoryCacheEntries, getBoard } = createProviderCaches({
    client,
    boardTtlMs,
    historyCacheMaxEntries
  });

  function cacheKey({ eventId, tMarket, side, bookName }) {
    return `${eventId}::${tMarket}::${side}::${bookName}`;
  }

  async function resolve(row, resolveOptions = {}) {
    const inputError = validateResolveInput(clientValid, row);
    if (inputError) return inputError;

    const tMarket = mapRowMarket(row.market ?? row.playType);
    if (!tMarket) return unavailable('market_unsupported', `SharpOdds lookup does not support market "${row?.market ?? row?.playType ?? 'unknown'}".`);
    if (!rowSegmentSupported(row) || marketTextIndicatesSegment(row)) {
      return unavailable('segment_unsupported', 'SharpOdds lookup supports full-game markets only.');
    }
    const requestedSide = deriveSide(row, tMarket);
    if (!requestedSide) return unavailable('side_unknown', 'Could not determine the SharpOdds side (away/home) for this row.');

    const homeTeam = row.homeTeam ?? row.home ?? null;
    const awayTeam = row.awayTeam ?? row.away ?? null;
    if (!homeTeam || !awayTeam) return unavailable('teams_missing', 'SharpOdds lookup needs both home and away teams.');
    const startMs = parseStartMs(row);
    if (!Number.isFinite(startMs)) return unavailable('start_time_missing', 'SharpOdds lookup needs a parseable start time.');
    const league = readLeague(row);

    const preferredList =
      Array.isArray(resolveOptions.sharpBooks) && resolveOptions.sharpBooks.length
        ? resolveOptions.sharpBooks.map((book) => String(book).trim()).filter(Boolean)
        : defaultSharpBooks;
    const timezoneOption = resolveOptions.timezone ?? defaultTimezone;
    const offsetMinutes = resolveOffsetMinutes(timezoneOption, startMs);
    if (offsetMinutes === null) {
      return unavailable('timezone_unknown', 'SharpOdds lookup needs a numeric timezone offset.');
    }
    const offsetParam = formatOffsetParam(offsetMinutes);
    const dateKey = requestDateKey(startMs, offsetMinutes);

    let board;
    try {
      board = await getBoard();
    } catch (error) {
      if (error && error.fatal === true) throw error;
      const category = error && error.category;
      return unavailable(
        category === 'timeout' ? 'timeout' : 'board_error',
        category === 'timeout'
          ? 'SharpOdds board request timed out.'
          : `SharpOdds board request failed (${(error && error.message) || 'unknown error'}).`
      );
    }
    const boardPayload = board && board.data !== undefined ? board.data : board;
    const entries = collectBoardEvents(boardPayload);
    if (!entries.length) return unavailable('board_empty', 'SharpOdds board returned no events.');
    // The book map lives at the board root (live shape:
    // { data: { data: [...], books: { '0': { id, name } } } }), not on the
    // individual game. Per-event books are only a fallback when the root
    // map is absent.
    const rootBooksSource =
      board && typeof board === 'object'
        ? (board.books ??
          (board.data && typeof board.data === 'object' && !Array.isArray(board.data) ? board.data.books : undefined))
        : undefined;
    const rootBooks = extractBooks({ books: rootBooksSource });

    const request = { homeTeam, awayTeam, league, startTime: startMs };
    const matchOptions =
      Number.isFinite(Number(resolveOptions.timeToleranceMs)) && Number(resolveOptions.timeToleranceMs) > 0
        ? { timeToleranceMs: Number(resolveOptions.timeToleranceMs) }
        : undefined;
    let matched = null;
    for (const { event: rawEvent, groupLeague } of entries) {
      const candidate =
        rawEvent && typeof rawEvent === 'object' && (rawEvent.league === undefined || rawEvent.league === null) && groupLeague
          ? { ...rawEvent, league: groupLeague }
          : rawEvent;
      let result;
      try {
        result = matchSharpOddsEvent(request, candidate, matchOptions);
      } catch {
        continue;
      }
      if (result && result.matched) {
        matched = { rawEvent: candidate, groupLeague, match: result };
        break;
      }
    }
    if (!matched) return unavailable('event_mismatch', 'No SharpOdds event matched this game (teams/league/time).');

    const eventBooks = extractBooks(matched.rawEvent);
    const bookPool = rootBooks.length ? rootBooks : eventBooks;
    let selectedBooks = bookPool.length ? pickSharpBooks(bookPool, preferredList) : [];
    if (!selectedBooks.length && !bookPool.length && preferredList.length) {
      selectedBooks = [{ id: null, name: preferredList[0] }];
    }
    if (!selectedBooks.length) return unavailable('book_unavailable', 'None of the preferred sharp books post this SharpOdds event.');

    const rawEvent = matched.rawEvent;
    const eventId =
      rawEvent?.event && typeof rawEvent.event === 'object'
        ? (rawEvent.event.id ?? rawEvent.event.eventId ?? rawEvent.event.gameId ?? rawEvent.id ?? rawEvent.eventId ?? rawEvent.gameId ?? rawEvent.n)
        : (rawEvent.id ?? rawEvent.eventId ?? rawEvent.gameId ?? rawEvent.n);
    if (eventId === null || eventId === undefined || String(eventId).trim() === '') {
      return unavailable('event_mismatch', 'Matched SharpOdds event has no usable event id.');
    }
    const historyLeague =
      rawEvent?.league ?? rawEvent?.sport ?? (rawEvent?.event && rawEvent.event.league) ?? matched.groupLeague ?? league ?? null;
    const eventHome = rawEvent?.homeTeam ?? rawEvent?.home_team ?? rawEvent?.home ?? rawEvent?.hn ?? homeTeam;
    const eventAway = rawEvent?.awayTeam ?? rawEvent?.away_team ?? rawEvent?.away ?? rawEvent?.an ?? awayTeam;
    return resolveSelectedBookHistory({
      selectedBooks,
      historyCache,
      maxHistoryCacheEntries,
      client,
      tMarket,
      side: tMarket === 'TOTAL' ? requestedSide : matched.match.order === 'swapped' ? flipHistorySide(requestedSide) : requestedSide,
      offsetParam,
      dateKey,
      eventId,
      eventAway,
      eventHome,
      historyLeague,
      cacheKey
    });
  }

  return { resolve, DEFAULT_SHARP_BOOKS };
}

module.exports = {
  createSharpOddsHistoryProvider,
  DEFAULT_SHARP_BOOKS,
  mapRowMarket
};
