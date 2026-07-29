'use strict';

/**
 * Tennis fallback recovery — when the sharp-play pipeline drops all tennis
 * plays (because sharp books don't carry tennis markets), re-query the
 * screen API directly and compute real CLV/movement from NoVigApp price history.
 *
 * @module lib/tennis-fallback
 */

const LOOKBACK_HOURS = 24;

/**
 * Compute CLV (Closing Line Value) from odds history entries.
 * Returns the percentage change from earliest to latest odds.
 * Positive CLV = odds moved in favor of this selection (supportive).
 * @param {Array<Object>} history - Array of {odds, start_ts} entries
 * @returns {number|null} CLV percentage, or null if insufficient data
 */
function computeClvFromHistory(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const sorted = [...history].sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0));
  const openOdds = sorted[0].odds;
  const currentOdds = sorted[sorted.length - 1].odds;
  if (!openOdds || !currentOdds || openOdds === 0) return null;
  return ((currentOdds - openOdds) / Math.abs(openOdds)) * 100;
}

/**
 * Derive movement disposition from CLV.
 * @param {number|null} clv - CLV percentage
 * @returns {string} Movement disposition label
 */
function deriveMovementFromClv(clv) {
  if (clv === null || clv === undefined) return 'insufficient';
  if (clv > 2) return 'supportive_clean';
  if (clv > 0) return 'supportive_bouncy';
  if (clv < -2) return 'adverse_full';
  if (clv < 0) return 'adverse_recent';
  return 'insufficient'; // exactly 0 = flat, no signal
}

/**
 * Assign tier based on CLV magnitude and book count.
 * @param {number|null} clv - CLV percentage
 * @param {number} bookCount - Number of books with data
 * @returns {string} Tier label
 */
function assignTierFromClv(clv, bookCount) {
  if (clv === null) return 'TIER 2';
  const absClv = Math.abs(clv);
  if (absClv >= 3 && bookCount >= 2) return 'TIER 1';
  if (absClv >= 1.5) return 'TIER 1';
  if (absClv >= 0.5) return 'TIER 2';
  return 'TIER 2';
}

/**
 * @param {Object} opts
 * @param {Object} opts.client - PP API client
 * @param {string} opts.book - Target book name
 * @returns {Promise<Array<Object>>} Tennis plays with computed CLV/movement
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

        // Determine which selection to analyze
        const selection1 = odds1 ? sel.selection1 : null;
        const selection2 = odds2 ? sel.selection2 : null;
        const selectionId1 = odds1 ? sel.selection1Id : null;
        const selectionId2 = odds2 ? sel.selection2Id : null;

        // Query odds history for CLV computation
        let clv = null;
        let movementDisposition = 'insufficient';
        let bookCount = 0;

        const selectionId = selectionId1 || selectionId2;
        if (selectionId && game.gameId) {
          try {
            const history = await client.queryOddsHistory({
              gameId: game.gameId,
              selectionId,
              sportsbooks: [book],
              lookbackHours: LOOKBACK_HOURS
            });
            const bookHistory = history?.[book];
            if (Array.isArray(bookHistory) && bookHistory.length >= 2) {
              bookCount = 1;
              clv = computeClvFromHistory(bookHistory);
              movementDisposition = deriveMovementFromClv(clv);
            }
          } catch (_err) {
            // Odds history unavailable — play with insufficient signal
          }
        }

        // Create one play per selection with real analysis
        if (odds1 && selection1) {
          plays.push({
            game: `${game.awayTeam || ''} vs ${game.homeTeam || ''}`,
            gameId: game.gameId,
            league: 'Tennis',
            market,
            start: game.start,
            selection: selection1,
            participant: sel.participant1 || selection1,
            odds: odds1,
            book,
            tier: assignTierFromClv(clv, bookCount),
            verdict: movementDisposition === 'insufficient' ? 'CONSIDER' : 'BET',
            movementDisposition,
            edge: clv !== null ? Math.round(clv * 10) / 10 : 0,
            clvProxyPct: clv !== null ? Math.round(clv * 10) / 10 : 0,
            source: 'tennis_fallback'
          });
        }
        if (odds2 && selection2) {
          // For selection2, CLV is inverted (opposite side of the market)
          const clv2 = clv !== null ? -clv : null;
          plays.push({
            game: `${game.awayTeam || ''} vs ${game.homeTeam || ''}`,
            gameId: game.gameId,
            league: 'Tennis',
            market,
            start: game.start,
            selection: selection2,
            participant: sel.participant2 || selection2,
            odds: odds2,
            book,
            tier: assignTierFromClv(clv2, bookCount),
            verdict: deriveMovementFromClv(clv2) === 'insufficient' ? 'CONSIDER' : 'BET',
            movementDisposition: deriveMovementFromClv(clv2),
            edge: clv2 !== null ? Math.round(clv2 * 10) / 10 : 0,
            clvProxyPct: clv2 !== null ? Math.round(clv2 * 10) / 10 : 0,
            source: 'tennis_fallback'
          });
        }
      }
    }
  }

  return plays;
}

module.exports = { recoverTennisFromScreen, computeClvFromHistory, deriveMovementFromClv, assignTierFromClv };
