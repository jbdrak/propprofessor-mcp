'use strict';

/**
 * Plan bounded pre-history hydration without performing any history calls.
 *
 * @param {object} options - Planning inputs and shortlist dependency
 * @returns {object} Hydration rows, recovery rows, and optional metadata
 */
function planPreHistoryHydration({
  rows,
  args,
  targetBook,
  canHydrate,
  hasExplicitGameFilter,
  buildPreHistoryShortlist,
  getGameBudget
}) {
  let hydrationRows = rows;
  let recoveryRows = [];
  let unresolvedRows = [];
  let preHistoryShortlistMeta = null;

  if (canHydrate && args.preHistoryShortlist === true && !hasExplicitGameFilter && rows.length > 0) {
    const shortlist = buildPreHistoryShortlist(rows, {
      gameBudget: getGameBudget(args),
      rowBudget: Number(args.preHistoryRowBudget) > 0 ? Number(args.preHistoryRowBudget) : undefined,
      preferredBook: targetBook || 'NoVigApp'
    });
    if (shortlist.rows.length < rows.length) {
      hydrationRows = shortlist.rows;
      const recoveryGameBudget = Number(args.preHistoryRecoveryGameBudget);
      if (Number.isFinite(recoveryGameBudget) && recoveryGameBudget > 0) {
        const recovery = buildPreHistoryShortlist(shortlist.skippedRows, {
          gameBudget: recoveryGameBudget,
          rowBudget:
            Number(args.preHistoryRecoveryRowBudget) > 0 ? Number(args.preHistoryRecoveryRowBudget) : undefined,
          preferredBook: targetBook || 'NoVigApp'
        });
        recoveryRows = recovery.rows;
      }
      const recoveredRows = new Set(recoveryRows);
      unresolvedRows = shortlist.skippedRows
        .filter((row) => !recoveredRows.has(row))
        .map((row) => ({
          ...row,
          official: false,
          incomplete: true,
          status: 'unresolved',
          lineHistoryAvailable: false,
          movementDisposition: 'unavailable',
          validationFailureReason: 'history not hydrated within bounded scan budget'
        }));
      preHistoryShortlistMeta = {
        enabled: true,
        truncated: true,
        totalRows: rows.length,
        shortlistedRows: shortlist.rows.length,
        skippedRowCount: unresolvedRows.length,
        gameBudget: shortlist.gameBudget,
        marketBucketCount: shortlist.bucketCount
      };
    }
  }

  return { hydrationRows, recoveryRows, unresolvedRows, preHistoryShortlistMeta };
}

module.exports = { planPreHistoryHydration };
