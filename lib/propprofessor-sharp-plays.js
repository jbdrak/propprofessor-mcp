'use strict';

const { compactRow, DEFAULT_LEAGUES, parseGameStartMs } = require('./propprofessor-shared-utils');
const { getLocalTimezone, localDateKey } = require('./mcp-runtime-config');
const { getMarketsForSport } = require('./propprofessor-market-registry');

function normalizeBook(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const compact = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (compact === 'novig' || compact === 'novigapp' || compact === 'novigapps') return 'NoVigApp';
  if (compact === 'fliff') return 'Fliff';
  if (compact === 'rebet') return 'Rebet';
  return raw;
}

function sameBook(left, right) {
  return normalizeBook(left).toLowerCase() === normalizeBook(right).toLowerCase();
}

/**
 * Deduplicate and normalize an array of book names.
 * Filters out empty strings after normalization.
 * @param {string[]} books - Array of book name strings
 * @returns {string[]} Deduplicated, normalized array of book names
 */
function uniqueBooks(books) {
  return Array.from(new Set((Array.isArray(books) ? books : []).map(normalizeBook).filter(Boolean)));
}

function parseFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Normalize a value into an array of trimmed, non-empty strings.
 * Accepts an array, a comma-separated string, or falls back to a provided default.
 * @param {string|string[]} value - Value to normalize (array, CSV string, or falsy)
 * @param {string[]} [fallback=[]] - Optional fallback array if value is empty/falsy
 * @returns {string[]} Normalized array of trimmed, non-empty strings
 */
function normalizeList(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [...fallback];
}

function normalizeDateKey(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return localDateKey(date.getTime());
}

/**
 * Extract the start timestamp (epoch ms) from a row object by checking
 * multiple common field names (start, startTime, startsAt, eventStart, etc.).
 * @param {Object} [row={}] - Row object potentially containing a start time field
 * @returns {number|null} Start timestamp in epoch milliseconds, or null if unresolvable
 */
function parseRowStartMs(row = {}) {
  if (!row || typeof row !== 'object') return null;
  const candidate =
    row.start ?? row.startTime ?? row.startsAt ?? row.eventStart ?? row.eventStartTime ?? row.startMs ?? row.start_ms;
  return parseGameStartMs(candidate);
}

/**
 * Filter an array of UFC row objects by card window, event date, upcoming-only,
 * and max hours away criteria.
 * @param {Object[]} [rows=[]] - Array of UFC row objects
 * @param {Object} [options={}] - Filter options
 * @param {number} [options.nowMs] - Current timestamp override (defaults to Date.now())
 * @param {boolean} [options.upcomingOnly=true] - When true, exclude past events
 * @param {string} [options.cardWindow='all'] - Card window ('today', 'next', 'all')
 * @param {string} [options.eventDate] - Specific event date (YYYY-MM-DD)
 * @param {number} [options.maxHoursAway] - Maximum hours from now for filtering
 * @param {string} [options.timezone] - IANA timezone used for date filtering
 * @returns {Object[]} Filtered array of UFC row objects
 */
