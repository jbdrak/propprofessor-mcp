'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractHistoryTrail,
  extractNumericTrailValue,
  extractRowFreshnessInfo,
  extractScreenRows,
  parseBetPrompt
} = require('../lib/screen-parser');

describe('parseBetPrompt', () => {
  it('returns empty shape when no pattern matches', () => {
    assert.deepEqual(parseBetPrompt(''), { player: '', side: '', line: null, market: '' });
    assert.deepEqual(parseBetPrompt('random text'), { player: '', side: '', line: null, market: '' });
  });

  it('parses an over prompt', () => {
    const r = parseBetPrompt('is LeBron James over 25.5 points a good bet');
    assert.equal(r.player, 'LeBron James');
    assert.equal(r.side, 'over');
    assert.equal(r.line, 25.5);
    assert.equal(r.market, 'points');
  });

  it('parses a u/o shorthand', () => {
    const r = parseBetPrompt('Giannis u 30 rebounds');
    assert.equal(r.side, 'under');
    assert.equal(r.line, 30);
    assert.equal(r.market, 'rebounds');
  });
});

describe('extractNumericTrailValue', () => {
  it('returns the number when passed a number', () => {
    assert.equal(extractNumericTrailValue(-110), -110);
    assert.equal(extractNumericTrailValue(NaN), null);
    assert.equal(extractNumericTrailValue(Infinity), null);
  });

  it('returns null for non-objects', () => {
    assert.equal(extractNumericTrailValue(null), null);
    assert.equal(extractNumericTrailValue('x'), null);
  });

  it('checks candidate keys in order and returns the first finite', () => {
    assert.equal(extractNumericTrailValue({ odds: -105 }), -105);
    assert.equal(extractNumericTrailValue({ americanOdds: -120 }), -120);
    assert.equal(extractNumericTrailValue({ price: 1.9 }), 1.9);
    assert.equal(extractNumericTrailValue({ line: 8.5 }), 8.5);
    assert.equal(extractNumericTrailValue({ value: 200 }), 200);
    assert.equal(extractNumericTrailValue({ current: -130 }), -130);
    assert.equal(extractNumericTrailValue({ open: 100 }), 100);
    assert.equal(extractNumericTrailValue({ close: -140 }), -140);
  });

  it('returns null when no candidate is a finite number', () => {
    assert.equal(extractNumericTrailValue({ odds: 'n/a', line: 'x' }), null);
  });
});

describe('extractHistoryTrail', () => {
  it('uses the first array with >=2 finite values', () => {
    const row = { lineHistory: [{ odds: -110 }, { odds: -105 }, { odds: -100 }] };
    assert.deepEqual(extractHistoryTrail(row), [-110, -105, -100]);
  });

  it('falls through to oddsHistory / priceHistory / movementHistory / history', () => {
    assert.deepEqual(extractHistoryTrail({ priceHistory: [1.9, 2.0] }), [1.9, 2.0]);
    assert.deepEqual(extractHistoryTrail({ movementHistory: [-110, -115] }), [-110, -115]);
    assert.deepEqual(extractHistoryTrail({ history: [100, 110] }), [100, 110]);
  });

  it('falls back to opening/current odds fields', () => {
    assert.deepEqual(extractHistoryTrail({ openingOdds: -110, currentOdds: -105 }), [-110, -105]);
    assert.deepEqual(extractHistoryTrail({ openOdds: 1.9, odds: 2.0 }), [1.9, 2.0]);
    assert.deepEqual(extractHistoryTrail({ startPrice: -120, price: -115 }), [-120, -115]);
  });

  it('skips non-array history fields and returns [] when nothing resolves', () => {
    assert.deepEqual(extractHistoryTrail({ lineHistory: 'notarray' }), []);
    assert.deepEqual(extractHistoryTrail({}), []);
  });
});

