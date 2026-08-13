'use strict';

/**
 * Play details handler: runGetPlayDetailsImpl.
 * Extracted from createMcpHandlers() in handlers.js.
 */

const { resolveMarkets } = require('./handler-utils');
const {
  buildRankedScreenResponse: buildRankedScreenResponseShared,
  buildCanonicalPlayId,
  normalizeBookList
} = require('../../../lib/propprofessor-mcp-ranked-screen');
const { getSharpBookComparisonSet, ALL_SCREEN_BOOKS, uniqueBooks } = require('../../../lib/propprofessor-sharp-books');
const { rankLeagueScreenRows } = require('../../../lib/screen-ranker');
const { normalizeTennisMarketQuery } = require('../../../lib/screen-tennis');
const { formatGetPlayDetailsMinimal, formatGetPlayDetailsStandard } = require('../../../lib/propprofessor-formatter');
const { parseGameIdIdentity, findBestMatchGameIdChanged } = require('../../../lib/selection-matcher');
const flashscoreTimes = require('../../../lib/flashscore-times');

/**
 * Normalize a selection label for exact (case-insensitive) matching.
 * Collapses whitespace and underscores; trims. Hyphens are left intact
 * because they are meaningful in some player/team names.
 * @param {*} value
 * @returns {string}
 */
function normalizeSelectionText(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')
    .trim();
}

/**
 * Strip the market prefix from a selectionId ("Total Games:Over_22.5" → "Over_22.5").
 * @param {*} id
 * @returns {string}
 */
function stripSelectionMarketPrefix(id) {
  const s = String(id == null ? '' : id);
  const idx = s.lastIndexOf(':');
  return idx === -1 ? s : s.slice(idx + 1);
}

/**
 * Collect normalized candidate labels for a row's OWN selection (top-level
 * fields plus the composed label+line).
 * @param {Object} row
 * @returns {string[]}
 */
function collectRowSelectionCandidates(row) {
  const out = [];
  const push = (v) => {
    const n = normalizeSelectionText(v);
    if (n) out.push(n);
  };
  push(row.selection);
  push(row.pick);
  push(row.participant);
  push(stripSelectionMarketPrefix(row.selectionId));
  // Composed "Over" + 22.5 → "over 22.5" (totals/spread rows split label/line).
  const label = row.selection || row.pick || row.participant || '';
  if (row.line != null && label) push(`${label} ${row.line}`);
  return out;
}

/**
 * True when the requested selection text matches the row's OWN selection
 * (top-level label/selectionId, or composed label+line). Nested selections
 * are NOT consulted here: every expanded row of a game shares the same
 * nested odds map, so consulting it would match every row of the game and
 * defeat "return only the matching top-level row".
 * @param {Object} row
 * @param {string} needle - Normalized requested selection text.
 * @returns {boolean}
 */
function rowMatchesSelectionFilter(row, needle) {
  return collectRowSelectionCandidates(row).includes(needle);
}

