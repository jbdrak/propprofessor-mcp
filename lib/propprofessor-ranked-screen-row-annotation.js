'use strict';

/**
 * Add canonical selection/play IDs and reconcile movement rationale on ranked rows.
 *
 * @param {object[]} rows - Ranked rows to annotate
 * @param {object} dependencies - Pure row-processing dependencies
 * @returns {object[]} The same rows array after annotation
 */
function annotateRankedRows(
  rows,
  { normalizeSelectionKey, buildCanonicalPlayId, computeMovementDisposition, buildRationale }
) {
  for (const row of rows) {
    row.selectionKey = normalizeSelectionKey(
      row.selection || row.participant || row.pick || row.homeTeam || row.awayTeam || ''
    );
    row.playId = buildCanonicalPlayId(row);
    const rankTimeDisposition = row.movementDisposition;
    row.movementDisposition = computeMovementDisposition(row);
    if (rankTimeDisposition && rankTimeDisposition !== row.movementDisposition) {
      row.rationale = buildRationale(row);
    }
  }
  return rows;
}

module.exports = { annotateRankedRows };
