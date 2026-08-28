'use strict';

/**
 * Context plugins handlers: player_context, mlb_game_context, fantasy_optimizer,
 * clear_score_timeline, get_market_registry, manage_hidden_bets, league_presets.
 *
 * Extracted from createMcpHandlers() in handlers.js (v2.x.x).
 *
 * Note: ufc_card was skipped — it calls the closure function `runUfcCard`
 * which depends on resolveMarkets, runLeagueScreen, buildUfcShortlist, getLimit
 * and other closure-scoped helpers.
 */

const { ok } = require('../../../lib/response-envelope');
const { getPlayerContext } = require('../../../lib/propprofessor-player-context');
const { getMlbGameContext } = require('../../../lib/propprofessor-mlb-game-context');
const { clearScoreTimeline } = require('../../../lib/propprofessor-risk-score');
const { getMarketsForSport, getPropMarketsForSport } = require('../../../lib/propprofessor-market-registry');
const { getLeagueRankingPreset } = require('../../../lib/propprofessor-mcp-ranked-screen');
const { getSharpBookComparisonSet, getSharpBookContext } = require('../../../lib/propprofessor-sharp-books');

// ─── league preset inspector (extracted closure) ──────────────────────────

function buildLeaguePresetSummary() {
  const leagues = ['NBA', 'WNBA', 'MLB', 'NFL', 'NHL', 'UFC', 'SOCCER', 'TENNIS', 'NCAAB', 'NCAAF'];
  return leagues.map((league) => {
    const preset = getLeagueRankingPreset(league);
    const isSharpLeague = ['NBA', 'NFL', 'MLB'].includes(league);
    const sharpMainMarkets = isSharpLeague ? getSharpBookComparisonSet({ league, market: 'Moneyline' }) : undefined;
    const sharpProps = isSharpLeague
      ? getSharpBookComparisonSet({ league, market: league === 'MLB' ? 'Player Strikeouts' : 'Player Points' })
      : undefined;

    return {
      ...preset,
      sharpMainMarkets,
      sharpProps,
      sharpBookVariants: isSharpLeague
        ? {
            mainMarkets: sharpMainMarkets,
            playerProps: sharpProps
          }
        : undefined,
      sharpBookResearch: getSharpBookContext({ league, market: league === 'MLB' ? 'Moneyline' : undefined })
    };
  });
}

// ─── factory ──────────────────────────────────────────────────────────────

/**
 * @param {import('../../../lib/propprofessor-api').PropProfessorClient} client
 * @param {import('./handler-context').HandlerContext} ctx
 */
function createContextPluginsHandlers(client, _ctx) {
  return {
    async player_context(args = {}) {
      const player = typeof args.player === 'string' ? args.player.trim() : '';
      if (!player) {
        return { ok: false, error: 'player argument is required' };
      }
      return ok(
        await getPlayerContext({
          player,
          sport: typeof args.sport === 'string' && args.sport.length > 0 ? args.sport : null,
          gameTime: typeof args.gameTime === 'string' && args.gameTime.length > 0 ? args.gameTime : null,
          maxAgeMinutes: Number.isFinite(Number(args.maxAgeMinutes)) ? Number(args.maxAgeMinutes) : 60,
          useXurl: args.useXurl === true
        })
      );
    },

    async mlb_game_context(args = {}) {
      const gamePk = String(args.gamePk || '').trim();
      if (!gamePk) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'gamePk is required' } };
      }
      if (!/^\d{4,}$/.test(gamePk)) {
        return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'gamePk must be a numeric MLB game ID' } };
      }
      try {
        const result = await getMlbGameContext({ gamePk });
        return result;
      } catch (err) {
        return { ok: false, gamePk, error: { code: 'API_ERROR', message: err?.message || String(err) } };
      }
    },

    async fantasy_optimizer(args = {}) {
      const filters = {
        fantasyApps: Array.isArray(args.fantasyApps) && args.fantasyApps.length ? args.fantasyApps : ['PrizePicks'],
        leagues:
          Array.isArray(args.leagues) && args.leagues.length
            ? args.leagues
            : ['NBA', 'MLB', 'WNBA', 'Tennis', 'NHL', 'NFL', 'UFC', 'Soccer']
      };
      if (args.market) filters.market = args.market;
      if (args.isLive === true) filters.isLive = true;
      const result = await client.queryBackendFantasyPicks(filters);
      return {
        ok: true,
        count: Array.isArray(result) ? result.length : 0,
        result: Array.isArray(result) ? result : []
      };
    },

    async clear_score_timeline() {
      clearScoreTimeline();
      return { ok: true, message: 'Score timeline cache cleared. Tier trajectory data reset.' };
    },

    async get_market_registry(args = {}) {
      const sport = String(args.sport || '').trim();
      const book = args.book ? String(args.book).trim() : null;
      if (!sport) {
        return { ok: false, error: { code: 'MISSING_PARAMS', message: 'sport is required' } };
      }
      const markets = getMarketsForSport(sport, book);
      const propMarkets = getPropMarketsForSport(sport);
      return {
        ok: true,
        sport,
        book: book || 'default',
        markets,
        propMarkets,
        note:
          sport.toUpperCase() === 'SOCCER'
            ? 'Soccer uses Draw No Bet (not Moneyline), Match Handicap (not Spread), and Total Goals'
            : undefined
      };
    },

    async manage_hidden_bets(args = {}) {
      const { action } = args;
      if (action === 'list') {
        const result = await client.getHiddenBets();
        return { ok: true, action, result };
      }
      if (action === 'hide') {
        if (!args.bet || typeof args.bet !== 'object') {
          const error = new Error('The bet parameter is required and must be an object.');
          error.code = 'MISSING_BET';
          error.category = 'validation';
          error.status = 400;
          throw error;
        }
        const result = await client.hideBet(args.bet);
        return { ok: true, action, result };
      }
      if (action === 'unhide') {
        if (!args.id) {
          const error = new Error('The id parameter is required.');
          error.code = 'MISSING_ID';
          error.category = 'validation';
          error.status = 400;
          throw error;
        }
        const result = await client.unhideBet(args.id);
        return { ok: true, action, result };
      }
      if (action === 'clear') {
        const result = await client.clearHiddenBets();
        return { ok: true, action, result };
      }
      const error = new Error(`Unknown action: ${action}. Must be one of: list, hide, unhide, clear.`);
      error.code = 'INVALID_ACTION';
      error.category = 'validation';
      error.status = 400;
      throw error;
    },

    async league_presets() {
      return { ok: true, result: buildLeaguePresetSummary() };
    }
  };
}

module.exports = { createContextPluginsHandlers };
