'use strict';

// Regression test: screen_ranked's canonical-cache path MUST invoke the
// memoized callable and return the underlying handler's RESPONSE, not the
// memoized function itself.
//
// Defect: `canonicalScreenCache.memoize(fn, key)` returns a callable. The
// handler returned it WITHOUT invoking it, so callers `await`-ing
// screen_ranked received a function (functions are not thenable) instead of
// the ranked-screen response.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');

describe('screen_ranked canonical cache memoize path', () => {
  it('invokes runScreenRankedImpl and returns the response object (not the memoized fn)', async () => {
    const handlers = createMcpHandlers({ client: {} });
    const expected = {
      ok: true,
      result: [{ gameId: 'g1', selection: 'Team A', confidenceTier: 'TIER 1' }]
    };
    // Override the underlying impl so we detect whether it was actually called
    // AND whether its return value is what screen_ranked surfaces.
    handlers.runScreenRankedImpl = async () => expected;

    const res = await handlers.screen_ranked({
      gameId: 'g1',
      league: 'NBA',
      market: 'Moneyline',
      books: ['NoVigApp']
    });

    assert.equal(typeof res, 'object', 'screen_ranked must return the ranked response object, not a function');
    assert.deepEqual(res, expected, 'screen_ranked must surface the impl response, not the memoized fn');
  });

  it('does not return a function even when the canonical key is reused', async () => {
    const handlers = createMcpHandlers({ client: {} });
    const expected = { ok: true, result: [{ gameId: 'g1' }] };
    handlers.runScreenRankedImpl = async () => expected;

    // Same args => same canonical key => second call hits the memoized path.
    await handlers.screen_ranked({ gameId: 'g1', league: 'NBA', market: 'Moneyline' });
    const res2 = await handlers.screen_ranked({ gameId: 'g1', league: 'NBA', market: 'Moneyline' });

    assert.equal(typeof res2, 'object', 'cached path must also return the response, not a function');
    assert.deepEqual(res2, expected);
  });
});
