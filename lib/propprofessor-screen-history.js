'use strict';

const { normalizeSelectionId } = require('./propprofessor-api');
const {
  resolveHistoryForEntity,
  normalizeHistoryPayload,
  getOddsHistoryStartTimestamp
} = require('./propprofessor-history');
const { getOddsHistoryLookbackHours } = require('./mcp-runtime-config');

// Bounded history hydration: the previous default of 6 concurrent
// /odds_history_new calls could pile onto a throttled upstream (each 429 is
// retried with backoff, compounding the burst). 3 keeps screens fast while
// staying well under the concurrency that trips upstream rate limits.
const DEFAULT_HISTORY_CONCURRENCY = 3;

/**
 * Extract the numeric line value from a pick string and classify the pick
 * shape. Supports totals ("Over 9.5", "Under 8") and spreads ("Lakers -3.5",
 * "Athletics +1.5"). Returns null for moneyline-style picks that don't carry
 * a line value.
 *
 * @param {string|null|undefined} pick - The pick text (e.g. "Over 9.5").
 * @returns {{side: string, line: number, format: 'total'|'spread'}|null}
 *   Parsed structure, or null when the pick has no recognizable line value.
 */
function extractLineFromPick(pick) {
  if (!pick) return null;
  const str = String(pick).trim();
  if (!str) return null;
  // Total: "Over 9.5" / "Under 9.5" — number has no sign.
  const totalMatch = str.match(/^(Over|Under)\s+(\d+(?:\.\d+)?)$/i);
  if (totalMatch) {
    return { side: totalMatch[1].toLowerCase(), line: parseFloat(totalMatch[2]), format: 'total' };
  }
  // Spread: "Team -3.5" / "Team +3.5" — number is signed. Cap at 50 to
  // avoid misclassifying moneyline values like "+200".
  const spreadMatch = str.match(/^(.+?)\s+([+-]\d+(?:\.\d+)?)$/);
  if (spreadMatch) {
    const value = parseFloat(spreadMatch[2]);
    if (Number.isFinite(value) && Math.abs(value) <= 50) {
      return { side: spreadMatch[1].trim(), line: value, format: 'spread' };
    }
  }
  return null;
}

/**
 * Generate adjacent line values to try as a fallback when the exact line
 * has no history. Markets typically post lines in 0.5 increments, so ±0.5
 * is the right neighborhood to search.
 *
 * @param {number} line - The original line value.
 * @returns {number[]} Adjacent line values (never empty; 0.5 / -0.5 around input).
 */
function generateLineVariants(line) {
  if (!Number.isFinite(line)) return [];
  return [line - 0.5, line + 0.5];
}

/**
 * Rebuild a pick string with a new line value, preserving the original
 * shape (side prefix for totals, signed suffix for spreads).
 *
 * @param {{side: string, line: number, format: 'total'|'spread'}} parsed
 *   Parsed pick from `extractLineFromPick`.
 * @param {number} newLine - The new line value to substitute in.
 * @returns {string|null} The rebuilt pick string, or null when the parsed
 *   shape is unsupported.
 */
function rebuildPickWithLine(parsed, newLine) {
  if (!parsed || !Number.isFinite(newLine)) return null;
  const formatted = String(newLine);
  if (parsed.format === 'total') {
    const side = parsed.side.charAt(0).toUpperCase() + parsed.side.slice(1).toLowerCase();
    return `${side} ${formatted}`;
  }
  if (parsed.format === 'spread') {
    const sign = newLine > 0 ? '+' : '';
    return `${parsed.side} ${sign}${formatted}`;
  }
  return null;
}

function buildRowCacheKey(row = {}) {
  const gameId = row.gameId ?? row.game_id ?? row.gameID ?? row.game?.id ?? null;
  const selectionId = normalizeSelectionId(row.selectionId ?? row.selection_id ?? row.selectionID ?? row.selection);
  if (gameId && selectionId) {
    return `${gameId}::${selectionId}`;
  }
  const book = String(row.book || row.sportsbook || '').trim();
  const pick = String(row.pick || row.selection || row.participant || '').trim();
  const game = String(row.game || row.matchup || '').trim();
  const odds = String(row.odds ?? row.currentOdds ?? '').trim();
  return `${book}::${pick}::${game}::${odds}`;
}

