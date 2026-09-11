'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { resolveHistoryForEntity } = require('../lib/ssb-history');
const { hydrateScreenRowsWithHistory } = require('../lib/ssb-screen-history');

function exactTarget() {
  return {
    book: 'Pinnacle',
    pick: 'Carolina Hurricanes -1',
    game: 'Carolina Hurricanes vs Vegas Golden Knights',
    odds: '155',
    line1: -1,
    gameId: 'game-1',
    selectionId: 'Puck_Line:Carolina_Hurricanes_-1'
  };
}

function exactRow() {
  return {
    book: 'Pinnacle',
    pick: 'Carolina Hurricanes -1',
    game: 'Carolina Hurricanes vs Vegas Golden Knights',
    odds: '155',
    line1: -1,
    gameId: 'game-1',
    selectionId: 'Puck_Line:Carolina_Hurricanes_-1'
  };
}

// Native PP payload shape: book-keyed arrays, entries {odds,start_ts,end_ts,liquidity}, no line field.
function nativePayload() {
  return {
    Pinnacle: [
      { odds: 155, start_ts: 1781397799293, end_ts: 1781404059458, liquidity: 0 },
      { odds: 150, start_ts: 1781404060668, end_ts: 1781404100000, liquidity: 0 }
    ]
  };
}

describe('native PP selection-scoped price-history provenance', () => {
  it('marks exact selection scope usable with >=2 timestamped odds points', async () => {
    const result = await resolveHistoryForEntity({
      client: {},
      target: exactTarget(),
      rows: [exactRow()],
      queryHistoryFn: async () => nativePayload()
    });
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.priceHistoryUsable, true);
    assert.equal(result.priceHistoryScope, 'selection_id');
    assert.equal(result.priceHistorySource, 'odds_history');
    assert.equal(result.priceHistoryPointCount, 2);
    // Line semantics preserved: backfilled from row line1, count surfaced.
    assert.equal(result.lineFieldMissingCount, 2);
  });

  it('preserves moneyline null lines and still marks price usable', async () => {
    const target = {
      book: 'Pinnacle',
      pick: 'Carolina Hurricanes',
      game: 'Carolina Hurricanes vs Vegas Golden Knights',
      odds: '-113',
      line1: null,
      gameId: 'game-1',
      selectionId: 'Moneyline:Carolina_Hurricanes'
    };
    const row = { ...target };
    const result = await resolveHistoryForEntity({
      client: {},
      target,
      rows: [row],
      queryHistoryFn: async () => ({
        Pinnacle: [
          { odds: -113, start_ts: 1, end_ts: 2, liquidity: 100 },
          { odds: -114, start_ts: 3, end_ts: 4, liquidity: 200 }
        ]
      })
    });
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.lineFieldMissingCount, 0);
    for (const entry of result.lineHistory) assert.equal(entry.line, null);
    assert.equal(result.priceHistoryUsable, true);
    assert.equal(result.priceHistoryScope, 'selection_id');
    assert.equal(result.priceHistoryPointCount, 2);
  });

  it('requires numeric parseable timestamps: single timestamped point is not usable', async () => {
    const result = await resolveHistoryForEntity({
      client: {},
      target: exactTarget(),
      rows: [exactRow()],
      queryHistoryFn: async () => ({
        Pinnacle: [
          { odds: 155, start_ts: 1781397799293, end_ts: 1781404059458, liquidity: 0 },
          // No start_ts/end_ts/time: normalizeHistoryPoint time falls back to null.
          { odds: 150, liquidity: 0 }
        ]
      })
    });
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(typeof result.priceHistoryPointCount, 'number');
    assert.equal(result.priceHistoryPointCount, 1);
    assert.equal(result.priceHistoryUsable, false);
    assert.equal(result.priceHistoryScope, null);
    assert.equal(result.priceHistorySource, null);
  });

  it('does not mark gameId-only match as selection scoped', async () => {
    const result = await resolveHistoryForEntity({
      client: {},
      target: { ...exactTarget() },
      rows: [
        {
          book: 'Pinnacle',
          pick: 'Carolina Hurricanes -1',
          game: 'Carolina Hurricanes vs Vegas Golden Knights',
          odds: '155',
          line1: -1,
          gameId: 'game-1',
          selectionId: 'Puck_Line:Other_Team_-1'
        }
      ],
      queryHistoryFn: async () => nativePayload()
    });
    // gameId fallback still resolves line history but must not claim selection scope.
    if (result.lineHistoryAvailable) {
      assert.equal(result.priceHistoryUsable, false);
      assert.equal(result.priceHistoryScope, null);
    } else {
      assert.equal(result.priceHistoryUsable, false);
    }
  });

  it('carries priceHistory metadata through successful screen hydration', async () => {
    const client = { queryOddsHistory: async () => nativePayload() };
    const rows = [exactRow()];
    const out = await hydrateScreenRowsWithHistory(rows, { client, enableLineFallback: false });
    assert.equal(out.length, 1);
    assert.equal(out[0].lineHistoryAvailable, true);
    assert.equal(out[0].priceHistoryUsable, true);
    assert.equal(out[0].priceHistoryScope, 'selection_id');
    assert.equal(out[0].priceHistorySource, 'odds_history');
    assert.equal(out[0].priceHistoryPointCount, 2);
  });

  it('carries degraded priceHistory defaults without promoting line history', async () => {
    const client = {
      queryOddsHistory: async () => {
        throw new Error('boom');
      }
    };
    const rows = [exactRow()];
    const out = await hydrateScreenRowsWithHistory(rows, { client, enableLineFallback: false });
    assert.equal(out.length, 1);
    assert.equal(out[0].lineHistoryAvailable, false);
    assert.equal(out[0].priceHistoryUsable, false);
    assert.equal(out[0].priceHistoryScope, null);
    assert.equal(out[0].priceHistorySource, null);
    assert.equal(typeof out[0].priceHistoryPointCount, 'number');
  });
});
