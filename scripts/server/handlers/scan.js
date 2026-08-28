'use strict';

/**
 * Public scan handler. Maps ergonomic sport input to a league and delegates
 * to the assembled quick_screen handler with scan-friendly defaults.
 *
 * @param {Object} _client
 * @param {import('./handler-context').HandlerContext} ctx
 */
function createScanHandlers(_client, ctx) {
  return {
    async scan(args = {}) {
      const sport = String(args.sport || '')
        .trim()
        .toLowerCase();
      const leagueMap = {
        tennis: 'Tennis',
        nba: 'NBA',
        mlb: 'MLB',
        nfl: 'NFL',
        nhl: 'NHL',
        wnba: 'WNBA',
        ufc: 'UFC',
        soccer: 'Soccer',
        ncaab: 'NCAAB',
        ncaaf: 'NCAAF',
        nbasl: 'NBASL'
      };
      const resolvedLeague = args.league || (sport ? leagueMap[sport] || args.sport : undefined);

      return ctx.handlers.quick_screen({
        ...args,
        league: resolvedLeague,
        book: args.book || 'NoVigApp',
        verbosity: args.verbosity || 'bets',
        lite: args.lite !== false,
        sortBy: args.sortBy || 'edge',
        sortDir: args.sortDir || 'desc',
        movement: args.movement || ['supportive_clean', 'supportive_bouncy']
      });
    }
  };
}

module.exports = { createScanHandlers };