/**
 * Hydrate screen rows with odds history data. For each row, resolves line history
 * from the odds history API (or preserves inline lineHistory if already present).
 * Rows are processed concurrently with a configurable concurrency limit.
 *
 * @param {Array<object>} rows - Array of screen row objects to hydrate with history.
 * @param {object}        [options] - Optional configuration object.
 * @param {object}        options.client - API client that exposes a queryOddsHistory method.
 * @param {number}        [options.lookbackHours] - Hours to look back when fetching odds history.
 *                                                   Falls back to getOddsHistoryLookbackHours().
 * @param {string[]}      [options.historySportsbooks=[]] - Sportsbook names to include in history queries.
 * @param {string|null}   [options.preferredBook=null] - Preferred execution book name.
 * @param {string[]}      [options.sharpBooks=[]] - Sharp book names used for movement comparison.
 * @param {number}        [options.concurrency=3] - Max number of concurrent history resolutions.
 * @returns {Promise<Array<object>>} The input rows hydrated with lineHistory, lineHistoryAvailable,
 *                                    lineHistorySource, lineHistoryLookbackHours, and related
 *                                    metadata fields (normalizedSelectionId, historyGameId,
 *                                    historyMatchedBy, historyMatchKey, historySportsbooksRequested).
 */
async function hydrateScreenRowsWithHistory(
  rows,
  opts = /** @type {{ client?: any, lookbackHours?: number, historySportsbooks?: string[], preferredBook?: string, sharpBooks?: string[], concurrency?: number }} */ ({})
) {
  const {
    client,
    lookbackHours = getOddsHistoryLookbackHours(),
    historySportsbooks = [],
    preferredBook = null,
    sharpBooks = [],
    concurrency = DEFAULT_HISTORY_CONCURRENCY
  } = opts;
  const sourceRows = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  if (!sourceRows.length || !client || typeof client.queryOddsHistory !== 'function') {
    return sourceRows;
  }

  const cache = new Map();

  async function resolveRow(row) {
    if (Array.isArray(row.lineHistory) && row.lineHistory.length >= 2) {
      return {
        ...row,
        lineHistoryAvailable: true,
        lineHistorySource: row.lineHistorySource || 'screen_payload',
        lineHistoryLookbackHours: Number.isFinite(Number(row.lineHistoryLookbackHours))
          ? Number(row.lineHistoryLookbackHours)
          : lookbackHours,
        normalizedSelectionId: row.normalizedSelectionId || null,
        historyGameId: row.historyGameId || null,
        historyMatchedBy: row.historyMatchedBy || null,
        historyMatchKey: row.historyMatchKey || null
      };
    }

    const cacheKey = buildRowCacheKey(row);
    if (!cache.has(cacheKey)) {
      cache.set(
        cacheKey,
        resolveHistoryWithLineFallback({
          client,
          target: row,
          rows: sourceRows,
          lookbackHours,
          historySportsbooks,
          preferredBook,
          sharpBooks,
          queryHistoryFn: (params) => client.queryOddsHistory(params)
        })
      );
    }

    const resolved = await cache.get(cacheKey);
    if (resolved?.lineHistoryAvailable) {
      return {
        ...row,
        lineHistory: resolved.lineHistory,
        lineHistoryAvailable: true,
        lineHistorySource: resolved.lineHistorySource || 'odds_history',
        lineHistoryLookbackHours: lookbackHours,
        normalizedSelectionId: resolved.normalizedSelectionId || null,
        historyGameId: resolved.historyGameId || null,
        historyMatchedBy: resolved.historyMatchedBy || null,
        historyMatchKey: resolved.historyMatchKey || null,
        historySportsbooksRequested: Array.isArray(resolved.historySportsbooksRequested)
          ? resolved.historySportsbooksRequested
          : [],
        lineVariantUsed: resolved.lineVariantUsed || undefined,
        // v2.1.3: surface the backfill count so buildDegradedDataWarnings
        // can warn users when line values were missing from upstream.
        lineFieldMissingCount: Number.isFinite(resolved.lineFieldMissingCount) ? resolved.lineFieldMissingCount : 0
      };
    }

    return {
      ...row,
      lineHistory: Array.isArray(row.lineHistory) ? row.lineHistory : [],
      lineHistoryAvailable: false,
      lineHistorySource: row.lineHistorySource || null,
      lineHistoryLookbackHours: Number.isFinite(Number(row.lineHistoryLookbackHours))
        ? Number(row.lineHistoryLookbackHours)
        : lookbackHours,
      // Fail-soft markers from the resolver: surface the degraded/error
      // metadata so downstream can distinguish a throttled or circuit-open
      // resolution from a plain missing-history row.
      ...(resolved && typeof resolved === 'object' && 'historyError' in resolved
        ? { historyError: resolved.historyError }
        : {}),
      ...(resolved && typeof resolved === 'object' && 'historyErrorCode' in resolved
        ? { historyErrorCode: resolved.historyErrorCode }
        : {}),
      ...(resolved && typeof resolved === 'object' && 'historyErrorStatus' in resolved
        ? { historyErrorStatus: resolved.historyErrorStatus }
        : {})
    };
  }

  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const results = new Array(sourceRows.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < sourceRows.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await resolveRow(sourceRows[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, sourceRows.length) }, () => runWorker()));
  return results;
}

