'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { createMockClient } = require('./fixtures/mock-client');

const GAME_ID = 'Tennis:PREMATCH:Borges:Hanfmann:1786017600';

function makePayload(rowGameId = GAME_ID) {
  const nested = {
    over22: {
      selection1: 'Over',
      selection2: 'Under',
      selection1Id: 'Total Games:Over_22.5',
      selection2Id: 'Total Games:Under_22.5',
      line1: 22.5,
      line2: 22.5,
      odds: {
        NoVigApp: { odds1: -120, odds2: 100, liquidity1: 18, liquidity2: 12 },
        Pinnacle: { odds1: -115, odds2: -105, liquidity1: 900, liquidity2: 900 }
      }
    },
    over20: {
      selection1: 'Over',
      selection2: 'Under',
      selection1Id: 'Total Games:Over_20.5',
      selection2Id: 'Total Games:Under_20.5',
      line1: 20.5,
      line2: 20.5,
      odds: {
        NoVigApp: { odds1: -130, odds2: 110, liquidity1: 18, liquidity2: 12 },
        Pinnacle: { odds1: -125, odds2: 105, liquidity1: 900, liquidity2: 900 }
      }
    }
  };
  return {
    rows: [
      {
        gameId: rowGameId,
        league: 'Tennis',
        market: 'Total Games',
        selection: 'Over',
        line: 22.5,
        selectionId: 'Total Games:Over_22.5',
        homeTeam: 'Hanfmann',
        awayTeam: 'Borges',
        start: new Date(Date.now() + 3600000).toISOString(),
        selections: nested
      }
    ]
  };
}

function makeHandlers(rowGameId) {
  const { client } = createMockClient({ screenPayloads: { 'Tennis:Total Games': makePayload(rowGameId) } });
  return createMcpHandlers({ client });
}

