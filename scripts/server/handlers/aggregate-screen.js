'use strict';

/**
 * Aggregate screen orchestration seam (Phase 3 Task 6).
 *
 * Owns ONLY the request-PER-CALL planning + aggregate response-cache stage of
 * quick_screen: mode presets, derived request scalars, lite field coercion,
 * and the aggregate (whole-call) response-cache key construction + lookup.
 *
 * This is a behavioral extraction with NO behavior change: every line below is
 * lifted verbatim from createMcpHandlers().quick_screen in handlers.js. The
 * dependency-injected seam is `responseCache` (the LruCache instance built in
 * createMcpHandlers). Tests inject a fake cache to pin the cache-key shape and
 * the hit/miss contract without touching the network path.
 *
 * Everything downstream of planning (league×market fan-out, validation,
 * research, verbosity formatting, lite stripping, response caching) stays in
 * handlers.js untouched — this module does not wrap or reorder any of it.
 */

const { DEFAULT_LEAGUES } = require('../../../lib/propprofessor-shared-utils');

/**
 * Plan one quick_screen request: apply mode presets, derive request scalars,
 * coerce lite fields, and resolve the aggregate response-cache key / hit.
 *
 * @param {object} args - The (mutable) quick_screen args. Mode presets and the
 *   lite `compact`/`fields` coercion are written back onto this object, exactly
 *   as the inlined implementation did.
 * @param {object} [deps]
 * @param {object} [deps.responseCache] - LruCache-like instance exposing
 *   `get(key)`. Injected by createMcpHandlers. When absent (or non-object),
 *   the cache stage is skipped and `cachedResponse` is always null.
 * @returns {{
 *   targetBooks: string[],
 *   leagues: string[],
 *   markets: string[]|null,
 *   limit: number,
 *   maxPerMarket: number|null,
 *   scanLimit: number,
 *   lookbackHours: number,
 *   includeResearch: boolean,
 *   debug: boolean,
 *   topPick: boolean,
 *   lite: boolean,
 *   aggregateCacheKey: string|null,
 *   cachedResponse: object|null
 * }}
 */
function planAggregateScreen(args = {}, deps = {}) {
  const responseCache = deps && typeof deps.responseCache === 'object' ? deps.responseCache : null;

  // === mode presets (folded-in retired tools) ===
  // quick_screen always screens through handlers.sharp_plays internally,
  // so 'sharp' is the same as the default broad scan — the mode flag
  // exists for agent ergonomics / backward-compat routing. The other two
  // presets mirror the retired recommended_bets and tonight_bets tools.
  // Explicit args always win over these preset defaults.
  const mode = args.mode;
  if (mode === 'recommended') {
    if (!(Array.isArray(args.leagues) && args.leagues.length) && !args.league) {
      args.leagues = ['WNBA', 'NBA', 'MLB', 'NFL'];
    }
    if (!(Array.isArray(args.targetTiers) && args.targetTiers.length)) {
      args.targetTiers = ['TIER 1', 'TIER 2'];
    }
    if (args.validate === undefined) args.validate = true;
    if (args.hideVerdict === undefined) args.hideVerdict = true;
  } else if (mode === 'tonight') {
    if (!(Array.isArray(args.kaiCall) && args.kaiCall.length)) {
      args.kaiCall = ['BET', 'CONSIDER'];
    }
    if (!args.sortBy) args.sortBy = 'start';
    if (!args.sortDir) args.sortDir = 'asc';
    if (args.includeResearch === undefined) args.includeResearch = true;
    if (!Number.isFinite(Number(args.limit))) args.limit = 5;
  }
  // ('sharp' === default sharp_plays-backed scan; no override needed.)

  const targetBooks =
    Array.isArray(args.books) && args.books.length ? args.books : args.book ? [args.book] : ['NoVigApp'];
  const leagues =
    Array.isArray(args.leagues) && args.leagues.length
      ? args.leagues
      : args.league
        ? [args.league]
        : Array.from(DEFAULT_LEAGUES);
  const markets =
    Array.isArray(args.markets) && args.markets.length ? args.markets : args.market ? [args.market] : null; // null = use per-league defaults below
  const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 100;
  const maxPerMarket = Number.isFinite(Number(args.maxPerMarket)) ? Number(args.maxPerMarket) : null;
  const scanLimit = Number.isFinite(Number(args.scanLimit)) ? Number(args.scanLimit) : 100;
  const lookbackHours = Number.isFinite(Number(args.lookbackHours)) ? Number(args.lookbackHours) : 6;
  const includeResearch = args.includeResearch !== undefined ? Boolean(args.includeResearch) : true;
  const debug = Boolean(args.debug);
  const topPick = Boolean(args.topPick);
  // lite: token-light mode. Implies compact + a fixed essential field set.
  const lite = Boolean(args.lite);
  if (lite) {
    args.compact = true;
    args.fields = [
      'game',
      'selection',
      'odds',
      'edge',
      'clv',
      'confidenceTier',
      'riskScore',
      'startCST',
      'movementDisposition',
      'riskFlag',
      'screenScore'
    ];
  }

  // === response cache (aggregate level) ===
  // Cache the FULL quick_screen response keyed on the request shape.
  // Per-league screen_ranked calls are already cached individually, but
  // the fan-out loop still burns time iterating leagues. This cache
  // short-circuits the entire call when args haven't changed.
  // Bypassed when validate:true (must re-fetch for fresh validation).
  const canCacheAggregate = !args.validate && args.cache !== false;
  let aggregateCacheKey = null;
  let cachedResponse = null;
  if (canCacheAggregate) {
    // The key is always derived when caching is enabled (faithful to the
    // original inlined behavior) so callers can stash it for the return path.
    // The lookup itself only runs when a responseCache dependency was injected.
    aggregateCacheKey = JSON.stringify({
      _qs: 1,
      leagues: (leagues || []).slice().sort(),
      markets: (markets || []).slice().sort(),
      books: (targetBooks || []).slice().sort(),
      limit,
      cardWindow: args.cardWindow || 'today',
      includeProps: args.includeProps === true,
      // Request-shaping options MUST be part of the key: a response
      // produced for one option set must never be served for a different
      // one. Two calls that differ in any of these must miss the cache.
      targetTiers: (Array.isArray(args.targetTiers) ? args.targetTiers : []).slice().sort(),
      kaiCall: (Array.isArray(args.kaiCall) ? args.kaiCall : []).slice().sort(),
      movement: (Array.isArray(args.movement) ? args.movement : []).slice().sort(),
      minEV: args.minEV === undefined ? null : Number(args.minEV),
      verbosity: String(args.verbosity || 'full').toLowerCase(),
      includeResearch: includeResearch === true,
      lite: lite === true,
      evFirst: args.evFirst !== false
    });
    if (responseCache) {
      const cached = responseCache.get(aggregateCacheKey);
      if (cached) {
        cachedResponse = { ...cached, resultMeta: { ...cached.resultMeta, cached: true } };
      }
    }
  }
  // === end response cache ===

  return {
    targetBooks,
    leagues,
    markets,
    limit,
    maxPerMarket,
    scanLimit,
    lookbackHours,
    includeResearch,
    debug,
    topPick,
    lite,
    aggregateCacheKey,
    cachedResponse
  };
}

module.exports = { planAggregateScreen };