module.exports = {
  hydrateScreenRowsWithHistory,
  extractLineFromPick,
  generateLineVariants,
  rebuildPickWithLine,
  findRowForLineVariant
};

/**
 * Detect typed throttle/circuit-breaker errors that must fail soft instead of
 * triggering line-variant amplification. Matches the error contract produced
 * by lib/propprofessor-api.js (tagged HTTP errors carrying a numeric `status`)
 * and lib/propprofessor-circuit-breaker.js (CircuitBreakerOpenError with
 * `name`/`code`).
 *
 * @param {*} error - Error thrown by the history query path.
 * @returns {boolean} True for HTTP 429 throttle errors and circuit-open errors.
 */
function isThrottleOrCircuitError(error) {
  if (!error || typeof error !== 'object') return false;
  return error.status === 429 || error.name === 'CircuitBreakerOpenError' || error.code === 'CIRCUIT_BREAKER_OPEN';
}

/**
 * Resolve odds history for a single entity, with a cross-line fallback.
 *
 * Different sportsbooks post different key lines for the same conceptual
 * bet — Pinnacle may post "Over 9.5" while BetOnline posts "Over 9" with
 * a different selectionId. The exact line query returns no history when
 * the requested selectionId only exists in a subset of books. This wrapper
 * falls back to adjacent line variants (±0.5) so the cross-book history is
 * bridged through the rows that DO have a matching selectionId.
 *
 * Throttle/circuit failures are exempt: when the exact query fails with a
 * typed HTTP 429 or circuit-breaker-open error, the variant fallback is
 * skipped so a rate-limited or tripped upstream is not amplified into a
 * cascade of extra requests. The degraded result still carries the typed
 * error metadata (historyError / historyErrorCode / historyErrorStatus).
 *
 * @param {Object} options - Same shape as `resolveHistoryForEntity`.
 * @returns {Promise<Object>} Resolved history result, augmented with
 *   `lineVariantUsed` and `historyMatchedBy` suffixed with `_line_variant`
 *   when a fallback variant supplied the data.
 */
