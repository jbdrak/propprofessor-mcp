'use strict';

// Phase 3 Task 6 regression/unit tests for the extracted aggregate screen
// planning seam (scripts/server/handlers/aggregate-screen.js).
//
// These tests pin the EXACT behavior of quick_screen's request-planning +
// aggregate response-cache stage so the extraction cannot silently change a
// field, cache-key component, or branch. They run RED before the module exists
// and GREEN after extraction, with no change to quick_screen's public contract.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { planAggregateScreen } = require('../scripts/server/handlers/aggregate-screen');

// Minimal fake LruCache supporting get/set (the only surface planAggregateScreen uses).
function makeFakeCache() {
  const store = new Map();
  return {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => store.set(k, v),
    _store: store
  };
}

describe('planAggregateScreen: mode presets applied to args', () => {
  it("'recommended' fills leagues/targetTiers/validate/hideVerdict when absent", () => {
    const args = { mode: 'recommended' };
    planAggregateScreen(args, { responseCache: makeFakeCache() });
    assert.deepEqual(args.leagues, ['WNBA', 'NBA', 'MLB', 'NFL']);
    assert.deepEqual(args.targetTiers, ['TIER 1', 'TIER 2']);
    assert.equal(args.validate, true);
    assert.equal(args.hideVerdict, true);
  });

  it("'recommended' does NOT override explicit args", () => {
    const args = {
      mode: 'recommended',
      leagues: ['MLB'],
      targetTiers: ['TIER 3'],
      validate: false,
      hideVerdict: false
    };
    planAggregateScreen(args, { responseCache: makeFakeCache() });
    assert.deepEqual(args.leagues, ['MLB']);
    assert.deepEqual(args.targetTiers, ['TIER 3']);
    assert.equal(args.validate, false);
    assert.equal(args.hideVerdict, false);
  });

  it("'tonight' fills kaiCall/sortBy/sortDir/includeResearch/limit when absent", () => {
    const args = { mode: 'tonight' };
    planAggregateScreen(args, { responseCache: makeFakeCache() });
    assert.deepEqual(args.kaiCall, ['BET', 'CONSIDER']);
    assert.equal(args.sortBy, 'start');
    assert.equal(args.sortDir, 'asc');
    assert.equal(args.includeResearch, true);
    assert.equal(args.limit, 5);
  });

  it("'tonight' does NOT override explicit args", () => {
    const args = {
      mode: 'tonight',
      kaiCall: ['CONSIDER'],
      sortBy: 'edge',
      sortDir: 'desc',
      includeResearch: false,
      limit: 12
    };
    planAggregateScreen(args, { responseCache: makeFakeCache() });
    assert.deepEqual(args.kaiCall, ['CONSIDER']);
    assert.equal(args.sortBy, 'edge');
    assert.equal(args.sortDir, 'desc');
    assert.equal(args.includeResearch, false);
    assert.equal(args.limit, 12);
  });

  it("'sharp' (default) applies no preset overrides", () => {
    const args = { mode: 'sharp' };
    const snapshot = JSON.parse(JSON.stringify(args));
    planAggregateScreen(args, { responseCache: makeFakeCache() });
    assert.deepEqual(args, snapshot);
  });
});

describe('planAggregateScreen: derived request scalars', () => {
  const cache = makeFakeCache();

  it('targetBooks: books wins, then book, then NoVigApp default', () => {
    assert.deepEqual(planAggregateScreen({ books: ['Pinnacle', 'Fliff'] }, { responseCache: cache }).targetBooks, [
      'Pinnacle',
      'Fliff'
    ]);
    assert.deepEqual(planAggregateScreen({ book: 'DraftKings' }, { responseCache: cache }).targetBooks, ['DraftKings']);
    assert.deepEqual(planAggregateScreen({}, { responseCache: cache }).targetBooks, ['NoVigApp']);
  });

  it('leagues: leagues wins, then league, then DEFAULT_LEAGUES', () => {
    const a = planAggregateScreen({ leagues: ['WNBA'] }, { responseCache: cache });
    assert.deepEqual(a.leagues, ['WNBA']);
    const b = planAggregateScreen({ league: 'NBA' }, { responseCache: cache });
    assert.deepEqual(b.leagues, ['NBA']);
    const c = planAggregateScreen({}, { responseCache: cache });
    assert.ok(Array.isArray(c.leagues) && c.leagues.length > 0, 'default leagues should be a non-empty array');
  });

  it('markets: markets wins, then market, then null (per-league defaults)', () => {
    assert.deepEqual(planAggregateScreen({ markets: ['Moneyline'] }, { responseCache: cache }).markets, ['Moneyline']);
    assert.deepEqual(planAggregateScreen({ market: 'Spread' }, { responseCache: cache }).markets, ['Spread']);
    assert.equal(planAggregateScreen({}, { responseCache: cache }).markets, null);
  });

  it('numeric scalars fall back to defaults when non-finite', () => {
    const p = planAggregateScreen({}, { responseCache: cache });
    assert.equal(p.limit, 100);
    assert.equal(p.maxPerMarket, null);
    assert.equal(p.scanLimit, 100);
    assert.equal(p.lookbackHours, 6);
    assert.equal(p.includeResearch, true);
    assert.equal(p.debug, false);
    assert.equal(p.topPick, false);
    assert.equal(p.lite, false);
  });

  it('numeric scalars honor provided finite values', () => {
    const p = planAggregateScreen(
      {
        limit: 5,
        maxPerMarket: 3,
        scanLimit: 7,
        lookbackHours: 12,
        includeResearch: false,
        debug: true,
        topPick: true,
        lite: true
      },
      { responseCache: cache }
    );
    assert.equal(p.limit, 5);
    assert.equal(p.maxPerMarket, 3);
    assert.equal(p.scanLimit, 7);
    assert.equal(p.lookbackHours, 12);
    assert.equal(p.includeResearch, false);
    assert.equal(p.debug, true);
    assert.equal(p.topPick, true);
    assert.equal(p.lite, true);
  });

  it('lite coerces args.compact=true and the fixed essential fields array', () => {
    const args = { lite: true };
    planAggregateScreen(args, { responseCache: cache });
    assert.equal(args.compact, true);
    assert.deepEqual(args.fields, [
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
    ]);
  });
});

