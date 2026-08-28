'use strict';

/**
 * Count recommended plays by market across league buckets.
 *
 * @param {object[]} leagueEntries - Recommended league results
 * @returns {object} Market name to play-count map
 */
function computeMarketsBreakdown(leagueEntries) {
  const breakdown = {};
  for (const leagueData of leagueEntries || []) {
    for (const play of leagueData?.plays || []) {
      const market = play.market || 'unknown';
      breakdown[market] = (breakdown[market] || 0) + 1;
    }
  }
  return breakdown;
}

module.exports = { computeMarketsBreakdown };
