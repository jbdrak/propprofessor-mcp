'use strict';

const { extractScreenRows } = require('./screen-parser');
const { summarizeFreshness } = require('./screen-summary');
const { getLeagueRankingPreset } = require('./screen-ranker');
const { hydrateScreenRowsWithHistory } = require('./propprofessor-screen-history');
const { DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS, getOddsHistoryLookbackHours } = require('./mcp-runtime-config');
const { uniqueBooks } = require('./propprofessor-sharp-books');
const { compactRow: stripEmptyFields } = require('./propprofessor-shared-utils');
const { computeMovementDisposition } = require('./propprofessor-movement-disposition');

function normalizeSelectionKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function buildCanonicalPlayId(row = {}) {
  const gameId = String(row.gameId || '').trim();
  const market = String(row.market || '').trim();
  const selectionKey = normalizeSelectionKey(
    row.selection || row.participant || row.pick || row.homeTeam || row.awayTeam || ''
  );
  return [gameId, market, selectionKey].join('::');
}

function normalizeBookList(books) {
  return uniqueBooks(books);
}

function getMaxPerMarket(args = {}) {
  const value = Number(args.maxPerMarket);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function getLimit(args = {}) {
  const limit = Number(args.limit);
  return Number.isFinite(limit) && limit > 0 ? limit : 100;
}

function getIncludeAll(args = {}) {
  return args.includeAll !== undefined ? Boolean(args.includeAll) : true;
}

function getMaxAgeMs(args = {}) {
  const value = Number(args.maxAgeMs);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function getLookbackHours(args = {}) {
  const value = Number(args.lookbackHours);
  return Number.isFinite(value) && value > 0 ? value : getOddsHistoryLookbackHours();
}

function getRecentWindowHours(args = {}) {
  const value = Number(args.recentWindowHours);
  return Number.isFinite(value) && value > 0 ? value : getLookbackHours(args);
}

function getDebugFlag(value, defaultValue = true) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['false', '0', 'off', 'no'].includes(normalized)) return false;
  if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
  return defaultValue;
}

function getCompactFlag(args = {}) {
  if (args.compact === undefined || args.compact === null) return false;
  if (typeof args.compact === 'boolean') return args.compact;
  const normalized = String(args.compact).trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(normalized);
}

// Default field set used when compact=true
const COMPACT_FIELDS = [
  'id',
  'gameId',
  'playId',
  'selectionKey',
  'start',
  'league',
  'homeTeam',
  'awayTeam',
  'isLive',
  'market',
  'participant',
  'selection',
  'pick',
  'odds',
  'targetBookOdds',
  'currentOdds',
  'line',
  'edge',
  'clv',
  'clvProxyPct',
  'consensusBookCount',
  'executionQuality',
  'movementGrade',
  'movementDisposition',
  'riskScore',
  'kaiCall',
  'confidenceTier',
  'confidenceTierLive',
  'rationale',
  'screenScore',
  'book',
  'playType',
  'lineHistoryAvailable',
  'lineHistoryPoints',
  // Movement signals (small fields, high value for quick scanning)
  'steamMove',
  'steamBooks',
  'steamDirection',
  'consensusEdge',
  'multiWindowScore',
  'movementLabel',
  'movementSourceBook',
  'tierTrajectory'
];

/**
 * Filter a row to only the specified fields.
 * @param {Object} row - Full ranked row
 * @param {string[]} fields - Field names to keep
 * @returns {Object} Row with only the requested fields
 */
function filterRowFields(row = {}, fields = []) {
  if (!Array.isArray(fields) || !fields.length) return row;
  const result = {};
  for (const field of fields) {
    if (field in row) {
      result[field] = row[field];
    }
  }
  return result;
}

/**
 * Strip a ranked row down to essential fields only.
 * Removes: lineHistory, scoreBreakdown, selections (full odds map),
 *          movement debug payloads, and other verbose metadata.
 * Keeps: game, selection, odds, edge, tier, kai, start, risk, etc.
 */
function compactRow(row = {}) {
  return filterRowFields(row, COMPACT_FIELDS);
}

function compactResult(ranked = []) {
  return ranked.map(compactRow);
}

/**
 * Analyze ranked rows and emit warnings when the response is operating in degraded mode.
 * Prevents users from treating weak signals as strong ones.
 */
