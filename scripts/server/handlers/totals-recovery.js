'use strict';

/**
 * Recover standard totals when the sharp-play path returns no rows.
 * The caller still owns alternate-line filtering, validation, and verdicts.
 */
async function recoverStandardTotals({ runLeagueScreen, league, market, targetBooks, scanLimit, lookbackHours }) {
  if (typeof runLeagueScreen !== 'function') return null;
  const response = await runLeagueScreen(
    {
      books: targetBooks,
      market,
      scanLimit,
      limit: scanLimit,
      lookbackHours,
      is_live: false,
      cardWindow: 'all',
      includeAll: true,
      includePasses: true,
      playableOnly: false,
      evFirst: false,
      compact: false,
      includeResearch: false
    },
    league
  );
  const rows = Array.isArray(response?.result) ? response.result : [];
  const mainLines = rows.filter((row) => !row.altLineFiltered);
  return mainLines.length ? mainLines : null;
}

module.exports = { recoverStandardTotals };