describe('get_play_details exact selection filter', () => {
  it('materializes an exact nested side before the per-game ranking cap', async () => {
    const nestedOnly = {
      selection1: 'Over',
      selection2: 'Under',
      selection1Id: 'Total Games:Over_23.5',
      selection2Id: 'Total Games:Under_23.5',
      line1: 23.5,
      line2: 23.5,
      odds: {
        NoVigApp: { odds1: 117, odds2: -137, liquidity1: 46, liquidity2: 31 },
        Pinnacle: { odds1: 110, odds2: -130, liquidity1: 900, liquidity2: 900 }
      }
    };
    const rows = Array.from({ length: 5 }, (_, index) => ({
      gameId: GAME_ID,
      league: 'Tennis',
      market: 'Total Games',
      selection: 'Over',
      line: 18.5 + index,
      selectionId: `Total Games:Over_${18.5 + index}`,
      homeTeam: 'Hanfmann',
      awayTeam: 'Borges',
      start: new Date(Date.now() + 3600000).toISOString(),
      sportsbookData: [{ book: 'NoVigApp', odds: -200 + index, liquidityUsd: 500 + index }],
      selections: { nestedOnly }
    }));
    const { client } = createMockClient({
      screenPayloads: { 'Tennis:Total Games': { rows } }
    });
    const handlers = createMcpHandlers({ client });

    const result = await handlers.get_play_details({
      league: 'Tennis',
      market: 'Total Games',
      gameIds: [GAME_ID],
      books: ['NoVigApp'],
      selection: 'Over 23.5'
    });

    assert.equal(result.result.length, 1);
    assert.equal(result.resultMeta.selectionMatchedNested, undefined);
    assert.equal(result.result[0].selection, 'Over');
    assert.equal(result.result[0].line, 23.5);
    assert.equal(result.result[0].selectionId, 'Total Games:Over_23.5');
    assert.equal(result.result[0].odds, 117);
    assert.equal(result.result[0].liquidityUsd, 46);
    assert.equal(result.result[0].gameId, GAME_ID);
    assert.equal(result.result[0].market, 'Total Games');
  });

  it('uses a direct focus-book query when BestComps lacks the exact quote', async () => {
    const nested = {
      selection1: 'Over',
      selection2: 'Under',
      selection1Id: 'Total Games:Over_23.5',
      selection2Id: 'Total Games:Under_23.5',
      line1: 23.5,
      line2: 23.5
    };
    const bestCompsPayload = {
      rows: [
        {
          gameId: GAME_ID,
          league: 'Tennis',
          market: 'Total Games',
          selection: 'Over',
          line: 22.5,
          selectionId: 'Total Games:Over_22.5',
          homeTeam: 'Hanfmann',
          awayTeam: 'Borges',
          start: new Date(Date.now() + 3600000).toISOString(),
          selections: { over23: nested }
        }
      ]
    };
    const directPayload = {
      rows: [
        {
          ...bestCompsPayload.rows[0],
          selection: 'Over',
          line: 23.5,
          selectionId: 'Total Games:Over_23.5',
          selections: {
            over23: {
              ...nested,
              odds: { NoVigApp: { odds1: 117, odds2: -178, liquidity1: 46, liquidity2: 499 } }
            }
          }
        }
      ]
    };
    const { client, calls } = createMockClient({ screenPayloads: { 'Tennis:Total Games': bestCompsPayload } });
    client.queryScreenOdds = (args) => {
      calls.queryScreenOdds.push(args);
      return Promise.resolve(directPayload);
    };

    const handlers = createMcpHandlers({ client });
    const result = await handlers.get_play_details({
      league: 'Tennis',
      market: 'Total Games',
      gameIds: [GAME_ID],
      books: ['NoVigApp'],
      selection: 'Over 23.5'
    });

    assert.equal(calls.queryScreenOdds.length, 1);
    assert.equal(calls.queryScreenOddsBestComps.length, 1);
    assert.deepEqual(calls.queryScreenOdds[0].books, ['NoVigApp']);
    assert.equal(result.result.length, 1);
    assert.equal(result.result[0].selectionId, 'Total Games:Over_23.5');
    assert.equal(result.result[0].line, 23.5);
    assert.equal(result.result[0].book, 'NoVigApp');
    assert.equal(result.result[0].odds, 117);
    assert.equal(result.result[0].liquidityUsd, 46);
  });

  it('returns only the requested exact top-level line', async () => {
    const result = await makeHandlers().get_play_details({
      league: 'Tennis',
      market: 'Total Games',
      gameIds: [GAME_ID],
      books: ['NoVigApp'],
      selection: 'Over 22.5'
    });

    assert.equal(result.resultMeta.selectionFilter, 'Over 22.5');
    assert.equal(result.resultMeta.matchedRows, 1);
    assert.equal(result.result.length, 1);
    assert.equal(result.result[0].selectionId, 'Total Games:Over_22.5');
    assert.ok(result.result[0].selections, 'nested line map is preserved');
  });

  it('uses the requested focus book for the exact top-level quote', async () => {
    const result = await makeHandlers().get_play_details({
      league: 'Tennis',
      market: 'Total Games',
      gameIds: [GAME_ID],
      books: ['NoVigApp'],
      selection: 'Over 22.5'
    });

    const row = result.result[0];
    assert.equal(row.book, 'NoVigApp');
    assert.equal(row.odds, -120);
    assert.equal(row.targetBookOdds, -120);
    assert.equal(row.liquidityUsd, 18);
  });

  it('preserves broad game lookup when no selection is supplied', async () => {
    const result = await makeHandlers().get_play_details({
      league: 'Tennis',
      market: 'Total Games',
      gameIds: [GAME_ID],
      books: ['NoVigApp']
    });

    assert.equal(result.resultMeta.selectionFilter, undefined);
    assert.equal(result.result.length, 4);
  });

  it('matches a backend row when its game ID omits the embedded start timestamp', async () => {
    const baseGameId = GAME_ID.replace(/:\d{10,}$/, '');
    const result = await makeHandlers(baseGameId).get_play_details({
      league: 'Tennis',
      market: 'Total Games',
      gameIds: [GAME_ID],
      books: ['NoVigApp']
    });

    assert.equal(result.resultMeta.matchedRows, 4);
    assert.equal(result.result.length, 4);
  });

  it('fails closed when the exact line is not present', async () => {
    const result = await makeHandlers().get_play_details({
      league: 'Tennis',
      market: 'Total Games',
      gameIds: [GAME_ID],
      books: ['NoVigApp'],
      selection: 'Over 24.5'
    });

    assert.deepEqual(result.result, []);
    assert.equal(result.resultMeta.matchedRows, 0);
    assert.equal(result.resultMeta.selectionNotFound, true);
    assert.equal(result.resultMeta.errorCode, 'SELECTION_NOT_FOUND');
  });
});
