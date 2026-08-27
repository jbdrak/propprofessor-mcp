'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getTennisMarketFamily,
  isTennisRow,
  normalizeTennisHistoryResponse,
  normalizeTennisHistoryItems
} = require('../lib/screen-tennis');

describe('getTennisMarketFamily', () => {
  it('maps Moneyline / ml', () => {
    assert.equal(getTennisMarketFamily({ market: 'Moneyline' }), 'moneyline');
    assert.equal(getTennisMarketFamily({ market: 'ML' }), 'moneyline');
  });

  it('maps Set Handicap', () => {
    assert.equal(getTennisMarketFamily({ market: 'Set Handicap' }), 'set_handicap');
  });

  it('maps Game Handicap via spread/handicap keywords', () => {
    assert.equal(getTennisMarketFamily({ market: 'Game Handicap' }), 'spread');
    assert.equal(getTennisMarketFamily({ market: 'spread' }), 'spread');
  });

  it('maps Total Games via total/over-under', () => {
    assert.equal(getTennisMarketFamily({ market: 'Total Games' }), 'total');
    assert.equal(getTennisMarketFamily({ market: 'over/under' }), 'total');
    assert.equal(getTennisMarketFamily({ market: 'ou' }), 'total');
  });

  it('returns null for unknown markets', () => {
    assert.equal(getTennisMarketFamily({ market: 'Futures' }), null);
    assert.equal(getTennisMarketFamily({}), null);
    assert.equal(getTennisMarketFamily({ marketType: 'foo' }), null);
  });
});

describe('isTennisRow', () => {
  it('detects tennis via league/sport/gameType', () => {
    assert.equal(isTennisRow({ league: 'Tennis' }), true);
    assert.equal(isTennisRow({ sport: 'tennis' }), true);
    assert.equal(isTennisRow({ gameType: 'Tennis' }), true);
  });

  it('detects tennis via raw content', () => {
    assert.equal(isTennisRow({ market: 'WTA Singles', note: 'live tennis match' }), true);
  });

  it('returns false for non-tennis rows', () => {
    assert.equal(isTennisRow({ league: 'NBA' }), false);
    assert.equal(isTennisRow({}), false);
    assert.equal(isTennisRow(null), false);
  });
});

describe('normalizeTennisHistoryResponse', () => {
  it('passes through an array', () => {
    const arr = [{ book: 'DK', odds: -110 }];
    assert.deepEqual(normalizeTennisHistoryResponse(arr), arr);
  });

  it('unwraps a {data:[]} envelope', () => {
    const arr = [{ book: 'DK', odds: -110 }];
    assert.deepEqual(normalizeTennisHistoryResponse({ data: arr }), arr);
  });

  it('unwraps a {history:[]} envelope', () => {
    const arr = [{ book: 'DK', odds: -110 }];
    assert.deepEqual(normalizeTennisHistoryResponse({ history: arr }), arr);
  });

  it('flattens a book-keyed object and backfills book', () => {
    const resp = { DK: [{ odds: -110 }], FD: [{ odds: -105 }] };
    const out = normalizeTennisHistoryResponse(resp);
    assert.equal(out.length, 2);
    assert.deepEqual(out, [
      { odds: -110, book: 'DK' },
      { odds: -105, book: 'FD' }
    ]);
  });

  it('returns [] for null/missing', () => {
    assert.deepEqual(normalizeTennisHistoryResponse(null), []);
    assert.deepEqual(normalizeTennisHistoryResponse({}), []);
  });
});

describe('normalizeTennisHistoryItems', () => {
  it('maps americanOdds to odds and filters non-finite', () => {
    const items = [
      { odds: -110, start_ts: 100 },
      { americanOdds: -105, start_ts: 200 },
      { odds: 'bad', start_ts: 300 }
    ];
    const out = normalizeTennisHistoryItems(items);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { odds: -110, start_ts: 100 });
    assert.deepEqual(out[1], { odds: -105, americanOdds: -105, start_ts: 200 });
  });

  it('sorts by time using start_ts/timestamp/time fallback', () => {
    const items = [
      { odds: -110, timestamp: 300 },
      { odds: -105, start_ts: 100 },
      { odds: -100, time: 200 }
    ];
    const out = normalizeTennisHistoryItems(items);
    assert.deepEqual(
      out.map((i) => i.odds),
      [-105, -100, -110]
    );
  });

  it('falls back to 0 when no time field present', () => {
    const items = [{ odds: -110 }, { odds: -105, start_ts: 50 }];
    const out = normalizeTennisHistoryItems(items);
    assert.deepEqual(
      out.map((i) => i.odds),
      [-110, -105]
    );
  });
});
