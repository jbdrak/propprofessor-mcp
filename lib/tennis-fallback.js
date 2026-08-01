'use strict';

/**
 * Tennis fallback recovery — when the sharp-play pipeline drops all tennis
 * plays (because sharp books don't carry tennis markets), re-query the
 * screen API directly and compute real CLV/movement from multi-book odds history.
 *
 * @module lib/tennis-fallback
 */

const { correctTennisTimes } = require('./propprofessor-tennis');

const LOOKBACK_HOURS = 24;

// Books to query for odds history, ordered by sharpness preference
const HISTORY_BOOKS = ['Pinnacle', 'BetOnline', 'Circa', 'DraftKings', 'FanDuel', 'BetMGM', 'NoVigApp'];

/**
 * Convert American odds to implied probability.
 * @param {number} americanOdds - American odds (e.g. -110, +150)
 * @returns {number} Implied probability 0-1
 */
function impliedProb(americanOdds) {
  if (americanOdds < 0) return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
  return 100 / (americanOdds + 100);
}

/**
 * Compute CLV (Closing Line Value) from odds history entries.
 * Returns the change in implied probability from earliest to latest odds,
 * along with the opening and current odds used in the calculation.
 * Positive CLV = line moved toward this selection (supportive).
 * @param {Array<Object>} history - Array of {odds, start_ts} entries
 * @returns {{clv: number, openingOdds: number, currentOdds: number}|null} CLV result or null if insufficient data
 */
function computeClvFromHistory(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const sorted = [...history].sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0));
  const openOdds = sorted[0].odds;
  const currentOdds = sorted[sorted.length - 1].odds;
  if (!openOdds || !currentOdds || openOdds === 0) return null;
  return { clv: (impliedProb(currentOdds) - impliedProb(openOdds)) * 100, openingOdds: openOdds, currentOdds };
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
 * Map movement disposition to verdict.
 * Only supportive movement surfaces as BET. Adverse movement (even recent)
 * and insufficient data all map to CONSIDER.
 * @param {string} movementDisposition - Movement disposition label
 * @returns {'BET'|'CONSIDER'} Verdict
 */