describe('extractRowFreshnessInfo', () => {
  it('returns null for non-objects', () => {
    assert.equal(extractRowFreshnessInfo(null), null);
    assert.equal(extractRowFreshnessInfo('x'), null);
  });

  it('reads each top-level field name', () => {
    const ts = '2026-08-26T12:00:00Z';
    for (const key of [
      'updatedAt',
      'lastUpdated',
      'lastUpdate',
      'timestamp',
      'time',
      'createdAt',
      'pulledAt',
      'refreshedAt',
      'asOf',
      'scrapedAt',
      'fetchedAt',
      'snapshotAt'
    ]) {
      const info = extractRowFreshnessInfo({ [key]: ts });
      assert.equal(info.source, key, `source should be ${key}`);
      assert.ok(Number.isFinite(info.ms));
    }
  });

  it('reads nested payload.* and meta.* fields', () => {
    const ts = '2026-08-26T12:00:00Z';
    assert.equal(extractRowFreshnessInfo({ payload: { updatedAt: ts } }).source, 'payload.updatedAt');
    assert.equal(extractRowFreshnessInfo({ payload: { lastUpdated: ts } }).source, 'payload.lastUpdated');
    assert.equal(extractRowFreshnessInfo({ meta: { updatedAt: ts } }).source, 'meta.updatedAt');
    assert.equal(extractRowFreshnessInfo({ meta: { timestamp: ts } }).source, 'meta.timestamp');
  });

  it('returns null when no timestamp is parseable', () => {
    assert.equal(extractRowFreshnessInfo({ updatedAt: 'not-a-date' }), null);
    assert.equal(extractRowFreshnessInfo({}), null);
  });
});

describe('extractScreenRows', () => {
  it('pulls from top-level array payload', () => {
    const payload = [{ id: 'r1', selections: { null: { odds: { DK: { odds1: -110 } } } } }];
    const rows = extractScreenRows(payload);
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 1);
  });

  it('pulls from game_data / data / results / rows containers', () => {
    assert.equal(extractScreenRows({ game_data: [{ id: 'a' }] }).length, 1);
    assert.equal(extractScreenRows({ data: [{ id: 'a' }] }).length, 1);
    assert.equal(extractScreenRows({ results: [{ id: 'a' }] }).length, 1);
    assert.equal(extractScreenRows({ rows: [{ id: 'a' }] }).length, 1);
  });

  it('expands a normalized non-prop row into per-book, per-side rows', () => {
    const payload = [
      {
        league: 'NBA',
        market: 'Points',
        selection1: 'LeBron',
        selection2: 'Curry',
        line1: 25.5,
        line2: 25.5,
        odds: { DK: { odds1: -110, odds2: -110 }, FD: { odds1: -105, odds2: -115 } }
      }
    ];
    const rows = extractScreenRows(payload);
    // 2 sides x 2 books = 4 rows
    assert.equal(rows.length, 4);
    const dkLebron = rows.find((r) => r.book === 'DK' && r.selection === 'LeBron');
    assert.equal(dkLebron.odds, -110);
    assert.equal(dkLebron.liquidityUsd, null);
  });

  it('honors candidateBooks filter and falls back to all books when focus missing', () => {
    const payload = [
      {
        league: 'NBA',
        market: 'Points',
        selection1: 'LeBron',
        selection2: 'Curry',
        odds: { DK: { odds1: -110, odds2: -110 } }
      }
    ];
    const filtered = extractScreenRows(payload, [{ book: 'DK' }]);
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every((r) => r.book === 'DK'));
  });

  it('expands selection-object rows per book/side', () => {
    const payload = [
      {
        league: 'MLB',
        market: 'Moneyline',
        selections: {
          null: {
            selection1: 'Yankees',
            selection2: 'Red Sox',
            odds: { DK: { odds1: -150, odds2: 130 } }
          }
        }
      }
    ];
    const rows = extractScreenRows(payload);
    assert.equal(rows.length, 2);
    const yankees = rows.find((r) => r.selection === 'Yankees');
    assert.equal(yankees.odds, -150);
  });

  it('passes through rows with no selections and no candidateBooks', () => {
    const payload = [{ id: 'raw', league: 'NBA' }];
    const rows = extractScreenRows(payload);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'raw');
  });

  it('skips non-object rows', () => {
    const rows = extractScreenRows([null, 'junk', { id: 'ok' }]);
    assert.equal(rows.length, 1);
  });
});
