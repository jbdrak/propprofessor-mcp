'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { createMockClient } = require('./fixtures/mock-client');

describe('get_play_details: all markets when market omitted (Task 3)', () => {
  it('fans out across the league default markets and merges rows', async () => {
    const { client, calls } = createMockClient();
    const handlers = createMcpHandlers({ client });
    const result = await handlers.get_play_details({
      league: 'NBA',
      gameIds: ['NBA:PREMATCH:Lakers:Celtics:1783807200']
      // no market arg
    });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.result), 'result is an array');
    // Should have queried the backend once per default market (Moneyline/Spread/Total).
    const screenCalls = calls.queryScreenOddsBestComps;
    const distinctMarkets = [...new Set(screenCalls.map((c) => c.market))];
    assert.ok(distinctMarkets.includes('Moneyline'), 'queried Moneyline');
    assert.ok(distinctMarkets.includes('Point Spread'), 'queried Point Spread');
    assert.ok(distinctMarkets.includes('Total Points'), 'queried Total Points');
    assert.equal(result.resultMeta.marketsQueried.length, 3, 'reports 3 markets queried');
    assert.equal(result.resultMeta.matchedRows, result.result.length);
  });

  it('does NOT fan out when an explicit market is given', async () => {
    const { client, calls } = createMockClient();
    const handlers = createMcpHandlers({ client });
    await handlers.get_play_details({
      league: 'NBA',
      gameIds: ['NBA:PREMATCH:Lakers:Celtics:1783807200'],
      market: 'Moneyline'
    });
    const screenCalls = calls.queryScreenOddsBestComps;
    const distinctMarkets = [...new Set(screenCalls.map((c) => c.market))];
    assert.deepEqual(distinctMarkets, ['Moneyline'], 'only Moneyline queried');
  });
});