function buildDegradedDataWarnings(ranked, rows, freshness) {
  const warnings = [];
  if (!ranked || ranked.length === 0) return warnings;

  const totalRows = ranked.length;

  // Line history availability
  const rowsWithHistory = ranked.filter((r) => Array.isArray(r.lineHistory) && r.lineHistory.length > 0).length;
  const historyPct = Math.round((rowsWithHistory / totalRows) * 100);
  if (rowsWithHistory === 0) {
    warnings.push(
      `No line history available for any of ${totalRows} rows. Movement scores and CLV tracking are unavailable.`
    );
  } else if (historyPct < 50) {
    warnings.push(
      `Line history available for only ${rowsWithHistory}/${totalRows} rows (${historyPct}%). Movement analysis is limited.`
    );
  }

  // Consensus book coverage
  const rowsWithConsensus = ranked.filter((r) => Number(r.consensusBookCount || 0) >= 2).length;
  if (rowsWithConsensus === 0) {
    warnings.push(
      `No consensus data: all ${totalRows} rows show only single-book odds. Cross-book validation is unavailable.`
    );
  } else if (rowsWithConsensus < totalRows * 0.5) {
    warnings.push(
      `Consensus data sparse: only ${rowsWithConsensus}/${totalRows} rows have 2+ books posting. Most plays lack cross-book validation.`
    );
  }

  // Freshness fallback
  if (freshness && freshness.freshnessFallbackUsed) {
    warnings.push(`Data freshness is estimated (fallback mode). Actual timestamps were unavailable.`);
  }

  // Line-field backfill (v2.1.3): if any row's lineHistory had entries with
  // `line: null` and we backfilled from the row's current line, line-movement
  // detection is degraded — every entry shows the current line so we can't
  // see actual movement. Surface this honestly so users don't mistake the
  // degraded data for a clean signal.
  // The backfill code (`resolveHistoryForEntity`) only sets
  // `lineFieldMissingCount > 0` when `fallbackLine !== null`, which only
  // happens for non-moneyline rows (moneylines legitimately have line1=null
  // → fallbackLine=null → no backfill → count=0). So the count alone is
  // sufficient — we don't need a market-name check. The market check is
  // retained as defense-in-depth in case a future ranker change ever sets
  // the count on a moneyline row by accident.
  const backfilledRows = ranked.filter((r) => {
    if (!Array.isArray(r.lineHistory) || r.lineHistory.length === 0) return false;
    if (Number(r.lineFieldMissingCount || 0) === 0) return false;
    const market = String(r.market || r.screenMarket || r.playType || '')
      .trim()
      .toLowerCase();
    if (market === 'moneyline') return false;
    return true;
  });
  if (backfilledRows.length > 0) {
    const totalBackfilledEntries = backfilledRows.reduce((sum, r) => sum + Number(r.lineFieldMissingCount || 0), 0);
    warnings.push(
      `Line values missing from upstream history for ${backfilledRows.length}/${totalRows} non-moneyline rows (${totalBackfilledEntries} entries backfilled from current line). Line-movement detection is degraded for this slate.`
    );
  }

  // Movement scores all zero
  const rowsWithMovement = ranked.filter((r) => {
    const breakdown = r.scoreBreakdown;
    return breakdown && (Number(breakdown.movementScore || 0) > 0 || Number(breakdown.consensusScore || 0) > 0);
  }).length;
  if (rowsWithMovement === 0 && rowsWithHistory === 0) {
    warnings.push(
      `All ranking scores driven by sport score alone. Movement and consensus scores are zero due to missing history data.`
    );
  }

  return warnings;
}