function materializeExactSelectionRows(rows, selectionFilter, requestedBook) {
  const needle = normalizeSelectionText(selectionFilter);
  const seenGames = new Set();
  const hasRequestedBookQuote = (row) => {
    if (String(row?.book || '').trim() === requestedBook && Number.isFinite(Number(row?.odds))) return true;
    if (Array.isArray(row?.sportsbookData)) {
      return row.sportsbookData.some(
        (entry) => String(entry?.book || '').trim() === requestedBook && Number.isFinite(Number(entry?.odds ?? entry?.noVigOdds))
      );
    }
    return Object.values(row?.selections || {}).some((nested) => {
      const quote = nested?.odds?.[requestedBook];
      return Number.isFinite(Number(quote?.odds1)) || Number.isFinite(Number(quote?.odds2));
    });
  };
  const exactRows = rows.filter((row) => {
    if (!rowMatchesSelectionFilter(row, needle) || !hasRequestedBookQuote(row) || seenGames.has(row.gameId)) return false;
    seenGames.add(row.gameId);
    return true;
  });
  if (exactRows.length) return exactRows;

  const materialized = [];
  seenGames.clear();
  for (const row of rows) {
    if (seenGames.has(row.gameId)) continue;
    const selections = row?.selections && typeof row.selections === 'object' ? row.selections : {};
    for (const [key, nested] of Object.entries(selections)) {
      if (!nested || typeof nested !== 'object') continue;
      const sides = [
        { index: 1, label: nested.selection1, id: nested.selection1Id, line: nested.line1 },
        { index: 2, label: nested.selection2, id: nested.selection2Id, line: nested.line2 }
      ];
      const side = sides.find((candidate) => {
        const candidates = [candidate.label, stripSelectionMarketPrefix(candidate.id)];
        if (candidate.line != null && candidate.label) candidates.push(`${candidate.label} ${candidate.line}`);
        return candidates.some((value) => normalizeSelectionText(value) === needle);
      });
      if (!side) continue;
      const oddsMap = nested.odds && typeof nested.odds === 'object' ? nested.odds : {};
      const bookOdds = oddsMap[requestedBook];
      const oddsKey = side.index === 1 ? 'odds1' : 'odds2';
      const liquidityKey = side.index === 1 ? 'liquidity1' : 'liquidity2';
      const odds = Number(bookOdds?.[oddsKey]);
      if (!bookOdds || !Number.isFinite(odds) || !side.id) continue;
      const selection = side.label;
      const materializedRow = {
        ...row,
        selection,
        participant: selection,
        selectionId: side.id,
        line: side.line,
        playId: buildCanonicalPlayId({ ...row, selection }),
        book: requestedBook,
        odds,
        currentOdds: odds,
        targetBookOdds: odds,
        liquidityUsd: Number.isFinite(Number(bookOdds[liquidityKey])) ? Number(bookOdds[liquidityKey]) : null,
        selections: { [key]: nested },
        defaultKey: key
      };
      materialized.push(materializedRow);
      seenGames.add(row.gameId);
      break;
    }
  }
  return materialized;
}

function finalizePlayDetailsResponse({ response, merged, args, gameIds, relaxedGameIdMatch, sharpBookSetDetail }) {
  response.result = merged;
  // Optional exact-selection filter. When args.selection is supplied
  // (e.g. derived from a full playId "<gameId>::Total Games::over 22.5"
  // or passed via --selection), return ONLY the top-level row(s) whose
  // own selection matches the requested text, preserving their nested
  // selections. This fixes the recheck bug where `pp game <gameId>
  // -m 'Total Games'` surfaced a top-ranked row for a DIFFERENT line
  // than the scan candidate even though the exact line existed in the
  // response's nested selections. Fail closed (matchedRows 0 + explicit
  // metadata) when nothing matches — never silently return a different
  // line than the caller asked to recheck.
  let matchedRowCount = merged.length;
  const selectionFilter = String(args.selection || '').trim();
  if (selectionFilter) {
    const needle = normalizeSelectionText(selectionFilter);
    const exactRows = merged.filter((row) => rowMatchesSelectionFilter(row, needle));
    let finalRows = exactRows;
    let selectionMatchedNested = false;
    if (!finalRows.length) {
      finalRows = [];
    }
    if (!finalRows.length) {
      response.result = [];
      response.resultMeta = {
        ...response.resultMeta,
        queryGameIds: gameIds,
        matchedRows: 0,
        selectionFilter,
        selectionNotFound: true,
        error: `No row matched selection "${selectionFilter}" for the requested game(s).`,
        errorCode: 'SELECTION_NOT_FOUND'
      };
      const verbosityEarly = String(args.verbosity || 'full').toLowerCase();
      if (verbosityEarly === 'minimal') return formatGetPlayDetailsMinimal(response);
      if (verbosityEarly === 'standard') return formatGetPlayDetailsStandard(response);
      return response;
    }
    response.result = finalRows;
    matchedRowCount = finalRows.length;
    response.resultMeta = {
      ...response.resultMeta,
      selectionFilter,
      ...(selectionMatchedNested ? { selectionMatchedNested: true } : {})
    };
  }

  for (const row of response.result) {
    const matrix = {};
    const sb = Array.isArray(row?.sportsbookData) ? row.sportsbookData : [];
    for (const entry of sb) {
      const book = String(entry?.book || '').trim();
      const odds = Number(entry?.odds ?? entry?.noVigOdds);
      if (book && Number.isFinite(odds)) matrix[book] = odds;
    }
    const selections = row?.selections && typeof row.selections === 'object' ? row.selections : {};
    for (const sel of Object.values(selections)) {
      const oddsMap = sel?.odds && typeof sel.odds === 'object' ? sel.odds : {};
      for (const [book, v] of Object.entries(oddsMap)) {
        if (!matrix[book] && Number.isFinite(Number(v?.odds1 ?? v))) {
          matrix[book] = Number(v.odds1 ?? v);
        }
      }
    }
    if (Object.keys(matrix).length) row.oddsMatrix = matrix;
  }

  for (const row of response.result) {
    if (row.sharpBookMovementConfirmed) continue;
    const label = String(row.movementLabel || '').toLowerCase();
    if (label === 'supportive') {
      const sb = Array.isArray(row?.sportsbookData) ? row.sportsbookData : [];
      const sharpBookNames = new Set(sharpBookSetDetail.map((b) => b.toLowerCase()));
      const hasSharpBookOdds = sb.some((entry) => sharpBookNames.has(String(entry?.book || '').toLowerCase()));
      if (hasSharpBookOdds) {
        row.sharpBookMovementConfirmed = true;
        const sourceEntry = sb.find((entry) => sharpBookNames.has(String(entry?.book || '').toLowerCase()));
        row.sharpBookMovementSource = sourceEntry?.book || sharpBookSetDetail[0] || null;
      }
    }
  }

  response.focusBookMissingRows = undefined;
  response.resultMeta = {
    ...response.resultMeta,
    queryGameIds: gameIds,
    matchedRows: matchedRowCount,
    ...(relaxedGameIdMatch ? { relaxedGameIdMatch: true } : {})
  };
  const verbosity = String(args.verbosity || 'full').toLowerCase();
  if (verbosity === 'minimal') return formatGetPlayDetailsMinimal(response);
  if (verbosity === 'standard') return formatGetPlayDetailsStandard(response);
  return response;
}

