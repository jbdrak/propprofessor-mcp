'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { createMockClient } = require('./fixtures/mock-client');

const GAME_ID = 'Tennis:PREMATCH:Borges:Hanfmann:1786017600';

function nestedWith(requestedBook, { odds1, odds2, liquidity1, liquidity2 }) {
  return {
    over23: {
      selection1: 'Over',
      selection2: 'Under',
      selection1Id: 'Total Games:Over_23.5',
      selection2Id: 'Total Games:Under_23.5',
      line1: 23.5,
      line2: 23.5,
      odds: {
        [requestedBook]: { odds1, odds2, liquidity1, liquidity2 }
      }
    }
  };
}

function rowWith(requestedBook, odds, liquidity) {
  return {
    gameId: GAME_ID,
    league: 'Tennis',
    market: 'Total Games',
    selection: 'Over',
    line: 23.5,
    selectionId: 'Total Games:Over_23.5',
    homeTeam: 'Hanfmann',
    awayTeam: 'Borges',
    start: new Date(Date.now() + 3600000).toISOString(),
    selections: nestedWith(requestedBook, {
      odds1: odds,
      odds2: -137,
      liquidity1: liquidity,
      liquidity2: 31
    })
  };
}

function runHandlers(rows, requestedBook) {
  const { client } = createMockClient({
    screenPayloads: { 'Tennis:Total Games': { rows } }
  });
  return createMcpHandlers({ client }).get_play_details({
    league: 'Tennis',
    market: 'Total Games',
    gameIds: [GAME_ID],
    books: [requestedBook],
    selection: 'Over 23.5'
  });
}