async function buildRankedScreenResponse(opts = /** @type {any} */ ({})) {
  const { client, payloads = [], args = {}, league, rankRows, focusBook, resultMeta = {} } = opts;
  const compact = getCompactFlag(args);
  const targetBook = String(focusBook || '').trim();
  const focusPlays = targetBook ? [{ book: targetBook }] : [];
  const rows = payloads.flatMap((payload) => extractScreenRows(payload, focusPlays));
  const sharpBooks = normalizeBookList(args.historySportsbooks || args.books || (targetBook ? [targetBook] : []));
  const debug = getDebugFlag(args.debug, false);
  const lookbackHoursUsed = getLookbackHours(args);
  const recentWindowHours = getRecentWindowHours(args);

  // Use `fields` or `compact` to control output size — they only affect response
  // formatting, not data hydration. This ensures movement scores, CLV, and lineHistory
  // are available regardless of output mode.
  const skipHistory = args.skipHistory === true;
  const hydratedRows = skipHistory
    ? rows
    : await hydrateScreenRowsWithHistory(rows, {
        client,
        lookbackHours: lookbackHoursUsed,
        preferredBook: targetBook || null,
        sharpBooks,
        historySportsbooks: sharpBooks
      });

  const ranked = rankRows(hydratedRows, { debug, recentWindowHours });
  // After ranking, synthesize movementDisposition for every row so agents
  // can read one field instead of cross-referencing grade + direction + label.
  for (const row of ranked) {
    row.selectionKey = normalizeSelectionKey(
      row.selection || row.participant || row.pick || row.homeTeam || row.awayTeam || ''
    );
    row.playId = buildCanonicalPlayId(row);
    row.movementDisposition = computeMovementDisposition(row);
  }
  const freshness = summarizeFreshness(rows, Date.now(), { maxAgeMs: getMaxAgeMs(args) });
  const warnings = buildDegradedDataWarnings(ranked, rows, freshness);
  const fields =
    Array.isArray(args.fields) && args.fields.length ? args.fields.map((f) => String(f).trim()).filter(Boolean) : null;

  // Determine the result rows: fields > compact > full
  let resultRows;
  if (fields) {
    resultRows = ranked.map((row) => filterRowFields(row, fields));
  } else if (compact) {
    resultRows = compactResult(ranked);
  } else {
    resultRows = ranked;
  }
  // Propagate non-enumerable focusBookMissingRows from the ranker's array to
  // resultRows (map() returns a new array, dropping the property). The CLI's
  // --focus-book-only flag reads this from the top-level response to hide the
  // fallback rows.
  if (ranked.focusBookMissingRows) {
    Object.defineProperty(resultRows, 'focusBookMissingRows', {
      value: ranked.focusBookMissingRows,
      enumerable: false,
      writable: false,
      configurable: false
    });
  }

  // Build the base response
  const includeList =
    Array.isArray(args.include) && args.include.length
      ? args.include.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
      : null;

  const baseResponse = {
    ok: true,
    result: resultRows,
    freshness,
    ...(warnings.length > 0 ? { warnings } : {}),
    // focusBookMissingRows: ranked rows that fell back to a different book
    // because the focus book had no price. Surfaced as a top-level field
    // (not inside result[]) so callers filtering result by tier ("all TIER 1
    // bets on NoVigApp") get only rows executable on the focus book. Use
    // --focus-book-only to hide this field.
    ...(ranked.focusBookMissingRows ? { focusBookMissingRows: ranked.focusBookMissingRows } : {}),
    resultMeta: {
      focusBook: targetBook || null,
      historySportsbooksRequested: sharpBooks,
      lookbackHoursUsed,
      debugEnabled: debug,
      freshnessFallbackUsed: freshness.freshnessFallbackUsed,
      timestampSources: freshness.timestampSources,
      degradedDataWarningCount: warnings.length,
      compact,
      fields: fields || (compact ? COMPACT_FIELDS : null),
      markets_queried: args.markets ? args.markets : args.market ? [args.market] : ['Moneyline'],
      coverageGaps: ranked.coverageGaps || [],
      focusBookMissingRowCount: ranked.focusBookMissingRows?.length || 0
    },
    ...resultMeta,
    ...(league ? { league } : {})
  };

  // When include is specified, filter top-level keys
  if (includeList) {
    const allowed = new Set(['ok', 'result', ...includeList]);
    const filtered = {};
    for (const key of Object.keys(baseResponse)) {
      if (allowed.has(key)) {
        filtered[key] = baseResponse[key];
      }
    }
    // @ts-expect-error
    filtered.result = Array.isArray(filtered.result) ? filtered.result.map(stripEmptyFields) : filtered.result;
    return filtered;
  }

  baseResponse.result = Array.isArray(baseResponse.result)
    ? baseResponse.result.map(stripEmptyFields)
    : baseResponse.result;
  return baseResponse;
}

module.exports = {
  buildRankedScreenResponse,
  buildDegradedDataWarnings,
  getIncludeAll,
  getLeagueRankingPreset,
  getLimit,
  getMaxPerMarket,
  getLookbackHours,
  getRecentWindowHours,
  getMaxAgeMs,
  normalizeBookList,
  normalizeSelectionKey,
  buildCanonicalPlayId,
  getDebugFlag,
  getCompactFlag,
  compactRow,
  compactResult,
  filterRowFields,
  COMPACT_FIELDS,
  DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS
};
