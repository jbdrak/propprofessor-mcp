'use strict';

const { mapCandidateRow } = require('../../../lib/propprofessor-mcp-candidate-mapper');

/**
 * Map a recommended-bets row to the quick_screen field shape and overlay
 * matching player/game/market research.
 *
 * @param {Object} row
 * @param {Object[]} researchResults
 * @returns {Object}
 */
function mapRecommendedPlay(row, researchResults = []) {
  const playerName = String(row.selection || row.participant || '');
  const gameName = String(row.game || (row.awayTeam && row.homeTeam ? `${row.awayTeam} @ ${row.homeTeam}` : ''));
  const marketName = String(row._market || row.market || row.screenMarket || '').toLowerCase();
  const research = researchResults.find(
    (result) =>
      String(result.player || '').toLowerCase() === playerName.toLowerCase() &&
      String(result.game || '') === gameName &&
      String(result.market || '').toLowerCase() === marketName
  );

  const mapped = mapCandidateRow(row);
  if (row._market) mapped.market = row._market;
  if (research) {
    mapped.riskFlag = research.riskFlag;
    mapped.riskSummary = research.riskSummary;
    mapped.topTweet = research.topTweet;
  }
  return mapped;
}

module.exports = { mapRecommendedPlay };
