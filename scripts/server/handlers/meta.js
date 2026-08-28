'use strict';

/**
 * Meta handlers: market registry and self-documentation.
 * Note: league_presets stays inline in handlers.js — it depends on
 * closure-scoped helpers (getLeagueRankingPreset, getSharpBookComparisonSet,
 * getSharpBookContext) that aren't easily extractable.
 */

const { getMarketsForSport } = require('../../../lib/propprofessor-market-registry');

/**
 * @param {import('../../../lib/propprofessor-api').PropProfessorClient} _client
 * @param {import('./handler-context').HandlerContext} _ctx
 */
function createMetaHandlers(_client, _ctx) {
  return {
    async get_market_registry(args = {}) {
      const sport = String(args.sport || '').trim();
      const book = args.book ? String(args.book).trim() : null;
      if (!sport) {
        return { ok: false, error: { code: 'MISSING_PARAMS', message: 'sport is required' } };
      }
      const markets = getMarketsForSport(sport, book);
      return {
        ok: true,
        sport,
        book: book || 'default',
        markets,
        note:
          sport.toUpperCase() === 'SOCCER'
            ? 'Soccer uses Draw No Bet (not Moneyline), Match Handicap (not Spread), and Total Goals'
            : undefined
      };
    }
  };
}

module.exports = { createMetaHandlers };
