'use strict';

/**
 * Misc inline handlers extracted from createMcpHandlers() in handlers.js:
 *   - all_slates
 *   - ufc_card (delegates to ctx.handlers.runUfcCard)
 *   - get_play_details (with canonical-screen-cache memoization)
 *   - validate_play (wraps ctx.handlers.runValidatePlayImpl + ok envelope)
 *
 * Behavioral extraction with NO behavior change. Closure state (client, ctx,
 * canonicalScreenCache) is passed explicitly via the factory args. Module-level
 * imports (resolveMarkets, canonicalizeScreenArgs, ok, categorizeError, clearTierCache)
 * are required at the top of this file.
 *
 * @param {import('../../../lib/propprofessor-api').PropProfessorClient} client
 * @param {import('./handler-context').HandlerContext} ctx
 */

const { ok } = require('../../../lib/response-envelope');
const { clearTierCache } = require('../../../lib/propprofessor-risk-score');
const {
  DEFAULT_LEAGUES,
  canonicalizeScreenArgs,
  mapWithConcurrency
} = require('../../../lib/propprofessor-shared-utils');
const { getLimit } = require('../../../lib/propprofessor-mcp-ranked-screen');
const { getMarketsForSport } = require('../../../lib/propprofessor-market-registry');
const { resolveMarkets } = require('./handler-utils');
const { categorizeError } = require('../../../lib/propprofessor-mcp-stdio');

// Local mirror of the original inline getDefaultMarketsForLeague wrapper in
// handlers.js — resolves default markets for a league via the registry.
function getDefaultMarketsForLeague(league, _targetBooks) {
  return getMarketsForSport(league, _targetBooks);
}

// all_slates: fan out across per-league default markets and consolidate.
async function runAllSlates(ctx, args = {}) {
  const leagues =
    Array.isArray(args.leagues) && args.leagues.length
      ? args.leagues.map((l) => String(l).trim()).filter(Boolean)
      : Array.from(DEFAULT_LEAGUES);
  const allAliasesUsed = [];
  // Fan out across per-league default markets instead of single-market
  const marketResolutionByLeague = {};
  for (const league of leagues) {
    const userProvidedMarkets = !(args.markets === undefined && args.market === undefined);
    const markets = userProvidedMarkets ? args.markets || [args.market] : getDefaultMarketsForLeague(league);
    const resolvedMarkets = [];
    for (const m of Array.isArray(markets) ? markets : [markets]) {
      const marketResolution = resolveMarkets({ market: m }, league);
      resolvedMarkets.push(marketResolution.single);
      allAliasesUsed.push(...marketResolution.aliasesUsed);
    }
    marketResolutionByLeague[league] = resolvedMarkets;
  }
  const limit = getLimit({ limit: args.limit || 15 });

  const results = await mapWithConcurrency(
    leagues,
    async (league) => {
      try {
        const leagueKey = league.toUpperCase();
        const resolvedMarkets = marketResolutionByLeague[league] || ['Moneyline'];
        let allRows = [];
        let source = 'screen';
        let warnings = undefined;
        for (const resolvedMarket of resolvedMarkets) {
          if (leagueKey === 'TENNIS') {
            const tennisResult = await ctx.handlers.runTennisScreen({
              market: resolvedMarket,
              limit,
              includeAll: args.includeAll,
              lookbackHours: args.lookbackHours,
              is_live: false,
              compact: Boolean(args.compact),
              fields: Array.isArray(args.fields) ? args.fields : undefined,
              include: Array.isArray(args.include) ? args.include : undefined,
              skipHistory: args.skipHistory === true
            });
            allRows.push(...(tennisResult.result || []));
            source = tennisResult.source || source;
            warnings = tennisResult.warnings || warnings;
          } else {
            const leagueResult = await ctx.handlers.runLeagueScreen({
              market: resolvedMarket,
              league,
              limit: limit * 2,
              includeAll: args.includeAll,
              lookbackHours: args.lookbackHours,
              is_live: false,
              compact: Boolean(args.compact),
              fields: Array.isArray(args.fields) ? args.fields : undefined,
              include: Array.isArray(args.include) ? args.include : undefined,
              skipHistory: args.skipHistory === true
            });
            allRows.push(...(leagueResult.result || []));
            warnings = leagueResult.warnings || warnings;
          }
        }
        return {
          league,
          rows: allRows,
          meta: {
            rowCount: allRows.length,
            source,
            ...(warnings ? { warnings } : {})
          }
        };
      } catch (error) {
        const categorized = categorizeError(error);
        return {
          league,
          rows: [],
          meta: { rowCount: 0, source: 'error' },
          error: {
            error: categorized.message,
            code: categorized.code,
            recovery: categorized.recovery
          }
        };
      }
    },
    { concurrency: 3 }
  );

  const errors = results.filter((r) => r.error).map((r) => ({ league: r.league, ...r.error }));
  const leagueMeta = Object.fromEntries(results.map((r) => [r.league, r.meta]));
  let totalPlays = 0;
  const allRows = [];
  for (const { league, rows } of results) {
    totalPlays += rows.length;
    for (const row of rows) {
      allRows.push({ ...row, _league: league });
    }
  }
  allRows.sort((a, b) => Number(b.screenScore || 0) - Number(a.screenScore || 0));

  return {
    ok: true,
    totalPlays,
    leaguesQueried: leagues,
    leagueMeta,
    consolidated: allRows.slice(0, limit * leagues.length),
    markets_alias_used: allAliasesUsed,
    ...(errors.length > 0 ? { errors } : {})
  };
}

function createSlatesUfcDetailsHandlers(client, ctx) {
  const canonicalScreenCache = ctx.canonicalScreenCache;

  return {
    // ─── Screening & Ranking (continued) ────────────────────────────
    async all_slates(args = {}) {
      return runAllSlates(ctx, args);
    },

    // ─── UFC ────────────────────────────────────────────────────────
    async ufc_card(args = {}) {
      return ctx.handlers.runUfcCard(args);
    },

    // ─── Play Detail & Validation Handlers ──────────────────────────────────

    async get_play_details(args = {}) {
      if (!args.books && args.book) {
        args.books = [args.book];
      }
      const canonicalKey = canonicalizeScreenArgs(args);
      if (canonicalKey) {
        return await canonicalScreenCache.memoize(async () => {
          return await ctx.handlers.runGetPlayDetailsImpl(client, args);
        }, canonicalKey)();
      }
      return ctx.handlers.runGetPlayDetailsImpl(client, args);
    },

    /**
     * validate_play (v2.1.8): bundle a get_play_details + player_context +
     * execution check into a single call. Returns a single BET / CONSIDER /
     * PASS verdict with all supporting evidence so the agent doesn't have
     * to chain three separate tool calls.
     *
     * NOTE: does NOT use canonicalScreenCache. The cache's 60s TTL is
     * appropriate for screen_ranked (where the same gameId is re-fetched
     * within seconds across markets) but actively harmful for validate_play,
     * which bundles research + MLB game context that goes stale quickly.
     * Agents also call validate_play once per candidate, not N times, so
     * there's no dedup benefit worth the staleness risk.
     */
    async validate_play(args = {}) {
      // Reset per-call tier hysteresis so each screen call starts clean
      // (prevents cross-call tier drift from stale cache state).
      clearTierCache();
      const result = await ctx.handlers.runValidatePlayImpl(client, args);
      if (result && result.ok === false) {
        return result;
      }
      return ok(result);
    }
  };
}

module.exports = { createSlatesUfcDetailsHandlers };