async function queryPlayDetailsResponse({
  client,
  args,
  gameIds,
  league,
  market,
  relaxedGameIdMatch,
  relaxedParticipants,
  augmentedBooksExcluded,
  focusBook,
  augmentedBooks
}) {
  let payload;
  try {
    payload = await client.queryScreenOddsBestComps({
      market,
      league,
      games: relaxedGameIdMatch ? [] : gameIds,
      participants: relaxedGameIdMatch
        ? relaxedParticipants
        : Array.isArray(args.participants)
          ? args.participants
          : [],
      books: augmentedBooksExcluded,
      is_live: Boolean(args.live || args.is_live)
    });
  } catch (err) {
    return {
      ok: true,
      result: [],
      resultMeta: {
        queryGameIds: gameIds,
        matchedRows: 0,
        error: err?.message || String(err),
        errorCode: 'SCREEN_QUERY_FAILED'
      }
    };
  }
  let currentPayload = payload;
  if (args.selection && focusBook) {
    try {
      currentPayload = await client.queryScreenOdds({
        market,
        league,
        games: relaxedGameIdMatch ? [] : gameIds,
        participants: relaxedGameIdMatch
          ? relaxedParticipants
          : Array.isArray(args.participants)
            ? args.participants
            : [],
        books: [focusBook],
        is_live: Boolean(args.live || args.is_live)
      });
    } catch {
      currentPayload = { rows: [] };
    }
  }
  let response;
  try {
    response = await buildRankedScreenResponseShared({
      client,
      payloads: [currentPayload],
      args: { ...args, compact: false, skipHistory: false, historySportsbooks: augmentedBooksExcluded },
      // Hydrate only the exact requested selection when this detail call is
      // bundled validation (quick_screen validateTop). The pre-hydration
      // filter must NOT apply to broad game-detail or mini-scan calls —
      // those query whole games and would starve out unrelated rows.
      ...(args.selection && args.exactSelectionOnly === true
        ? {
            preHydrationFilter: (row) =>
              rowMatchesSelectionFilter(row, normalizeSelectionText(String(args.selection || '')))
          }
        : {}),
      ...(args.selection
        ? {
            preRankingTransform: (rows) => materializeExactSelectionRows(rows, args.selection, focusBook)
          }
        : {}),
      league,
      focusBook,
      rankRows: (hydratedRows, options = {}) => {
        const debug = Boolean(/** @type {any} */ (options).debug);
        return rankLeagueScreenRows(hydratedRows, {
          league,
          market,
          limit: gameIds.length * 4,
          books: augmentedBooks,
          focusBook,
          includeAll: true,
          debug
        });
      }
    });
  } catch (err) {
    return {
      ok: true,
      result: [],
      resultMeta: {
        queryGameIds: gameIds,
        matchedRows: 0,
        error: err?.message || String(err),
        errorCode: 'RANK_PIPELINE_FAILED'
      }
    };
  }
  return response;
}

