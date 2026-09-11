'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { rankLeagueScreenRows } = require('../lib/screen-ranker');

// Selection-scoped price history is usable, but only a single line-less sharp
// point exists, so clvProxyPct is null while movementHistoryUsable is true.
// Regression: buildScreenRankingReason interpolated clvProxyPct.toFixed(2)
// unguarded and threw a TypeError, killing the whole rank/scan call.
function nullClvPriceHistoryRow() {
  return {
    gameId: 'Tennis:GAME:Dencheva:Jones:1788940800',
    league: 'Tennis',
    market: 'Moneyline',
    selection: 'Dencheva',
    selectionId: 'Moneyline:Dencheva',
    line: null,
    book: 'NoVigApp',
    odds: -111,
    currentOdds: -111,
    targetBookOdds: -111,
    consensusBookCount: 5,
    consensusEdge: 1.2,
    executionQuality: 'best',
    liquidityUsd: 46,
    lineHistory: [{ book: 'Pinnacle', odds: -120, line: null, time: Date.UTC(2026, 4, 6, 11, 0, 0) }],
    lineHistoryAvailable: false,
    lineHistoryUsable: false,
    lineFieldMissingCount: 1,
    priceHistoryUsable: true,
    priceHistoryScope: 'selection_id',
    priceHistorySource: 'odds_history',
    priceHistoryPointCount: 1
  };
}

describe('rankLeagueScreenRows tolerates null CLV with usable price history', () => {
  it('does not throw when movementHistoryUsable is true but clvProxyPct is null', () => {
    let rows;
    assert.doesNotThrow(() => {
      rows = rankLeagueScreenRows([nullClvPriceHistoryRow()], {
        league: 'Tennis',
        market: 'Moneyline',
        books: ['NoVigApp'],
        includeAll: true
      });
    });
    assert.equal(rows.length, 1, 'row must survive ranking');
    assert.equal(rows[0].movementHistoryUsable, true);
    assert.equal(rows[0].clvProxyPct, null);
    assert.ok(
      typeof rows[0].rankingReason === 'string' && rows[0].rankingReason.length > 0,
      'rankingReason must still be produced'
    );
    assert.ok(
      !/undefined|NaN/.test(rows[0].rankingReason),
      `rankingReason must not leak undefined/NaN: ${rows[0].rankingReason}`
    );
  });
});