function filterUfcRowsForCard(rows = [], options = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const upcomingOnly = options.upcomingOnly !== undefined ? Boolean(options.upcomingOnly) : true;
  const cardWindow = String(options.cardWindow || 'all')
    .trim()
    .toLowerCase();
  const timezone = options.timezone || getLocalTimezone();
  const eventDate = normalizeDateKey(options.eventDate);
  const maxHoursAway = parseFiniteNumber(options.maxHoursAway);
  const todayKey = localDateKey(nowMs, timezone);
  const nextKey = localDateKey(nowMs + 24 * 60 * 60 * 1000, timezone);
  const strictDateWindow = Boolean(eventDate || cardWindow === 'today' || cardWindow === 'next');

  return sourceRows.filter((row) => {
    if (!row || typeof row !== 'object') return false;

    const startMs = parseRowStartMs(row);
    const startDateKey = startMs === null ? null : localDateKey(startMs, timezone);
    let dateMatches = true;

    if (strictDateWindow) {
      if (startMs === null || startDateKey === null) return false;
      if (eventDate) dateMatches = startDateKey === eventDate;
      else if (cardWindow === 'today') dateMatches = startDateKey === todayKey;
      else if (cardWindow === 'next') dateMatches = startDateKey === nextKey;
      if (!dateMatches) return false;
    }

    if (startMs !== null && upcomingOnly && startMs < nowMs) return false;

    if (startMs !== null && maxHoursAway !== null) {
      const deltaHours = (startMs - nowMs) / (60 * 60 * 1000);
      if (upcomingOnly) {
        if (deltaHours < 0 || deltaHours > maxHoursAway) return false;
      } else if (Math.abs(deltaHours) > maxHoursAway) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Resolve target books from arguments. Supports multiple input formats:
 * book name string, array of books, or CSV string. Falls back to ['NoVigApp'].
 * @param {Object} [args={}] - Arguments object
 * @param {string} [args.book] - Single book name
 * @param {string} [args.targetBook] - Single target book name
 * @param {string} [args.sportsbook] - Sportsbook name
 * @param {string[]} [args.books] - Array of book names
 * @param {string[]} [args.targetBooks] - Array of target book names
 * @param {string} [args.targetBooksCsv] - Comma-separated list of target book names
 * @param {string} [args.target_books_csv] - Underscore alias for targetBooksCsv
 * @param {string} [args.targetBookCsv] - Alternate camelCase alias
 * @param {string} [args.target_book_csv] - Alternate underscore alias
 * @returns {string[]} Resolved array of target book names, default ['NoVigApp']
 */
function resolveTargetBooks(args = {}) {
  const fallback =
    args.book || args.targetBook || args.sportsbook || (Array.isArray(args.books) && args.books[0])
      ? [args.book || args.targetBook || args.sportsbook || args.books[0]]
      : ['NoVigApp'];
  const raw = Array.isArray(args.targetBooks)
    ? args.targetBooks
    : Array.isArray(args.books)
      ? args.books
      : args.targetBooksCsv || args.target_books_csv || args.targetBookCsv || args.target_book_csv
        ? normalizeList(
            args.targetBooksCsv || args.target_books_csv || args.targetBookCsv || args.target_book_csv,
            fallback
          )
        : fallback;
  const books = uniqueBooks(normalizeList(raw, fallback).map(normalizeBook));
  return books.length ? books : ['NoVigApp'];
}

/**
 * Resolve a single target book from arguments.
 * Returns the first resolved book or 'NoVigApp' as fallback.
 * @param {Object} [args={}] - Arguments object (same fields as resolveTargetBooks)
 * @param {string} [args.book] - Single book name
 * @param {string} [args.targetBook] - Single target book name
 * @param {string} [args.sportsbook] - Sportsbook name
 * @param {string[]} [args.books] - Array of book names
 * @param {string[]} [args.targetBooks] - Array of target book names
 * @param {string} [args.targetBooksCsv] - Comma-separated list of target book names
 * @returns {string} Resolved single target book name, default 'NoVigApp'
 */
function resolveTargetBook(args = {}) {
  return resolveTargetBooks(args)[0] || 'NoVigApp';
}

/**
 * Resolve league list from arguments, defaulting to every league the PropProfessor backend supports: NBA, MLB, NFL, NHL, WNBA, NCAAB, NCAAF, Soccer, Tennis, UFC.
 * Normalizes and deduplicates the result.
 * @param {Object} [args={}] - Arguments object
 * @param {string[]} [args.leagues] - Array of league names
 * @param {string} [args.league] - Single league name (used as fallback array if leagues not given)
 * @returns {string[]} Deduplicated, normalized array of league names
 */
function resolveSharpPlayLeagues(args = {}) {
  return uniqueBooks(normalizeList(args.leagues, args.league ? [args.league] : Array.from(DEFAULT_LEAGUES)));
}

/**
 * Resolve the market list for a single league from arguments.
 * Explicit markets (args.markets / args.market) always win; otherwise the
 * league's registry defaults from getMarketsForSport(league, book) are used,
 * with the resolved target book supplying book-aware defaults (e.g. Soccer on
 * NoVigApp). Unknown leagues fall back to the generic
 * ['Moneyline', 'Spread', 'Total'] list.
 * @param {Object} [args={}] - Arguments object
 * @param {string[]} [args.markets] - Array of market names
 * @param {string} [args.market] - Single market name
 * @param {string} league - League name to resolve markets for
 * @returns {string[]} Deduplicated, normalized array of market names
 */
function resolveSharpPlayMarketsForLeague(args = {}, league = '') {
  if (args.markets !== undefined || args.market !== undefined) {
    return uniqueBooks(normalizeList(args.markets, args.market ? [args.market] : []));
  }
  const book = resolveTargetBook(/** @type {any} */ (args));
  return uniqueBooks(normalizeList(getMarketsForSport(league, book)));
}

/**
 * Resolve per-league market lists for a set of leagues.
 * Explicit markets (args.markets / args.market) are applied to every league;
 * otherwise each league resolves its own registry defaults. This is the
 * per-league fan-out used by sharp-play scans so e.g. Tennis scans Total
 * Games / Set Handicap while MLB scans Run Line / Total Runs.
 * @param {Object} [args={}] - Arguments object
 * @param {string[]} [leagues=[]] - League list (defaults to resolveSharpPlayLeagues(args))
 * @returns {Object<string, string[]>} Map of league name to market list
 */
function resolveSharpPlayMarketsByLeague(args = {}, leagues = []) {
  const leagueList = Array.isArray(leagues) && leagues.length ? leagues : resolveSharpPlayLeagues(args);
  /** @type {Object<string, string[]>} */
  const byLeague = {};
  for (const league of leagueList) {
    byLeague[league] = resolveSharpPlayMarketsForLeague(args, league);
  }
  return byLeague;
}

/**
 * Resolve market list from arguments, defaulting to per-league registry
 * defaults when a league context is present (args.league or a single-entry
 * args.leagues) and no explicit markets were requested. Falls back to the
 * generic ['Moneyline', 'Spread', 'Total'] list when there is no league
 * context. Normalizes and deduplicates the result.
 * @param {Object} [args={}] - Arguments object
 * @param {string[]} [args.markets] - Array of market names
 * @param {string} [args.market] - Single market name (used as fallback array if markets not given)
 * @param {string} [args.league] - Single league name used for per-league default resolution
 * @param {string[]} [args.leagues] - League list; per-league defaults apply when it has exactly one entry
 * @param {string} [league] - Optional explicit league name (takes precedence over args)
 * @returns {string[]} Deduplicated, normalized array of market names
 */
function resolveSharpPlayMarkets(args = {}, league) {
  const singleLeague =
    String(league || '').trim() ||
    String(args.league || '').trim() ||
    (Array.isArray(args.leagues) && args.leagues.length === 1 ? String(args.leagues[0]).trim() : '');
  return resolveSharpPlayMarketsForLeague(args, singleLeague || undefined);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isSupportedMovementLabel(row, { allowRecentOnly = false } = {}) {
  if (row?.movementLabel === 'supportive') return true;
  return Boolean(allowRecentOnly && row?.movementLabel === 'recent_supportive_only');
}

/**
 * Classify a single row as a sharp play bet candidate or pass.
 * Evaluates odds history, consensus book count, movement source, price band,
 * execution quality, and market availability to produce a verdict.
 * @param {Object} [row={}] - Row object containing odds, movement, and market data
 * @param {Object} [options={}] - Classification thresholds and constraints
 * @param {string} [options.book] - Target execution book name
 * @param {string} [options.targetBook] - Target execution book name (alias)
 * @param {boolean} [options.allowRecentOnly=false] - Allow recent_supportive_only as supportive movement
 * @param {number} [options.minConsensusBookCount=2] - Minimum consensus books required
 * @param {number} [options.minMarketBookCount=2] - Minimum market books for prop classification
 * @param {number} [options.minSupportBookCount=1] - Minimum same-side support books for props
 * @param {boolean} [options.requireIndependentSharpMovement=true] - Require movement from a non-target sharp book
 * @param {boolean} [options.requirePlayablePrice=true] - Require 'playable' or 'best' execution quality
 * @param {boolean} [options.requireBestPrice=false] - Require 'best' execution quality
 * @param {number} [options.minOdds] - Minimum American odds constraint
 * @param {number} [options.maxOdds] - Maximum American odds constraint
 * @param {number} [options.maxAgeMs] - Maximum row age in ms (stale detection)
 * @returns {{ verdict: string, passReasons: Array<string>, sharpPlayScore: number, support: { targetBook: string, odds: number|null, consensusBookCount: number, minConsensusBookCount: number, movementSourceBook: string|null, movementLabel: string|null, movementMode: string|null, movementIsSharpSourced: boolean, sourceIsTargetBook: boolean, priceInBand: boolean, stale: boolean } }} Classification result
 */
function classifySharpPlay(row = {}, options = {}) {
  const targetBook = resolveTargetBook(options);
  const allowRecentOnly = Boolean(options.allowRecentOnly);
  const minConsensusBookCount = Number.isFinite(Number(options.minConsensusBookCount))
    ? Number(options.minConsensusBookCount)
    : 2;
  const minMarketBookCount = Number.isFinite(Number(options.minMarketBookCount))
    ? Number(options.minMarketBookCount)
    : 2;
  const minSupportBookCount = Number.isFinite(Number(options.minSupportBookCount))
    ? Number(options.minSupportBookCount)
    : 1;
  const requireIndependentSharpMovement =
    options.requireIndependentSharpMovement !== undefined ? Boolean(options.requireIndependentSharpMovement) : true;
  const requirePlayablePrice =
    options.requirePlayablePrice !== undefined ? Boolean(options.requirePlayablePrice) : true;
  const requireBestPrice = Boolean(options.requireBestPrice);
  const minOdds = parseFiniteNumber(options.minOdds);
  const maxOdds = parseFiniteNumber(options.maxOdds);
  const odds = parseFiniteNumber(row.odds ?? row.currentOdds ?? row.price);
  const consensusBookCount = Number(row.consensusBookCount || 0);
  const movementSourceBook = normalizeBook(row.movementSourceBook);
  const movementLabelSupported = isSupportedMovementLabel(row, { allowRecentOnly });
  const sourceIsTargetBook = movementSourceBook ? sameBook(movementSourceBook, targetBook) : false;
  const independentBookOk = requireIndependentSharpMovement ? !sourceIsTargetBook : true;
  const sharpBookMovementConfirmed = Boolean(row.sharpBookMovementConfirmed);
  // comparison_book mode means the named/target book lacked its own usable
  // history and movement came from an independent sharp book — for sharp_plays
  // that is still sharp-sourced movement (execution quote stays on the target
  // book). Only reject modes that are genuinely not sharp movement
  // (mixed_books_fallback, none, insufficient_history).
  const sharpMovementMode = row.movementMode === 'same_book' || row.movementMode === 'comparison_book';
  const movementIsSharpSourced = Boolean(
    (row.lineHistoryUsable && sharpMovementMode && movementSourceBook && independentBookOk && movementLabelSupported) ||
    sharpBookMovementConfirmed
  );
  const priceInBand =
    Number.isFinite(odds) && (minOdds === null || odds >= minOdds) && (maxOdds === null || odds <= maxOdds);
  const isPropMarket = /player|pitcher/i.test(String(row.market || row.screenMarket || row.scanMarket || ''));
  const alternativeBookCountsOk =
    Number(row.marketBookCount || 0) >= minMarketBookCount && Number(row.supportBookCount || 0) >= minSupportBookCount;
  const marketOk = isPropMarket
    ? Number(row.marketBookCount || 0) >= minMarketBookCount
    : consensusBookCount >= minConsensusBookCount || alternativeBookCountsOk;
  const supportOk = isPropMarket
    ? Number(row.supportBookCount || 0) >= minSupportBookCount
    : consensusBookCount >= minConsensusBookCount || alternativeBookCountsOk;
  const effectiveExecutionQuality = String(row.executionQuality || '');
  const executionOk = requireBestPrice
    ? effectiveExecutionQuality === 'best'
    : requirePlayablePrice
      ? ['best', 'playable'].includes(effectiveExecutionQuality)
      : effectiveExecutionQuality !== 'bad';
  const consensusOk = consensusBookCount >= minConsensusBookCount;
  const stale =
    Boolean(row.stale || row.isStale) &&
    Number.isFinite(row.freshnessAgeMs) &&
    Number.isFinite(Number(options.maxAgeMs));

  // Fallback paths removed: consensusEdgeOnlyOk, consensusOnlyOk, clvOnlyOk
  // no longer produce Bet candidate. All Bet candidates require actual
  // supportive movement from an independent sharp book, confirmed either
  // through traditional movementIsSharpSourced or sharpBookMovementConfirmed.

  const passReasons = [];

  if (!Number.isFinite(odds)) passReasons.push('computed_field_missing_for_side');
  if (!priceInBand) passReasons.push('outside_playable_odds_band');
  if (stale) passReasons.push('stale_row');
  if (!consensusOk && !isPropMarket && !alternativeBookCountsOk)
    passReasons.push(`consensus_book_count_below_${minConsensusBookCount}`);
  if (!consensusOk && !isPropMarket && alternativeBookCountsOk) passReasons.push('consensus_metric_only_failure');
  if (isPropMarket && !marketOk) passReasons.push('insufficient_market_availability');
  if (isPropMarket && !supportOk) passReasons.push('insufficient_same_side_support');
  if (isPropMarket && !executionOk) passReasons.push('playable_price_failed');
  if (!consensusOk && isPropMarket && marketOk && supportOk && executionOk) {
    // pass silently — the new fields override consensusBookCount for props
  } else if (!consensusOk && isPropMarket) {
    passReasons.push(`consensus_book_count_below_${minConsensusBookCount}`);
  }
  if (!sharpBookMovementConfirmed) {
    if (!row.lineHistoryUsable) passReasons.push('no_usable_line_history');
    if (!movementLabelSupported) passReasons.push(`movement_not_supportive_${row.movementLabel || 'unknown'}`);
    if (requireIndependentSharpMovement && sourceIsTargetBook) passReasons.push('movement_source_is_target_book');
    if (row.movementMode && !sharpMovementMode) passReasons.push(`movement_mode_${row.movementMode}`);
    if (!movementSourceBook) passReasons.push('missing_movement_source_book');
  }

  const movementScore = movementIsSharpSourced ? 40 * clamp(Number(row.movementQualityScore || 0.75), 0.35, 1) : 0;
  const consensusScore = clamp(consensusBookCount / Math.max(minConsensusBookCount, 1), 0, 2) * 12.5;
  const edge = parseFiniteNumber(row.consensusEdge);
  const edgeScore = edge === null ? 0 : clamp(edge, -5, 5) * 2 + 10;
  const freshnessScore = stale ? 0 : 10;
  const marketScore = row.gatePassed || row.isActionable ? 5 : 0;
  const steamBonus = row.steamMove ? 15 : 0;
  const sharpPlayScore = Number(
    (movementScore + consensusScore + edgeScore + freshnessScore + marketScore + steamBonus).toFixed(3)
  );

  const propClassifyOk = movementIsSharpSourced && marketOk && supportOk && executionOk && priceInBand && !stale;
  const mainClassifyOk = movementIsSharpSourced && consensusOk && priceInBand && !stale;
  let verdict = 'Pass';
  if (isPropMarket && propClassifyOk) {
    verdict = 'Bet candidate';
  } else if (!isPropMarket && mainClassifyOk) {
    verdict = 'Bet candidate';
  }

  return {
    verdict,
    passReasons,
    sharpPlayScore,
    support: {
      targetBook,
      odds,
      consensusBookCount,
      minConsensusBookCount,
      movementSourceBook: movementSourceBook || null,
      movementLabel: row.movementLabel || null,
      movementMode: row.movementMode || null,
      movementIsSharpSourced,
      sourceIsTargetBook,
      priceInBand,
      stale
    }
  };
}

function shouldIncludeSharpPlayRow(row = {}, { strict = true, includePasses = false } = {}) {
  if (includePasses) return true;
  if (strict) return row.verdict === 'Bet candidate';
  return row.verdict === 'Bet candidate' || row.verdict === 'Lean';
}

function compareSharpPlayRows(left = {}, right = {}) {
  return (
    Number(right.sharpPlayScore || 0) - Number(left.sharpPlayScore || 0) ||
    Number(right.consensusBookCount || 0) - Number(left.consensusBookCount || 0) ||
    Number(right.screenScore || right.tennisScore || 0) - Number(left.screenScore || left.tennisScore || 0)
  );
}

function dedupeSharpPlayRows(rows = []) {
  const seenPlays = new Set();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const gameKey = String(row.gameId || row.game_id || row.game || row.matchup || '').trim();
    const executionBook = normalizeBook(
      row.executionBook || row.targetBook || row.book || row.sharpPlaySupport?.targetBook || ''
    ).trim();
    const marketKey = String(row.scanMarket || row.screenMarket || row.market || row.playType || '').trim();
    const pickKey = String(
      row.pick || row.selection || row.participant || row.selectionId || row.selection_id || ''
    ).trim();
    const lineKey = String(row.line ?? row.points ?? row.handicap ?? row.total ?? '').trim();
    const dedupeKey = [executionBook, gameKey, marketKey, pickKey, lineKey].join('|');
    if (!gameKey || !executionBook || !pickKey) return true;
    if (seenPlays.has(dedupeKey)) return false;
    seenPlays.add(dedupeKey);
    return true;
  });
}

function toNearMissPreview(row = {}) {
  return {
    pick: row.pick || row.selection || row.participant || null,
    odds: parseFiniteNumber(row.odds ?? row.currentOdds ?? row.price),
    movementSourceBook: normalizeBook(row.movementSourceBook) || null,
    movementLabel: row.movementLabel || null,
    steamMove: Boolean(row.steamMove),
    consensusEdge: Number.isFinite(Number(row.consensusEdge)) ? Number(row.consensusEdge) : null,
    consensusBookCount: Number.isFinite(Number(row.consensusBookCount)) ? Number(row.consensusBookCount) : 0,
    marketBookCount: Number.isFinite(Number(row.marketBookCount)) ? Number(row.marketBookCount) : 0,
    supportBookCount: Number.isFinite(Number(row.supportBookCount)) ? Number(row.supportBookCount) : 0,
    executionQuality: row.executionQuality || 'unknown',
    lineHistoryUsable: Boolean(row.lineHistoryUsable),
    passReasons: Array.isArray(row.passReasons) ? [...row.passReasons] : [],
    sharpPlayScore: Number.isFinite(Number(row.sharpPlayScore)) ? Number(row.sharpPlayScore) : 0
  };
}

/**
 * Classify and summarize an array of sharp play rows. Filters, sorts, deduplicates,
 * and returns classified entries, near-miss previews, and summary statistics.
 * @param {Object[]} [rows=[]] - Array of row objects to classify
 * @param {Object} [options={}] - Classification and filtering options
 * @param {boolean} [options.strict] - When true only return Bet candidates (default true)
 * @param {boolean} [options.includePasses] - Include pass rows (default false)
 * @param {number} [options.limit] - Max filtered rows to return (default 10)
 * @param {string} [options.book] - Target book name
 * @param {string} [options.targetBook] - Target book name (alias)
 * @param {boolean} [options.allowRecentOnly] - Allow recent_supportive_only movement
 * @param {number} [options.minConsensusBookCount] - Minimum consensus books required
 * @param {number} [options.minMarketBookCount] - Minimum market books for props
 * @param {number} [options.minSupportBookCount] - Minimum same-side support for props
 * @param {boolean} [options.requireIndependentSharpMovement] - Require independent sharp movement
 * @param {boolean} [options.requirePlayablePrice] - Require playable execution quality
 * @param {boolean} [options.requireBestPrice] - Require best execution quality
 * @param {number} [options.minOdds] - Minimum American odds
 * @param {number} [options.maxOdds] - Maximum American odds
 * @param {number} [options.maxAgeMs] - Maximum row age in ms
 * @returns {{ classifiedRows: Array<Object>, filteredRows: Array<Object>, classificationSummary: Object, topNearMisses: Array<Object> }} Summary result
 */
function summarizeSharpPlayRows(rows = [], options = {}) {
  const strict = options.strict !== undefined ? Boolean(options.strict) : true;
  const includePasses = Boolean(options.includePasses);
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Number(options.limit) : 10;

  const classifiedEntries = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === 'object')
    .map((row, index) => {
      // @ts-expect-error
      const classification = classifySharpPlay(row, { ...options, strict });
      return {
        index,
        row: {
          ...row,
          verdict: classification.verdict,
          passReasons: classification.passReasons,
          sharpPlayScore: classification.sharpPlayScore,
          sharpPlaySupport: classification.support
        }
      };
    });

  const verdictCounts = {};
  const passReasonCounts = {};
  for (const entry of classifiedEntries) {
    const verdict = String(entry.row.verdict || 'Pass');
    verdictCounts[verdict] = (verdictCounts[verdict] || 0) + 1;
    for (const reason of Array.isArray(entry.row.passReasons) ? entry.row.passReasons : []) {
      passReasonCounts[reason] = (passReasonCounts[reason] || 0) + 1;
    }
  }

  const filteredRows = dedupeSharpPlayRows(
    classifiedEntries
      .map((entry) => entry.row)
      .filter((row) => shouldIncludeSharpPlayRow(row, { strict, includePasses }))
      .sort(compareSharpPlayRows)
  ).slice(0, limit);

  const topNearMisses = classifiedEntries
    .filter((entry) => entry.row.verdict === 'Pass')
    .sort((left, right) => {
      const scoreDelta = Number(right.row.sharpPlayScore || 0) - Number(left.row.sharpPlayScore || 0);
      if (scoreDelta) return scoreDelta;
      const consensusDelta = Number(right.row.consensusBookCount || 0) - Number(left.row.consensusBookCount || 0);
      if (consensusDelta) return consensusDelta;
      const leftPick = String(left.row.pick || left.row.selection || left.row.participant || '')
        .trim()
        .toLowerCase();
      const rightPick = String(right.row.pick || right.row.selection || right.row.participant || '')
        .trim()
        .toLowerCase();
      if (leftPick !== rightPick) return leftPick.localeCompare(rightPick);
      return left.index - right.index;
    })
    .slice(0, 3)
    .map((entry) => toNearMissPreview(entry.row));

  return {
    classifiedRows: classifiedEntries.map((entry) => entry.row),
    filteredRows,
    classificationSummary: {
      totalRowsClassified: classifiedEntries.length,
      verdictCounts,
      passReasonCounts
    },
    topNearMisses
  };
}

/**
 * Convenience wrapper around summarizeSharpPlayRows that returns only filtered rows.
 * @param {Object[]} [rows=[]] - Array of ranked row objects
 * @param {Object} [options={}] - Options passed through to summarizeSharpPlayRows
 * @param {boolean} [options.strict] - When true only return Bet candidates (default true)
 * @param {boolean} [options.includePasses] - Include pass rows (default false)
 * @param {number} [options.limit] - Max plays to return (default 10)
 * @param {boolean} [options.allowRecentOnly] - Allow recent_supportive_only movement
 * @param {number} [options.minConsensusBookCount] - Minimum consensus books
 * @param {number} [options.minMarketBookCount] - Minimum market books for props
 * @param {number} [options.minSupportBookCount] - Minimum same-side support for props
 * @param {boolean} [options.requireIndependentSharpMovement] - Require independent sharp movement
 * @param {boolean} [options.requirePlayablePrice] - Require playable execution quality
 * @param {boolean} [options.requireBestPrice] - Require best execution quality
 * @param {number} [options.minOdds] - Minimum American odds
 * @param {number} [options.maxOdds] - Maximum American odds
 * @param {number} [options.maxAgeMs] - Maximum row age in ms
 * @returns {Object[]} Filtered array of sharp play rows
 */
function buildSharpPlaysFromRankedRows(rows = [], options = {}) {
  return summarizeSharpPlayRows(rows, options).filteredRows.map((r) => compactRow(r));
}

function getUfcShortlistVerdict(row = {}, options = /** @type {any} */ ({})) {
  const classification = classifySharpPlay(row, { ...options, strict: true });
  if (classification.verdict === 'Bet candidate') return 'Bet';

  const support = classification.support || {};
  const movementLabel = String(row.movementLabel || '')
    .trim()
    .toLowerCase();
  // @ts-expect-error
  const consensusOk = Number(row.consensusBookCount || 0) >= Number(support.minConsensusBookCount || 2);
  const rankedEnough = Boolean(
    row.gatePassed || row.isActionable || Number(row.screenScore || row.tennisScore || 0) > 0
  );
  const leanMovement = ['supportive', 'recent_supportive_only', 'insufficient_history', 'mixed'].includes(
    movementLabel
  );

  if (
    // @ts-expect-error
    !support.stale &&
    // @ts-expect-error
    support.priceInBand &&
    rankedEnough &&
    consensusOk &&
    leanMovement &&
    // @ts-expect-error
    !support.sourceIsTargetBook
  ) {
    return 'Lean';
  }
  return 'Pass';
}

function getUfcShortlistScore(row = {}) {
  const screenScore = Number(row.screenScore || row.tennisScore || 0);
  const consensusCount = Number(row.consensusBookCount || 0);
  const consensusEdge = parseFiniteNumber(row.consensusEdge) || 0;
  const qualityBonus =
    row.movementLabel === 'supportive'
      ? 3
      : row.movementLabel === 'recent_supportive_only'
        ? 2
        : row.movementLabel === 'insufficient_history'
          ? 1.5
          : row.movementLabel === 'mixed'
            ? 1
            : row.movementLabel === 'adverse'
              ? -2
              : 0;
  const stalePenalty = row.stale || row.isStale ? -5 : 0;
  return Number((screenScore + consensusCount * 0.75 + consensusEdge * 2 + qualityBonus + stalePenalty).toFixed(3));
}

/**
 * Build a UFC shortlist from rows, classifying each row and sorting by score.
 * Returns best bets, leans, passes, and summary metadata.
 * @param {Object[]} [rows=[]] - Array of UFC row objects
 * @param {Object} [options={}] - Shortlist options
 * @param {number} [options.limit] - Maximum bets to return (default 10)
 * @param {string} [options.cardWindow='all'] - Card window filter ('today', 'next', 'all')
 * @param {string} [options.eventDate] - Specific event date (YYYY-MM-DD)
 * @param {boolean} [options.upcomingOnly=true] - Only include upcoming fights
 * @param {number} [options.maxHoursAway] - Maximum hours from now for filtering
 * @param {boolean} [options.allowRecentOnly] - Allow recent_supportive_only movement label
 * @param {number} [options.minConsensusBookCount] - Minimum consensus books required
 * @param {number} [options.minMarketBookCount] - Minimum market books for props
 * @param {number} [options.minSupportBookCount] - Minimum same-side support for props
 * @param {boolean} [options.requireIndependentSharpMovement] - Require independent sharp book movement
 * @param {boolean} [options.requirePlayablePrice] - Require playable execution quality
 * @param {boolean} [options.requireBestPrice] - Require best execution quality
 * @param {number} [options.minOdds] - Minimum American odds
 * @param {number} [options.maxOdds] - Maximum American odds
 * @param {number} [options.maxAgeMs] - Maximum row age in ms
 * @returns {{ league: string, officialCount: number, leanCount: number, passCount: number, bestBets: Array<Object>, bestLooks: Array<Object>, bestPasses: Array<Object>, shortlistMeta: Object, summaryText: string }} UFC shortlist result
 */
function buildUfcShortlist(rows = [], options = {}) {
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Number(options.limit) : 10;
  const cardWindow = String(options.cardWindow || 'all')
    .trim()
    .toLowerCase();
  const eventDate = normalizeDateKey(options.eventDate);
  const upcomingOnly = options.upcomingOnly !== undefined ? Boolean(options.upcomingOnly) : true;
  const maxHoursAway = parseFiniteNumber(options.maxHoursAway);
  const filteredRows = filterUfcRowsForCard(rows, {
    ...options,
    cardWindow,
    eventDate,
    upcomingOnly,
    maxHoursAway
  });
  const shortlisted = filteredRows
    .filter((row) => row && typeof row === 'object')
    .filter(
      (row) =>
        String(row.scanLeague || row.league || '')
          .trim()
          .toUpperCase() === 'UFC'
    )
    .map((row) => {
      // @ts-expect-error
      const classification = classifySharpPlay(row, { ...options, strict: true });
      const shortlistVerdict = getUfcShortlistVerdict(row, options);
      return {
        ...row,
        verdict: row.verdict || classification.verdict,
        passReasons: Array.isArray(row.passReasons) ? row.passReasons : classification.passReasons,
        sharpPlayScore: Number.isFinite(Number(row.sharpPlayScore))
          ? Number(row.sharpPlayScore)
          : classification.sharpPlayScore,
        sharpPlaySupport: row.sharpPlaySupport || classification.support,
        shortlistVerdict,
        shortlistScore: getUfcShortlistScore(row),
        shortlistCardWindow: eventDate ? 'eventDate' : cardWindow,
        shortlistEventDate: eventDate,
        shortlistUpcomingOnly: upcomingOnly,
        shortlistMaxHoursAway: maxHoursAway,
        shortlistStartMs: parseRowStartMs(row)
      };
    })
    .sort(
      (left, right) =>
        Number(right.shortlistScore || 0) - Number(left.shortlistScore || 0) ||
        Number(right.screenScore || right.tennisScore || 0) - Number(left.screenScore || left.tennisScore || 0)
    )
    .slice(0, Math.max(limit * 2, limit));

  const bestBets = shortlisted.filter((row) => row.shortlistVerdict === 'Bet').slice(0, limit);
  const bestLooks = shortlisted.filter((row) => row.shortlistVerdict === 'Lean').slice(0, limit);
  const bestPasses = shortlisted.filter((row) => row.shortlistVerdict === 'Pass').slice(0, Math.min(limit, 5));
  const summaryText = `Best UFC looks: ${bestBets.length} official bet${bestBets.length === 1 ? '' : 's'}, ${bestLooks.length} lean${bestLooks.length === 1 ? '' : 's'}, ${bestPasses.length} pass${bestPasses.length === 1 ? '' : 'es'}.`;

  return {
    league: 'UFC',
    officialCount: bestBets.length,
    leanCount: bestLooks.length,
    passCount: bestPasses.length,
    bestBets,
    bestLooks,
    bestPasses,
    shortlistMeta: {
      totalCount: Array.isArray(rows) ? rows.length : 0,
      filteredCount: shortlisted.length,
      cardWindow: eventDate ? 'eventDate' : cardWindow,
      eventDate,
      upcomingOnly,
      maxHoursAway
    },
    summaryText
  };
}

module.exports = {
  buildSharpPlaysFromRankedRows,
  buildUfcShortlist,
  classifySharpPlay,
  filterUfcRowsForCard,
  normalizeList,
  parseRowStartMs,
  resolveSharpPlayLeagues,
  resolveSharpPlayMarkets,
  resolveSharpPlayMarketsByLeague,
  resolveSharpPlayMarketsForLeague,
  resolveTargetBook,
  resolveTargetBooks,
  summarizeSharpPlayRows,
  uniqueBooks
};