describe('planAggregateScreen: aggregate cache key + lookup contract', () => {
  it('cache HIT returns the cached response with resultMeta.cached=true', () => {
    const cache = makeFakeCache();
    const args = { leagues: ['WNBA'], book: 'NoVigApp', limit: 3, validate: false, includeResearch: false };
    const miss = planAggregateScreen(args, { responseCache: cache });
    assert.equal(miss.cachedResponse, null);
    assert.ok(typeof miss.aggregateCacheKey === 'string' && miss.aggregateCacheKey.length > 0);

    // Seed the cache under the exact key the planner would compute.
    const sentinel = { ok: true, results: [{ seed: true }], resultMeta: { foo: 1 } };
    cache.set(miss.aggregateCacheKey, sentinel);

    const hit = planAggregateScreen(args, { responseCache: cache });
    assert.notEqual(hit.cachedResponse, null, 'identical args must hit the aggregate cache');
    assert.deepEqual(hit.cachedResponse.results, [{ seed: true }]);
    assert.equal(hit.cachedResponse.resultMeta.foo, 1);
    assert.equal(hit.cachedResponse.resultMeta.cached, true, 'cached marker must be set on the hit response');
  });

  it('request-shaping options change the cache key (no cross-contamination)', () => {
    const cache = makeFakeCache();
    const base = { leagues: ['WNBA'], book: 'NoVigApp', limit: 3, validate: false, includeResearch: false };
    const keyA = planAggregateScreen({ ...base, targetTiers: ['TIER 1'] }, { responseCache: cache }).aggregateCacheKey;
    const keyB = planAggregateScreen(
      { ...base, movement: ['supportive_bouncy'] },
      { responseCache: cache }
    ).aggregateCacheKey;
    assert.notEqual(keyA, keyB, 'different request-shaping options must produce distinct cache keys');
  });

  it('validate:true bypasses the aggregate cache (no key, no hit)', () => {
    const cache = makeFakeCache();
    const seeded = { ok: true, results: [], resultMeta: {} };
    // Manually seed a key-shaped string to prove validate:true never reads it.
    const args = { leagues: ['WNBA'], book: 'NoVigApp', limit: 3, validate: false, includeResearch: false };
    const key = planAggregateScreen(args, { responseCache: cache }).aggregateCacheKey;
    cache.set(key, seeded);

    const validating = planAggregateScreen(
      { leagues: ['WNBA'], book: 'NoVigApp', limit: 3, validate: true, includeResearch: false },
      { responseCache: cache }
    );
    assert.equal(validating.aggregateCacheKey, null, 'validate:true must not build an aggregate cache key');
    assert.equal(validating.cachedResponse, null, 'validate:true must not serve a cached response');
  });

  it('cache:false bypasses the aggregate cache', () => {
    const cache = makeFakeCache();
    const args = {
      leagues: ['WNBA'],
      book: 'NoVigApp',
      limit: 3,
      validate: false,
      includeResearch: false,
      cache: false
    };
    const plan = planAggregateScreen(args, { responseCache: cache });
    assert.equal(plan.aggregateCacheKey, null);
    assert.equal(plan.cachedResponse, null);
  });

  it('missing responseCache dependency never throws and yields a miss', () => {
    const plan = planAggregateScreen(
      { leagues: ['WNBA'], book: 'NoVigApp', limit: 3, validate: false, includeResearch: false },
      {}
    );
    assert.equal(plan.cachedResponse, null);
    assert.ok(typeof plan.aggregateCacheKey === 'string');
  });
});
