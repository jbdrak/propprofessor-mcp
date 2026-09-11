'use strict';

/**
 * Resolve the history hydration limit used by a CLI scan.
 *
 * Deep mode is deliberately limited to multi-league BET-only scans. The
 * aggregate history allocator still bounds total spend across active pairs.
 */
function resolveScanLimit({ onlyBets, singleLeagueScan, ncaafOnly, deepScan, limit }) {
  if (ncaafOnly) return 80;
  if (!onlyBets) return Math.min(limit, 50);
  if (singleLeagueScan || deepScan) return Math.min(limit, 100);
  return Math.min(limit, 24);
}

module.exports = { resolveScanLimit };