describe('play-details exact quote integrity (materializeExactSelectionRows)', () => {
  it('rejects zero American odds rather than inventing an even-money quote', async () => {
    const result = await runHandlers([rowWith('NoVigApp', 0, 46)], 'NoVigApp');
    assert.equal(result.resultMeta.matchedRows, 0);
  });
  it('uses exact requested-book nested price instead of a conflicting top-level quote', async () => {
    const row = { ...rowWith('NoVigApp', 117, 46), book: 'Pinnacle', odds: -150 };
    const result = await runHandlers([row], 'NoVigApp');
    assert.equal(result.resultMeta.matchedRows, 1);
    assert.equal(result.result[0].book, 'NoVigApp');
    assert.equal(result.result[0].odds, 117);
  });
  it('does NOT materialize a row when the requested side odds are null', async () => {
    const result = await runHandlers([rowWith('NoVigApp', null, 46)], 'NoVigApp');
    assert.equal(result.resultMeta.matchedRows, 0, 'null requested-side odds must not fabricate a quote');
    assert.deepEqual(result.result, []);
  });

  it('does NOT materialize a row when the requested side odds are undefined', async () => {
    const row = {
      gameId: GAME_ID,
      league: 'Tennis',
      market: 'Total Games',
      selection: 'Over',
      line: 23.5,
      selectionId: 'Total Games:Over_23.5',
      start: new Date(Date.now() + 3600000).toISOString(),
      selections: {
        over23: {
          selection1: 'Over',
          selection2: 'Under',
          selection1Id: 'Total Games:Over_23.5',
          selection2Id: 'Total Games:Under_23.5',
          line1: 23.5,
          line2: 23.5,
          odds: { NoVigApp: { odds2: -137, liquidity2: 31 } } // no odds1
        }
      }
    };
    const result = await runHandlers([row], 'NoVigApp');
    assert.equal(result.resultMeta.matchedRows, 0);
    assert.deepEqual(result.result, []);
  });

  it('does NOT materialize a row when the requested side odds are an empty string', async () => {
    const result = await runHandlers([rowWith('NoVigApp', '', 46)], 'NoVigApp');
    assert.equal(result.resultMeta.matchedRows, 0);
    assert.deepEqual(result.result, []);
  });

  it('does NOT materialize a row when the requested side odds are a boolean', async () => {
    const result = await runHandlers([rowWith('NoVigApp', true, 46)], 'NoVigApp');
    assert.equal(result.resultMeta.matchedRows, 0);
    assert.deepEqual(result.result, []);
  });

  it('preserves genuine zero liquidity and does NOT fabricate 0 from null liquidity', async () => {
    // To exercise the materialized path (where liquidity is computed), the row's
    // TOP-LEVEL selection must NOT match the needle (so the early exactRows
    // shortcut skips it) while its nested side DOES match with valid odds.
    function materializedRow(requestedBook, odds, liquidity) {
      return {
        gameId: GAME_ID,
        league: 'Tennis',
        market: 'Total Games',
        selection: 'Over',
        line: 18.5, // does NOT match 'Over 23.5' at top level
        selectionId: 'Total Games:Over_18.5',
        start: new Date(Date.now() + 3600000).toISOString(),
        selections: {
          over23: {
            selection1: 'Over',
            selection2: 'Under',
            selection1Id: 'Total Games:Over_23.5',
            selection2Id: 'Total Games:Under_23.5',
            line1: 23.5,
            line2: 23.5,
            odds: { [requestedBook]: { odds1: odds, odds2: -137, liquidity1: liquidity, liquidity2: 31 } }
          }
        }
      };
    }
    // odds present, liquidity null -> liquidityUsd must stay null, not 0
    const nullLiq = await runHandlers([materializedRow('NoVigApp', 117, null)], 'NoVigApp');
    assert.equal(nullLiq.resultMeta.matchedRows, 1);
    assert.equal(nullLiq.result[0].odds, 117);
    // null/undefined liquidity is honestly absent (field stripped by the row
    // serializer), never fabricated to 0.
    assert.equal(
      Object.prototype.hasOwnProperty.call(nullLiq.result[0], 'liquidityUsd'),
      false,
      'null liquidity must stay unknown (not fabricated to 0)'
    );

    // odds present, liquidity 0 -> genuine zero must be preserved
    const zeroLiq = await runHandlers([materializedRow('NoVigApp', 117, 0)], 'NoVigApp');
    assert.equal(zeroLiq.resultMeta.matchedRows, 1);
    assert.equal(zeroLiq.result[0].liquidityUsd, 0, 'genuine zero liquidity preserved');
  });

  it('isolates the requested book: absent requested side but present opposite book does not materialize', async () => {
    const row = {
      gameId: GAME_ID,
      league: 'Tennis',
      market: 'Total Games',
      selection: 'Over',
      line: 23.5,
      selectionId: 'Total Games:Over_23.5',
      start: new Date(Date.now() + 3600000).toISOString(),
      selections: {
        over23: {
          selection1: 'Over',
          selection2: 'Under',
          selection1Id: 'Total Games:Over_23.5',
          selection2Id: 'Total Games:Under_23.5',
          line1: 23.5,
          line2: 23.5,
          odds: {
            // requested book NoVigApp has NO odds for either side
            NoVigApp: { liquidity1: 46, liquidity2: 31 },
            Pinnacle: { odds1: 110, odds2: -130, liquidity1: 900, liquidity2: 900 }
          }
        }
      }
    };
    const result = await runHandlers([row], 'NoVigApp');
    assert.equal(result.resultMeta.matchedRows, 0, 'must not materialize another book quote as the requested book');
    assert.deepEqual(result.result, []);
  });

  it('does not misassign the opposite side odds/liquidity to the requested side', async () => {
    const row = {
      gameId: GAME_ID,
      league: 'Tennis',
      market: 'Total Games',
      selection: 'Over',
      line: 23.5,
      selectionId: 'Total Games:Over_23.5',
      start: new Date(Date.now() + 3600000).toISOString(),
      selections: {
        over23: {
          selection1: 'Over',
          selection2: 'Under',
          selection1Id: 'Total Games:Over_23.5',
          selection2Id: 'Total Games:Under_23.5',
          line1: 23.5,
          line2: 23.5,
          odds: {
            NoVigApp: { odds1: 117, odds2: -137, liquidity1: 46, liquidity2: 31 }
          }
        }
      }
    };
    const result = await runHandlers([row], 'NoVigApp');
    assert.equal(result.resultMeta.matchedRows, 1);
    const r = result.result[0];
    // requested side is Over = side 1 -> odds1/liquidity1
    assert.equal(r.odds, 117);
    assert.equal(r.currentOdds, 117);
    assert.equal(r.targetBookOdds, 117);
    assert.equal(r.liquidityUsd, 46, 'side 1 must use liquidity1, never liquidity2 (31)');
  });
});
