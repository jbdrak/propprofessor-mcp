'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { createMockClient } = require('./fixtures/mock-client');

describe('get_play_details: oddsMatrix enrichment (Task 4)', () => {
  it('adds a per-book oddsMatrix to result rows', async () => {
    const { client } = createMockClient();
    const handlers = createMcpHandlers({ client });
    const result = await handlers.get_play_details({
      league: 'NBA',
      gameIds: ['nba-20260610-lal-bos'],
      market: 'Moneyline'
    });
    assert.equal(result.ok, true);
    assert.ok(result.result.length > 0, 'should have rows');
    const rowWithMatrix = result.result.find((r) => r.oddsMatrix && Object.keys(r.oddsMatrix).length);
    assert.ok(rowWithMatrix, 'at least one row should carry an oddsMatrix');
    // The fixture has NoVigApp/Pinnacle/Circa with odds1 values.
    assert.ok(rowWithMatrix.oddsMatrix.NoVigApp !== undefined, 'NoVigApp odds present');
    assert.ok(Number.isFinite(rowWithMatrix.oddsMatrix.NoVigApp), 'NoVigApp odds is a number');
  });

  it('omits oddsMatrix when no per-book odds are available', async () => {
    const { client } = createMockClient();
    client.queryScreenOddsBestComps = async () => ({ rows: [] });
    const handlers = createMcpHandlers({ client });
    const result = await handlers.get_play_details({
      league: 'NBA',
      gameIds: ['nba-20260610-lal-bos'],
      market: 'Moneyline'
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, []);
    assert.equal(result.resultMeta.matchedRows, 0);
  });
});
