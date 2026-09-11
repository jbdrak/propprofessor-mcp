'use strict';

/**
 * Recover and merge pre-history shortlist rows into the hydrated result set.
 *
 * @param {object} options - Recovery inputs and injected dependencies
 * @returns {Promise<object>} Hydrated rows and optional recovery metadata
 */
async function mergeRecoveredRows({
  hydratedRows,
  recoveryRows,
  skipHistory,
  hydrateOptions,
  args,
  hydrateFn,
  buildIdFn
}) {
  let allHydratedRows = hydratedRows;
  let preHistoryRecoveryMeta = null;
  // Recovery is coverage, not a fallback for an empty first pass.  A
  // supportive row in one bucket must not prevent skipped rows in other
  // buckets from receiving their reserved, bounded recovery slice.
  if (!skipHistory && recoveryRows.length > 0) {
    const recoveredRows = await hydrateFn(recoveryRows, hydrateOptions);
    const seen = new Set(hydratedRows.map((row) => buildIdFn(row)));
    allHydratedRows = hydratedRows.concat(recoveredRows.filter((row) => !seen.has(buildIdFn(row))));
    preHistoryRecoveryMeta = {
      enabled: true,
      recoveredGameCount: new Set(recoveryRows.map((row) => String(row.gameId || ''))).size,
      recoveredRowCount: recoveredRows.length,
      recoveryGameBudget: Number(args.preHistoryRecoveryGameBudget)
    };
  }
  return { allHydratedRows, preHistoryRecoveryMeta };
}

module.exports = { mergeRecoveredRows };