function getDefaultMarketsForLeague(league, _targetBooks) {
  return require('../../../lib/propprofessor-market-registry').getMarketsForSport(league, _targetBooks);
}

function createPlayDetailsHandlers(_client, _ctx) {
  async function runGetPlayDetailsImpl(client, args = {}) {
    const league = String(args.league || '').trim();
    const rawGameIds = Array.isArray(args.gameIds) ? args.gameIds : [];
    const gameIds = Array.from(new Set(rawGameIds.map((id) => String(id == null ? '' : id).trim()).filter(Boolean)));
    if (!league || !gameIds.length) {
      /** @type {Error & {code?: string, category?: string, status?: number}} */
      const error = new Error('league and gameIds are required.');
      error.code = 'MISSING_PARAMS';
      error.category = 'validation';
      error.status = 400;
      throw error;
    }
    if (!args.market) {
      const markets = getDefaultMarketsForLeague(league);
      const perMarket = await Promise.all(markets.map((m) => runGetPlayDetailsImpl(client, { ...args, market: m })));
      const combined = [];
      const metaList = [];
      let firstError = null;
      for (const r of perMarket) {
        if (r && Array.isArray(r.result)) combined.push(...r.result);
        if (r && r.resultMeta) {
          metaList.push(r.resultMeta);
          if (r.resultMeta.errorCode && !firstError) {
            firstError = { errorCode: r.resultMeta.errorCode, error: r.resultMeta.error };
          }
        }
      }
      const merged = {
        ok: true,
        result: combined,
        resultMeta: {
          queryGameIds: gameIds,
          matchedRows: combined.length,
          marketsQueried: markets,
          perMarket: metaList,
          ...(firstError || {})
        }
      };
      const verbosity = String(args.verbosity || 'full').toLowerCase();
      if (verbosity === 'minimal') return formatGetPlayDetailsMinimal(merged);
      if (verbosity === 'standard') return formatGetPlayDetailsStandard(merged);
      return merged;
    }
    const marketResolution = resolveMarkets(args, league);
    let market = marketResolution.single;
    const requestedBooks = normalizeBookList(args.books);
    if (league === 'Tennis') {
      const tennisMarkets = normalizeTennisMarketQuery(market);
      market = tennisMarkets[0] || market;
    }
    const focusBook = requestedBooks.length ? requestedBooks[0] : '';
    const sharpBookSetDetail = getSharpBookComparisonSet({ league, market });
    const leagueUpperDetail = (league || '').toUpperCase();
    const augmentedBooks = !['NBA', 'NFL', 'MLB'].includes(leagueUpperDetail)
      ? ALL_SCREEN_BOOKS
      : uniqueBooks([...requestedBooks, ...sharpBookSetDetail]);
    const excludeSet = new Set(normalizeBookList(args.excludeBooks).map((b) => b.toLowerCase()));
    const applyExcludes = (list) =>
      excludeSet.size ? list.filter((b) => !excludeSet.has(String(b).toLowerCase())) : list;
    const augmentedBooksExcluded = applyExcludes(augmentedBooks);

    // Relaxed gameId mode (internal, used by validate_play's timestamp-drift
    // fallback): the requested gameId embeds a Unix start timestamp and the same
    // matchup can surface under a NEW timestamp. Query any explicitly supplied
    // participants and return every row so the caller can reconcile by identity +
    // date. An empty participant list is valid for direct detail fallback.
    const relaxedGameIdMatch = args.relaxedGameIdMatch === true;
    const relaxedParticipants = Array.isArray(args.participants) ? args.participants : [];

    const response = await queryPlayDetailsResponse({
      client,
      args,
      gameIds,
      league,
      market,
      relaxedGameIdMatch,
      relaxedParticipants,
      augmentedBooksExcluded,
      focusBook,
      augmentedBooks
    });
    if (marketResolution.aliasesUsed.length) {
      response.resultMeta = {
        ...response.resultMeta,
        markets_alias_used: marketResolution.aliasesUsed
      };
    }

    const normalizeGameId = (id) =>
      String(id || '')
        .replace(/:\d{10,}$/, '')
        .trim();
    const normalizedRequested = gameIds.map(normalizeGameId);
    const gameIdSet = new Set(normalizedRequested);
    const safeResult = Array.isArray(response.result) ? response.result : [];
    const verifiedTennisDate =
      league.toLowerCase() === 'tennis' && safeResult.length
        ? flashscoreTimes.lookupMatchTime(safeResult[0].homeTeam, safeResult[0].awayTeam)?.date || ''
        : '';
    const exactGameIdMatches = (row) => {
      const rowId = String(row?.gameId || '').trim();
      if (!rowId) return false;
      if (args.playId && String(row?.playId || '').trim() !== String(args.playId).trim()) return false;
      if (gameIds.includes(rowId)) return true;
      // A timestamp-less backend row is safe to match against the requested
      // identity. A different embedded timestamp is not: it may be a stale
      // or re-keyed event and must go through drift reconciliation.
      const rowHasTimestamp = /:\d{10,}$/.test(rowId);
      const requestedHasTimestamp = gameIds.some((id) => /:\d{10,}$/.test(String(id)));
      if (verifiedTennisDate && row.start) {
        const rowDate = new Date(row.start).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
        if (rowDate !== verifiedTennisDate) return false;
      }
      return !rowHasTimestamp && requestedHasTimestamp && gameIdSet.has(normalizeGameId(rowId));
    };
    const filtered = relaxedGameIdMatch ? safeResult : safeResult.filter(exactGameIdMatches);

    const fallbackRows = Array.isArray(response.focusBookMissingRows) ? response.focusBookMissingRows : [];
    const merged = [...filtered];
    for (const fbRow of fallbackRows) {
      if (relaxedGameIdMatch || exactGameIdMatches(fbRow)) {
        merged.push({ ...fbRow, __focusBookMissing: true });
      }
    }

    // Direct `game` lookups need the same timestamp-drift recovery as
    // validate_play. The old path normalized timestamps before filtering,
    // which let stale rows win and prevented the fallback from running.
    if (
      !relaxedGameIdMatch &&
      args.disableTimestampDriftFallback !== true &&
      merged.length === 0 &&
      gameIds.length === 1
    ) {
      const identity = parseGameIdIdentity(gameIds[0]);
      if (identity) {
        const relaxedResponse = await queryPlayDetailsResponse({
          client,
          args,
          gameIds,
          league,
          market,
          relaxedGameIdMatch: true,
          relaxedParticipants: Array.isArray(args.participants) ? args.participants : [],
          augmentedBooksExcluded,
          focusBook,
          augmentedBooks
        });
        const relaxedRows = Array.isArray(relaxedResponse.result) ? relaxedResponse.result : [];
        let verifiedDateKey = '';
        if (league.toLowerCase() === 'tennis' && relaxedRows.length) {
          const first = relaxedRows[0];
          const schedule = flashscoreTimes.lookupMatchTime(first.homeTeam, first.awayTeam);
          verifiedDateKey = schedule?.date || '';
        }
        const fallbackRow = findBestMatchGameIdChanged(relaxedRows, {
          league,
          market,
          selection: args.selection || '',
          playId: args.playId || '',
          gameId: gameIds[0],
          requestedBook: focusBook,
          verifiedDateKey
        });
        if (fallbackRow) merged.push(fallbackRow);
      }
    }
    return finalizePlayDetailsResponse({
      response,
      merged,
      args,
      gameIds,
      relaxedGameIdMatch,
      sharpBookSetDetail
    });
  }

  return { runGetPlayDetailsImpl };
}

module.exports = { createPlayDetailsHandlers };
