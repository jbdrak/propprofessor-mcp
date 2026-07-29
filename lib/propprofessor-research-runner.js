'use strict';

const { mapWithConcurrency } = require('./propprofessor-shared-utils');
const { isPlayerSelection } = require('./propprofessor-selection-type');

/**
 * Run research on a list of ranked rows. Routes player selections to
 * player_context (injury/news) and team/line selections to game_context
 * (rest days, weather, surface, etc.).
 *
 * Used by screen_ranked and recommended_bets as a pre-flight to attach
 * risk flags alongside the ranked plays.
 *
 * Why this lives in its own module:
 * - The runner is reused across 3+ handlers with the same shape and the same
 *   error-handling contract. Inlining it in each handler would duplicate the
 *   player-name extraction, the per-row try/catch, and the result aggregation.
 * - Centralizes the routing decision: a single isPlayerSelection() call per
 *   row determines whether to call playerContextFn or gameContextFn.
 *
 * @param {Object} options
 * @param {Array<Object>} options.rows - Ranked rows to research. Each must have
 *   selection or participant, league/market, and ideally start (gameTime).
 * @param {number} [options.limit=10] - Max rows to research (top N by screenScore).
 * @param {Function} options.playerContextFn - Player-context handler. Called for
 *   individual-player selections. Accepts { player, sport, gameTime, maxAgeMinutes }.
 * @param {Function} [options.gameContextFn] - Game-context handler. Called for
 *   team/line selections. Accepts { sport, selection, game, start, market }.
 *   Optional — when absent, non-player selections get a stub result.
 * @param {number} [options.maxAgeMinutes=60] - Passed to player_context.
 * @param {number} [options.concurrency=3] - Max in-flight calls.
 * @returns {Promise<{results: Array<Object>, errors: number}>} results array
 *   contains { player, game, league, market, start, riskFlag, riskSummary,
 *   contextType, cached, fetchedAt }.
 */

// @ts-expect-error
async function runResearchOnTopRows({
  rows,
  limit = 10,
  playerContextFn,
  gameContextFn,
  maxAgeMinutes = 60,
  concurrency = 3
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { results: [], errors: 0 };
  }
  if (typeof playerContextFn !== 'function') {
    return { results: [], errors: 0 };
  }

  // Sort by screenScore desc so the top plays get researched first.
  const sorted = [...rows].sort((a, b) => {
    const aScore = Number(a.screenScore ?? 0);
    const bScore = Number(b.screenScore ?? 0);
    return bScore - aScore;
  });
  const top = sorted.slice(0, Math.max(0, limit));

  const results = await mapWithConcurrency(
    top,
    async (row) => {
      const player = String(row.selection || row.participant || row.pick || '').trim();
      if (!player) return null;
      const league = String(row.league || row.scanLeague || '').trim();
      const market = String(row._market || row.market || row.screenMarket || '').trim();
      const start = row.start || row.eventStart || null;
      const game = row.game || (row.awayTeam && row.homeTeam ? `${row.awayTeam} @ ${row.homeTeam}` : null);

      // Route: player selections get player_context, everything else gets game_context
      const isPlayer = isPlayerSelection(player);

      try {
        let ctx;
        if (isPlayer) {
          ctx = await playerContextFn({
            player,
            sport: league || undefined,
            gameTime: start || undefined,
            maxAgeMinutes
          });
        } else if (typeof gameContextFn === 'function') {
          ctx = await gameContextFn({
            sport: league,
            selection: player,
            game,
            start,
            market
          });
        } else {
          // No game context function provided — return a stub
          ctx = { riskFlag: 'unknown', riskSummary: 'no game context handler' };
        }

        if (!ctx) {
          return {
            player,
            game,
            league,
            market,
            start,
            riskFlag: 'unknown',
            contextType: isPlayer ? 'player' : 'game',
            error: 'no_context'
          };
        }

        const result = {
          player,
          game,
          league,
          market,
          start,
          riskFlag: ctx.riskFlag || 'unknown',
          riskSummary: ctx.riskSummary || ctx.summary || null,
          contextType: isPlayer ? 'player' : 'game',
          cached: Boolean(ctx.cached),
          fetchedAt: ctx.fetchedAt || new Date().toISOString()
        };

        // Player context includes a topTweet; game context doesn't
        if (isPlayer && Array.isArray(ctx.tweets) && ctx.tweets.length > 0) {
          result.topTweet = ctx.tweets[0]?.text?.slice(0, 200) || null;
        }

        return result;
      } catch (error) {
        return {
          player,
          game,
          league,
          market,
          start,
          riskFlag: 'error',
          contextType: isPlayer ? 'player' : 'game',
          error: error?.message || String(error)
        };
      }
    },
    { concurrency }
  );

  // mapWithConcurrency preserves input order; filter out the no-player rows.
  const filtered = results.filter(Boolean);
  // @ts-expect-error
  const errors = filtered.reduce((sum, r) => sum + (r.riskFlag === 'error' || r.error ? 1 : 0), 0);
  return { results: filtered, errors };
}

module.exports = { runResearchOnTopRows };
