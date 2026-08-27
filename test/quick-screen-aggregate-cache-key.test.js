'use strict';

// Regression tests: the aggregate quick_screen response cache key must
// incorporate request-shaping options so a response produced for one option
// set can NEVER be reused for a different option set.
//
// Defect: the aggregate cache key only encoded leagues/markets/books/limit/
// cardWindow/includeProps. Request-shaping options (targetTiers, kaiCall,
// movement, minEV, verbosity, includeResearch, lite) were ignored, so e.g. a
// TIER 1-only request could be served a cached TIER 1+TIER 2 response.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');

function makeHandlers() {
  let sharpPlaysCalls = 0;
  const handlers = createMcpHandlers({ client: {} });
  handlers.sharp_plays = async () => {
    sharpPlaysCalls++;
    return {
      ok: true,
      result: [
        {
          league: 'WNBA',
          market: 'Moneyline',
          candidates: [
            {
              gameId: 'g1',
              selection: 'Team A',
              screenScore: 80,
              confidenceTier: 'TIER 1',
              kaiCall: 'BET',
              odds: -110,
              consensusEdge: 1.5,
              movementDisposition: 'supportive_clean',
              riskScore: 1,
              research: []
            }
          ]
        }
      ]
    };
  };
  handlers.screen_ranked = async () => ({
    ok: true,
    result: [
      {
        gameId: 'g1',
        selection: 'Team A',
        screenScore: 80,
        confidenceTier: 'TIER 1',
        kaiCall: 'BET',
        odds: -110,
        consensusEdge: 1.5,
        movementDisposition: 'supportive_clean',
        riskScore: 1,
        research: []
      }
    ]
  });
  return { handlers, getCallCount: () => sharpPlaysCalls };
}

// Each entry: a single request-shaping option that must force a cache miss
// (re-fan-out) when changed between two otherwise-identical quick_screen calls.
const OPTION_VARIANTS = [
  { name: 'targetTiers', a: { targetTiers: ['TIER 1'] }, b: { targetTiers: ['TIER 2'] } },
  { name: 'kaiCall', a: { kaiCall: ['BET'] }, b: { kaiCall: ['CONSIDER'] } },
  { name: 'movement', a: { movement: ['supportive_clean'] }, b: { movement: ['supportive_bouncy'] } },
  { name: 'minEV', a: { minEV: 1 }, b: { minEV: 5 } },
  { name: 'verbosity', a: { verbosity: 'full' }, b: { verbosity: 'minimal' } },
  { name: 'includeResearch', a: { includeResearch: false }, b: { includeResearch: true } },
  { name: 'lite', a: { lite: false }, b: { lite: true } }
];

describe('quick_screen aggregate cache key covers request-shaping options', () => {
  for (const variant of OPTION_VARIANTS) {
    it(`re-fans-out when ${variant.name} differs (does not reuse cached response)`, async () => {
      const { handlers, getCallCount } = makeHandlers();
      const base = {
        leagues: ['WNBA'],
        book: 'NoVigApp',
        limit: 3,
        validate: false,
        includeResearch: false
      };

      await handlers.quick_screen({ ...base, ...variant.a });
      const afterFirst = getCallCount();
      assert.ok(afterFirst > 0, 'first call should fan out');

      await handlers.quick_screen({ ...base, ...variant.b });
      assert.ok(getCallCount() > afterFirst, `changing ${variant.name} should miss the aggregate cache and re-fan-out`);
    });
  }

  it('does NOT cross-contaminate: a cached option-A response is not served for option-B', async () => {
    const { handlers, getCallCount } = makeHandlers();
    const base = {
      leagues: ['WNBA'],
      book: 'NoVigApp',
      limit: 3,
      validate: false,
      includeResearch: false
    };

    // Prime a cache entry under option set A, then issue option set B. B must
    // re-fan-out (distinct key) rather than be served A's (differently-shaped)
    // cached response.
    await handlers.quick_screen({ ...base, targetTiers: ['TIER 1'] });
    const afterA = getCallCount();
    assert.ok(afterA > 0);

    await handlers.quick_screen({ ...base, movement: ['supportive_bouncy'] });
    assert.ok(
      getCallCount() > afterA,
      'a different option set must miss the aggregate cache and re-fan-out (no cross-contamination)'
    );
  });

  it('baseline (no request-shaping options) still caches identically', async () => {
    const { handlers, getCallCount } = makeHandlers();
    const args = { leagues: ['WNBA'], book: 'NoVigApp', limit: 3, validate: false, includeResearch: false };

    await handlers.quick_screen(args);
    const firstCallCount = getCallCount();
    assert.ok(firstCallCount > 0);

    const r2 = await handlers.quick_screen(args);
    assert.equal(getCallCount(), firstCallCount, 'identical no-option requests should cache (no regression)');
    assert.equal(r2.resultMeta?.cached, true, 'repeat no-option call should be cached');
  });
});