async function resolveHistoryWithLineFallback({
  client,
  target,
  rows,
  queryHistoryFn,
  lookbackHours,
  historySportsbooks,
  preferredBook,
  sharpBooks
}) {
  const exact = await resolveHistoryForEntity({
    client,
    target,
    rows,
    queryHistoryFn,
    lookbackHours,
    historySportsbooks,
    preferredBook,
    sharpBooks
  }).catch((error) => {
    process.stderr.write(`[propprofessor-mcp] History resolution failed: ${error?.message || error}\n`);
    const degraded = {
      lineHistory: [],
      lineHistoryAvailable: false,
      lineHistorySource: null,
      historyError: error?.message || String(error)
    };
    if (isThrottleOrCircuitError(error)) {
      // Preserve the minimum typed metadata so downstream consumers can
      // distinguish a throttled/circuit-open resolution from a plain
      // missing-history result.
      degraded.historyErrorCode = error?.code || null;
      degraded.historyErrorStatus = typeof error?.status === 'number' ? error.status : null;
    }
    return degraded;
  });
  if (exact.lineHistoryAvailable) return exact;

  // Fail soft on typed throttle/circuit failures: the upstream is
  // rate-limited or the breaker is open, so adjacent line variants would
  // pile more requests onto the outage. Return the degraded result as-is.
  if (exact && typeof exact === 'object' && ('historyErrorCode' in exact || 'historyErrorStatus' in exact)) {
    return exact;
  }

  // Try adjacent line variants. Skip when the pick has no numeric line
  // (moneyline) or when no variants are generated. Variants bypass the
  // strict matcher (which requires same selectionId or same book) and use
  // a direct row lookup by gameId+pick, so cross-line/cross-book history
  // from a different selectionId can be bridged.
  const pickText = target && (target.pick || target.selection || target.participant);
  const parsed = extractLineFromPick(pickText);
  if (!parsed) return exact;
  const targetGameId = (target && (target.gameId ?? target.game_id ?? target.gameID ?? target.game?.id)) || null;
  if (!targetGameId) return exact;
  const variants = generateLineVariants(parsed.line);
  for (const newLine of variants) {
    const variantPick = rebuildPickWithLine(parsed, newLine);
    if (!variantPick || variantPick === pickText) continue;
    const variantRow = findRowForLineVariant(rows, targetGameId, variantPick);
    if (!variantRow) continue;
    const variantSelectionId = normalizeSelectionId(
      variantRow.selectionId ?? variantRow.selection_id ?? variantRow.selectionID ?? variantRow.selection
    );
    const variantGameId = variantRow.gameId ?? variantRow.game_id ?? variantRow.gameID ?? variantRow.game?.id ?? null;
    if (!variantGameId || !variantSelectionId) continue;
    const startTimestamp = getOddsHistoryStartTimestamp({ lookbackHours });
    const requestedSportsbooks = Array.from(
      new Set(
        [
          ...(Array.isArray(historySportsbooks) ? historySportsbooks : []),
          preferredBook,
          ...(Array.isArray(sharpBooks) ? sharpBooks : [])
        ]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      )
    );
    let variantPayload;
    try {
      variantPayload = await queryHistoryFn({
        gameId: variantGameId,
        selectionId: variantSelectionId,
        sportsbooks: requestedSportsbooks,
        startTimestamp
      });
    } catch {
      continue;
    }
    const variantHistory = normalizeHistoryPayload(variantPayload);
    if (variantHistory.length >= 2) {
      return {
        lineHistory: variantHistory,
        lineHistoryAvailable: true,
        lineHistorySource: 'odds_history',
        normalizedSelectionId: variantSelectionId,
        historyGameId: variantGameId,
        historyMatchedBy: 'line_variant',
        lineVariantUsed: variantPick,
        historySportsbooksRequested: requestedSportsbooks
      };
    }
  }
  return exact;
}

/**
 * Find a screen row whose gameId + pick/selection matches the requested
 * variant. Used by the cross-line fallback to bridge to a different
 * book/selectionId without going through the strict matcher.
 *
 * @param {Array} rows - Screen payload rows.
 * @param {string} gameId - Target gameId to match.
 * @param {string} pick - Variant pick text (e.g. "Over 9").
 * @returns {Object|null} The first matching row, or null.
 */
function findRowForLineVariant(rows, gameId, pick) {
  if (!Array.isArray(rows) || !gameId || !pick) return null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rowGameId = row.gameId ?? row.game_id ?? row.gameID ?? row.game?.id;
    if (rowGameId !== gameId) continue;
    const rowPick = row.pick ?? row.selection ?? row.participant;
    if (rowPick === pick) return row;
  }
  return null;
}
