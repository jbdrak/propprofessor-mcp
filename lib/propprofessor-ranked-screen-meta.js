'use strict';

/**
 * Build metadata for a ranked-screen response.
 *
 * @param {object} options - Ranked-screen metadata inputs
 * @returns {object} Response metadata
 */
function buildResultMeta({
  targetBook,
  sharpBooks,
  lookbackHoursUsed,
  debug,
  freshness,
  warnings,
  compact,
  fields,
  args,
  ranked,
  compactFields,
  preHistoryShortlistMeta,
  preHistoryRecoveryMeta
}) {
  return {
    focusBook: targetBook || null,
    historySportsbooksRequested: sharpBooks,
    lookbackHoursUsed,
    debugEnabled: debug,
    freshnessFallbackUsed: freshness.freshnessFallbackUsed,
    timestampSources: freshness.timestampSources,
    degradedDataWarningCount: warnings.length,
    compact,
    fields: fields || (compact ? compactFields : null),
    markets_queried: args.markets ? args.markets : args.market ? [args.market] : ['Moneyline'],
    coverageGaps: ranked.coverageGaps || [],
    focusBookMissingRowCount: ranked.focusBookMissingRows?.length || 0,
    ...(preHistoryShortlistMeta ? { preHistoryShortlist: preHistoryShortlistMeta } : {}),
    ...(preHistoryRecoveryMeta ? { preHistoryRecovery: preHistoryRecoveryMeta } : {})
  };
}

module.exports = { buildResultMeta };
