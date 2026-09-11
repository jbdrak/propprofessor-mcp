'use strict';

/**
 * Add canonical selection/play IDs and reconcile movement rationale on ranked rows.
 *
 * Movement disposition is recomputed here (not just copied from the ranker)
 * because sharpBookMovementConfirmed is set AFTER ranking by
 * propprofessor-sharp-plays-service.js. The ranker stamps disposition without
 * sharp confirmation; this pass upgrades insufficient -> supportive_bouncy
 * when sharp confirmation is present.
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
    if (row.movementDisposition === 'insufficient') {
      row.kaiCall = 'PASS';
      if ('confidenceTier' in row) row.confidenceTier = 'TIER 4';
      if ('confidenceTierLive' in row) row.confidenceTierLive = 'TIER 4';
      if ('displayTier' in row) row.displayTier = 'TIER 4';
    }
    if (rankTimeDisposition && rankTimeDisposition !== row.movementDisposition) {
      row.rationale = buildRationale(row);
    }
  }
  return rows;
}

module.exports = { annotateRankedRows };
