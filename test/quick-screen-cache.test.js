'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');

function makeHandlers() {
  let sharpPlaysCalls = 0;
  const handlers = createMcpHandlers({ client: {} });
  // quick_screen fans out through sharp_plays internally
  handlers.sharp_plays = async () => {
    sharpPlaysCalls++;
    return { ok: true, results: [{ league: 'WNBA', market: 'Moneyline', candidates: [] }] };
  };
  // stub downstream helpers so the handler doesn't crash
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

describe('quick_screen response caching', () => {
  it('returns cached result on repeat call without re-fanning out', async () => {
    const { handlers, getCallCount } = makeHandlers();
    const args = { leagues: ['WNBA'], book: 'NoVigApp', limit: 3, validate: false, includeResearch: false };

    const r1 = await handlers.quick_screen(args);
    assert.equal(r1.ok, true);
    const firstCallCount = getCallCount();
    assert.ok(firstCallCount > 0, 'first call should fan out');

    const r2 = await handlers.quick_screen(args);
    assert.equal(r2.ok, true);
    assert.equal(getCallCount(), firstCallCount, 'second call with identical args should NOT re-fan-out');
    assert.equal(r2.resultMeta?.cached, true, 'second call should be marked cached');
  });

  it('does NOT cache when args differ', async () => {
    const { handlers, getCallCount } = makeHandlers();
    const baseArgs = { book: 'NoVigApp', limit: 3, validate: false, includeResearch: false };

    await handlers.quick_screen({ ...baseArgs, leagues: ['WNBA'] });
    const afterFirst = getCallCount();
    assert.ok(afterFirst > 0);

    await handlers.quick_screen({ ...baseArgs, leagues: ['NBA'] });
    assert.ok(getCallCount() > afterFirst, 'different leagues should miss cache and re-fan-out');
  });

  it('bypasses cache when validate:true', async () => {
    const { handlers, getCallCount } = makeHandlers();
    const args = { leagues: ['WNBA'], book: 'NoVigApp', limit: 3, validate: false, includeResearch: false };

    await handlers.quick_screen(args);
    const afterFirst = getCallCount();
    assert.ok(afterFirst > 0);

    await handlers.quick_screen({ ...args, validate: true });
    assert.ok(getCallCount() > afterFirst, 'validate:true should bypass cache and re-fetch');
  });
});
