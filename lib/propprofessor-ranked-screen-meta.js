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
  unresolvedRows,
  preHistoryRecoveryMeta,
  preHydrationAltPruned,
  historyTimedOut,
  sourceRowCount
}) {
  const rankedRows = Array.isArray(ranked) ? ranked : [];
  const targetBookQuoteCount = rankedRows.filter(
    (row) => row?.targetBookOdds !== null && row?.targetBookOdds !== undefined
  ).length;
  const coverageGaps = ranked.coverageGaps || [];
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
    coverageGaps,
    focusBookMissingRowCount: ranked.focusBookMissingRows?.length || 0,
    targetBookCoverage: {
      targetBook: targetBook || null,
      sourceRowCount: Number.isFinite(Number(sourceRowCount)) ? Number(sourceRowCount) : null,
      rankedRowCount: rankedRows.length,
      targetBookQuoteCount,
      missingQuoteCount: coverageGaps.length
    },
    droppedAltLineCount: (ranked.droppedAltLineCount || 0) + (preHydrationAltPruned || 0),
    ...(preHydrationAltPruned ? { preHydrationAltPruned } : {}),
    ...(historyTimedOut ? { historyPartial: true } : {}),
    ...(preHistoryShortlistMeta ? { preHistoryShortlist: preHistoryShortlistMeta } : {}),
    ...(unresolvedRows?.length ? { unresolvedRows } : {}),
    ...(preHistoryRecoveryMeta ? { preHistoryRecovery: preHistoryRecoveryMeta } : {})
  };
}

module.exports = { buildResultMeta };
