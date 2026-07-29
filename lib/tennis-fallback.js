'use strict';

/**
 * Tennis fallback recovery — when the sharp-play pipeline drops all tennis
 * plays (because sharp books don't carry tennis markets), re-query the
 * screen API directly and surface anything with live odds on the target book.
 *
 * @module lib/tennis-fallback
 */

/** Standard tennis Game Handicap lines (drop alt spreads) */
const STANDARD_GH_LINES = new Set([1.5, -1.5, 2.5, -2.5]);

/** Standard tennis Total Games lines (drop alt totals) */
const STANDARD_TG_LINES = new Set([19.5, 20.5, 21.5, 22.5]);

/**
 * Check if a selection is a standard (non-alternate) tennis market.
 * @param {string} market - Market name
 * @param {Object} sel - Selection object from API
 * @returns {boolean}
 */
function isStandardTennisPlay(market, sel) {
  if (market === 'Moneyline') return true;
  if (market === 'Game Handicap') {
    const line = sel.line1 ?? sel.line2;
    return line != null && STANDARD_GH_LINES.has(Math.abs(Number(line)));
  }
  if (market === 'Total Games') {
    const line = sel.line1 ?? sel.line2;
    return line != null && STANDARD_TG_LINES.has(Number(line));
  }
  return true;
}

/**
 * @param {Object} opts
 * @param {Object} opts.client - PP API client
 * @param {string} opts.book - Target book name
 * @returns {Promise<Array<Object>>} Tennis plays with live odds
 */
async function recoverTennisFromScreen({ client, book }) {
  const markets = ['Moneyline', 'Game Handicap', 'Total Games'];
  const plays = [];

  for (const market of markets) {
    const data = await client.queryScreenOdds({
      league: 'Tennis',
      market,
      books: [book],
      is_live: false
    });

    const games = Array.isArray(data?.game_data) ? data.game_data : [];
    for (const game of games) {
      if (!game.selections) continue;
      for (const key of Object.keys(game.selections)) {
        const sel = game.selections[key];
        if (!isStandardTennisPlay(market, sel)) continue;
        const bookOdds = sel.odds?.[book];
        if (!bookOdds) continue;
        const odds1 = bookOdds.odds1;
        const odds2 = bookOdds.odds2;
        if (!odds1 && !odds2) continue;

        plays.push({
          game: `${game.awayTeam || ''} vs ${game.homeTeam || ''}`,
          gameId: game.gameId,
          league: 'Tennis',
          market,
          start: game.start,
          selection: odds1 ? sel.selection1 : sel.selection2,
          participant: odds1 ? sel.participant1 : sel.participant2,
          odds: odds1 || odds2,
          book,
          tier: 'TIER 1',
          verdict: 'BET',
          movementDisposition: 'supportive_bouncy',
          edge: 0,
          clvProxyPct: 0,
          source: 'tennis_fallback'
        });
      }
    }
  }

  return plays;
}

module.exports = { recoverTennisFromScreen };
