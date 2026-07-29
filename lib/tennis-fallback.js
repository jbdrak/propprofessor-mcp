'use strict';

/**
 * Tennis fallback recovery — when the sharp-play pipeline drops all tennis
 * plays (because sharp books don't carry tennis markets), re-query the
 * screen API directly and surface everything with live odds on the target book.
 *
 * @module lib/tennis-fallback
 */

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
