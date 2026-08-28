'use strict';

const TIER_ORDER = { 'TIER 1': 0, 'TIER 2': 1, 'TIER 3': 2, 'TIER 4': 3 };

/**
 * Deduplicate and rank recommended rows before validation.
 *
 * @param {object[]} rows - Candidate rows from each queried market
 * @param {string[]} targetTiers - Tiers allowed in the initial result
 * @param {number} limit - Maximum number of rows to return
 * @param {object} [options] - Dependency-injection seam for stable-tier lookup
 * @param {Function} [options.getStableTier] - Stable-tier fallback
 * @returns {object[]} Selected rows
 */
function selectRecommendedRows(rows, targetTiers, limit, { getStableTier = () => undefined } = {}) {
  const seen = new Map();
  for (const row of rows) {
    const key = `${row.gameId || ''}:${row.selection || ''}`;
    const existing = seen.get(key);
    if (!existing || Number(row.screenScore ?? 0) > Number(existing.screenScore ?? 0)) {
      seen.set(key, row);
    }
  }

  const eligible = Array.from(seen.values()).filter((row) => {
    const liveTier = row.confidenceTierLive || row.confidenceTier || getStableTier(row);
    return targetTiers.includes(liveTier);
  });

  return eligible
    .sort((a, b) => {
      const tierDiff = (TIER_ORDER[a.confidenceTier] ?? 9) - (TIER_ORDER[b.confidenceTier] ?? 9);
      if (tierDiff !== 0) return tierDiff;
      return (Number(b.screenScore ?? 0) || 0) - (Number(a.screenScore ?? 0) || 0);
    })
    .slice(0, limit);
}

module.exports = { selectRecommendedRows };
