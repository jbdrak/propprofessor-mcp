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

  it('uses the exact selected line and side for oddsMatrix', async () => {
    const gameId = 'mlb-20260908-tor-ath';
    const rows = [
      {
        gameId,
        league: 'MLB',
        market: 'Total Runs',
        homeTeam: 'Athletics',
        awayTeam: 'Toronto Blue Jays',
        book: 'Fliff',
        selection: 'Under',
        selectionId: 'Total Runs:Under_9.5',
        line: 9.5,
        odds: -125,
        currentOdds: -125,
        targetBookOdds: -125,
        // Put the alternate line first to reproduce the bad first-match behavior.
        selections: {
          alt125: {
            selection1: 'Over 12.5',
            selection2: 'Under 12.5',
            selection1Id: 'Total Runs:Over_12.5',
            selection2Id: 'Total Runs:Under_12.5',
            line1: 12.5,
            line2: 12.5,
            odds: { Fliff: { odds1: 245, odds2: -355 } }
          },
          exact95: {
            selection1: 'Over 9.5',
            selection2: 'Under 9.5',
            selection1Id: 'Total Runs:Over_9.5',
            selection2Id: 'Total Runs:Under_9.5',
            line1: 9.5,
            line2: 9.5,
            odds: { Fliff: { odds1: 100, odds2: -125 } }
          }
        }
      }
    ];
    const { client } = createMockClient({
      screenPayloads: { 'MLB:Total Runs': { rows } }
    });
    const handlers = createMcpHandlers({ client });
    const result = await handlers.get_play_details({
      league: 'MLB',
      gameIds: [gameId],
      market: 'Total Runs',
      books: ['Fliff'],
      selection: 'Under 9.5'
    });

    assert.equal(result.ok, true);
    assert.equal(result.result.length, 1);
    assert.equal(result.result[0].targetBookOdds, -125);
    assert.equal(result.result[0].oddsMatrix.Fliff, -125);
    assert.notEqual(result.result[0].oddsMatrix.Fliff, 245);
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