function verdictFromDisposition(movementDisposition) {
  if (movementDisposition === 'supportive_clean' || movementDisposition === 'supportive_bouncy') return 'BET';
  return 'CONSIDER';
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
 * Check if a tennis market+selection pair is an alternate (expanded) line.
 *
 * Policy (aligned with alternate-line-filter.js and screen-ranker.js):
 * - Moneyline: never alternate (keep regardless of price)
 * - Total Games: always standard (keep all)
 * - Game Handicap: standard lines are ±1.5 and ±2.5; anything beyond ±2.5
 *   is an expanded alternate and gets filtered out
 *
 * @param {string} market - Market name (e.g. 'Moneyline', 'Game Handicap', 'Total Games')
 * @param {string} selection - Selection text (e.g. 'Djokovic -1.5', 'Over 22.5')
 * @returns {boolean} True if this is an alternate line that should be dropped
 */
function isTennisAlternateLine(market, selection) {
  if (market === 'Moneyline') return false;
  if (market === 'Total Games') return false;
  if (market === 'Game Handicap') {
    const match = String(selection || '').match(/(\d+\.?\d*)/);
    if (!match) return false; // can't determine, keep it
    const lineNumber = parseFloat(match[1]);
    return lineNumber > 2.5;
  }
  return false;
}

/**
 * Resolve opposite-side conflicts per (gameId, market) group.
 *
 * Defense-in-depth: ensures that both sides of the same market (e.g. both
 * Djokovic ML and Alcaraz ML) never both surface as BET. The primary
 * protection is verdictFromDisposition — adverse CLV always maps to
 * CONSIDER — but this step catches any edge case where the primary
 * logic would still produce a duplicate.
 *
 * @param {Array<Object>} plays - Array of play objects (mutated in-place)
 * @returns {Array<Object>} Same array with conflicts resolved
 */
function resolveOppositeSideConflicts(plays) {
  if (!Array.isArray(plays)) return plays;

  // Group BET plays by (gameId, market)
  const groups = new Map();
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    if (p.verdict !== 'BET') continue;
    const key = `${p.gameId}|${p.market}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }

  for (const [, indices] of groups) {
    if (indices.length <= 1) continue;

    // Sort: prefer supportive_clean > supportive_bouncy, then higher absolute CLV
    const sorted = [...indices].sort((aIdx, bIdx) => {
      const a = plays[aIdx];
      const b = plays[bIdx];
      const aScore = a.movementDisposition === 'supportive_clean' ? 2 : 1;
      const bScore = b.movementDisposition === 'supportive_clean' ? 2 : 1;
      if (bScore !== aScore) return bScore - aScore;
      return Math.abs(b.clvProxyPct || 0) - Math.abs(a.clvProxyPct || 0);
    });

    const winnerIdx = sorted[0];
    const winnerPlay = plays[winnerIdx];
    for (let i = 1; i < sorted.length; i++) {
      const loserIdx = sorted[i];
      const loser = plays[loserIdx];
      loser.verdict = 'CONSIDER';
      loser.conflictResolved = true;
      loser.conflictNote = `Opposite side "${winnerPlay.selection}" (${winnerPlay.movementDisposition}, CLV=${winnerPlay.clvProxyPct}) kept as BET`;
    }
  }

  return plays;
}

/**
 * @param {Object} opts
 * @param {Object} opts.client - PP API client
 * @param {string} opts.book - Target book name
 * @param {boolean} [opts.skipTimeCorrection=false] - Skip ESPN time correction (testing only)
 * @returns {Promise<Array<Object>>} Tennis plays with computed CLV/movement
 */
async function recoverTennisFromScreen({ client, book, skipTimeCorrection = false }) {
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

        // Skip expanded alternate lines (Game Handicap beyond ±2.5).
        // Never drop Moneyline or Total Games for price reasons.
        const selection1 = odds1 ? sel.selection1 : null;
        const selection2 = odds2 ? sel.selection2 : null;

        if (odds1 && selection1 && isTennisAlternateLine(market, selection1)) continue;
        if (odds2 && selection2 && isTennisAlternateLine(market, selection2)) continue;

        const selectionId1 = odds1 ? sel.selection1Id : null;
        const selectionId2 = odds2 ? sel.selection2Id : null;

        // Query odds history from multiple books for CLV computation
        let clv = null;
        let movementDisposition = 'insufficient';
        let bookCount = 0;
        let clvSource = null;
        let openingOdds = null;
        let currentOdds = null;

        const selectionId = selectionId1 || selectionId2;
        if (selectionId && game.gameId) {
          try {
            const history = await client.queryOddsHistory({
              gameId: game.gameId,
              selectionId,
              sportsbooks: HISTORY_BOOKS,
              lookbackHours: LOOKBACK_HOURS
            });

            // Find the best available source (prefer sharp books)
            for (const histBook of HISTORY_BOOKS) {
              const bookHistory = history?.[histBook];
              if (Array.isArray(bookHistory) && bookHistory.length >= 2) {
                const result = computeClvFromHistory(bookHistory);
                if (result !== null) {
                  // Use first valid source (already ordered by sharpness)
                  if (clv === null) {
                    clv = result.clv;
                    clvSource = histBook;
                    openingOdds = result.openingOdds;
                    currentOdds = result.currentOdds;
                    movementDisposition = deriveMovementFromClv(clv);
                  }
                  bookCount++;
                }
              }
            }
          } catch {
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
            verdict: verdictFromDisposition(movementDisposition),
            movementDisposition,
            edge: clv !== null ? Math.round(clv * 10) / 10 : 0,
            clvProxyPct: clv !== null ? Math.round(clv * 10) / 10 : 0,
            openingOdds,
            currentOdds,
            source: clvSource ? `tennis_fallback (${clvSource})` : 'tennis_fallback'
          });
        }
        if (odds2 && selection2) {
          // For selection2, CLV is inverted (opposite side of the market)
          const clv2 = clv !== null ? -clv : null;
          const mov2 = deriveMovementFromClv(clv2);
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
            verdict: verdictFromDisposition(mov2),
            movementDisposition: mov2,
            edge: clv2 !== null ? Math.round(clv2 * 10) / 10 : 0,
            clvProxyPct: clv2 !== null ? Math.round(clv2 * 10) / 10 : 0,
            openingOdds: null,
            currentOdds: null,
            source: clvSource ? `tennis_fallback (${clvSource})` : 'tennis_fallback'
          });
        }
      }
    }
  }

  // Defense-in-depth: ensure opposite sides of same market never both BET
  resolveOppositeSideConflicts(plays);

  // Correct tennis start times via ESPN before returning
  if (plays.length > 0 && !skipTimeCorrection) {
    await correctTennisTimes(plays);
  }

  return plays;
}

module.exports = {
  recoverTennisFromScreen,
  computeClvFromHistory,
  deriveMovementFromClv,
  verdictFromDisposition,
  assignTierFromClv,
  isTennisAlternateLine,
  resolveOppositeSideConflicts
};
