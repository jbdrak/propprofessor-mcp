'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeMarket,
  parseMarketValue,
  parseMoneylineValue,
  parseSpreadValue,
  parseTotalValue,
  parseTimezoneOffsetMinutes,
  inferSharpOddsTimeMs,
  normalizeSharpOddsHistory
} = require('../lib/sharpodds-history');
const fixture = require('./fixtures/sharpodds-line-history.json');

// Verified request timezone for the SharpOdds line-history probe.
const TZ = '-0400';

describe('sharpodds-history value parsing', () => {
  it('parses spread line and juice independently', () => {
    assert.deepEqual(parseSpreadValue('+10.5 -108'), { line: 10.5, odds: -108 });
    assert.deepEqual(parseSpreadValue('-10.5 -106'), { line: -10.5, odds: -106 });
  });

  it('parses totals with o/u prefixes', () => {
    assert.deepEqual(parseTotalValue('o62 -107'), { line: 62, odds: -107 });
    assert.deepEqual(parseTotalValue('u62 -109'), { line: 62, odds: -109 });
    assert.deepEqual(parseTotalValue('o63.5 -110'), { line: 63.5, odds: -110 });
  });

  it('parses moneyline juice with a null line', () => {
    assert.deepEqual(parseMoneylineValue('+476'), { line: null, odds: 476 });
    assert.deepEqual(parseMoneylineValue('-617'), { line: null, odds: -617 });
  });

  it('rejects malformed values without inventing numbers', () => {
    assert.deepEqual(parseMarketValue('spread', 'late scratch'), { line: null, odds: null });
    assert.deepEqual(parseMarketValue('moneyline', '+10.5 -108'), { line: null, odds: null });
    assert.deepEqual(parseMarketValue('total', ''), { line: null, odds: null });
  });

  it('resolves market aliases', () => {
    assert.equal(normalizeMarket('SPREADS'), 'spread');
    assert.equal(normalizeMarket('TOTAL'), 'total');
    assert.equal(normalizeMarket('ML'), 'moneyline');
    assert.equal(normalizeMarket('bogus'), null);
  });
});

describe('sharpodds-history normalization', () => {
  it('normalizes spread history and preserves the real line change', () => {
    const result = normalizeSharpOddsHistory(fixture.spread, { market: 'spread', side: 'away', timezone: TZ });

    assert.equal(result.provider, 'sharpodds');
    assert.equal(result.historySource, 'sharpodds');
    assert.equal(result.market, 'spread');
    assert.equal(result.side, 'away');
    assert.equal(result.book, 'ExampleBook');
    assert.equal(result.lineHistoryUsable, true);
    assert.equal(result.historyComplete, true);
    assert.equal(result.coverage, 'complete');
    assert.deepEqual(
      result.points.map((point) => [point.line, point.odds]),
      [
        [10.5, -108],
        [9.5, -110]
      ]
    );
    assert.ok(result.points[0].time < result.points[1].time, 'points should sort chronologically');
  });

  it('normalizes totals and moneylines, keeping moneyline lines null', () => {
    const total = normalizeSharpOddsHistory(fixture.total, { market: 'total', side: 'away', timezone: TZ });
    assert.deepEqual(
      total.points.map((point) => [point.line, point.odds]),
      [
        [62, -107],
        [63.5, -110]
      ]
    );
    assert.equal(total.lineHistoryUsable, true);

    const moneyline = normalizeSharpOddsHistory(fixture.moneyline, { market: 'moneyline', side: 'away', timezone: TZ });
    assert.deepEqual(
      moneyline.points.map((point) => [point.line, point.odds]),
      [
        [null, -150],
        [null, -617]
      ]
    );
    assert.ok(moneyline.points.every((point) => point.line === null));
    assert.equal(moneyline.lineHistoryUsable, true);
  });

  it('selects the requested side without mixing sides', () => {
    const home = normalizeSharpOddsHistory(fixture.spread, { market: 'spread', side: 'home', timezone: TZ });
    assert.deepEqual(
      home.points.map((point) => [point.line, point.odds]),
      [
        [-10.5, -112],
        [-9.5, -110]
      ]
    );
  });

  it('emits canonical points with liquidity null and verbatim pub, inventing no percentages', () => {
    const result = normalizeSharpOddsHistory(fixture.spread, { market: 'spread', side: 'away', timezone: TZ });
    for (const point of result.points) {
      assert.equal(point.liquidity, null);
      assert.equal(point.pub, null);
      assert.ok(!('moneyPct' in point), 'must not invent moneyPct');
      assert.ok(!('ticketsPct' in point), 'must not invent ticketsPct');
      assert.ok(!('moneyPct' in result), 'must not invent result-level moneyPct');
    }
  });

  it('sorts out-of-order points chronologically', () => {
    const payload = {
      meta: fixture.spread.meta,
      markets: { SPREADS: [...fixture.spread.markets.SPREADS].reverse() }
    };
    const result = normalizeSharpOddsHistory(payload, { market: 'spread', side: 'away', timezone: TZ });
    assert.deepEqual(
      result.points.map((point) => point.line),
      [10.5, 9.5]
    );
  });

  it('removes only exact consecutive duplicates and keeps reverted lines', () => {
    const payload = {
      meta: fixture.spread.meta,
      markets: {
        SPREADS: [
          { date: '09/01', time: '9:00 AM', away: '+10.5 -108', home: '-10.5 -112', pub: null },
          { date: '09/01', time: '9:00 AM', away: '+10.5 -108', home: '-10.5 -112', pub: null },
          { date: '09/01', time: '10:00 AM', away: '+9.5 -110', home: '-9.5 -110', pub: null },
          { date: '09/01', time: '11:00 AM', away: '+10.5 -108', home: '-10.5 -112', pub: null }
        ]
      }
    };
    const result = normalizeSharpOddsHistory(payload, { market: 'spread', side: 'away', timezone: TZ });
    assert.deepEqual(
      result.points.map((point) => [point.line, point.odds]),
      [
        [10.5, -108],
        [9.5, -110],
        [10.5, -108]
      ]
    );
    assert.equal(result.droppedCount, 1);
    assert.ok(result.warnings.includes('consecutive_duplicates_removed'));
  });

  it('treats empty history as unusable without backfilling a current line', () => {
    const result = normalizeSharpOddsHistory(fixture.empty, { market: 'spread', side: 'away' });
    assert.equal(result.coverage, 'empty');
    assert.equal(result.historyComplete, false);
    assert.equal(result.lineHistoryUsable, false);
    assert.deepEqual(result.points, []);
    assert.equal(result.pointCount, 0);
  });

  it('marks partial single-point history as insufficient, never usable', () => {
    const result = normalizeSharpOddsHistory(fixture.partial, { market: 'moneyline', side: 'away' });
    assert.equal(result.coverage, 'partial');
    assert.equal(result.historyComplete, false);
    assert.equal(result.lineHistoryUsable, false);
    assert.equal(result.pointCount, 1);
    assert.ok(result.warnings.includes('single_point_history'));
    assert.ok(result.warnings.includes('markets_partial'));
  });

  it('warns conservatively when meta.date is missing instead of guessing the year', () => {
    const payload = {
      meta: { sportsbook: 'ExampleBook' },
      markets: { SPREADS: fixture.spread.markets.SPREADS }
    };
    const result = normalizeSharpOddsHistory(payload, { market: 'spread', side: 'away' });
    assert.equal(result.lineHistoryUsable, false);
    assert.ok(result.warnings.includes('meta_date_missing'));
    assert.ok(result.warnings.includes('timestamp_year_unknown'));
    assert.ok(result.points.every((point) => point.time === null));
  });

  it('drops unparseable values with a warning while keeping good points', () => {
    const payload = {
      meta: fixture.spread.meta,
      markets: {
        SPREADS: [
          { date: '09/01', time: '9:00 AM', away: '+10.5 -108', home: '-10.5 -112', pub: null },
          { date: '09/01', time: '10:00 AM', away: 'suspended', home: 'suspended', pub: null },
          { date: '09/01', time: '12:00 PM', away: '+9.5 -110', home: '-9.5 -110', pub: null }
        ]
      }
    };
    const result = normalizeSharpOddsHistory(payload, { market: 'spread', side: 'away', timezone: TZ });
    assert.equal(result.pointCount, 2);
    assert.equal(result.lineHistoryUsable, true);
    assert.ok(result.warnings.includes('unparseable_values_dropped'));
  });

  it('rejects unknown markets and sides instead of guessing', () => {
    assert.throws(() => normalizeSharpOddsHistory(fixture.spread, { market: 'bogus', side: 'away' }), TypeError);
    assert.throws(() => normalizeSharpOddsHistory(fixture.spread, { market: 'spread', side: 'over' }), TypeError);
  });

  it('converts -0400 wall-clock to true UTC instead of assuming UTC', () => {
    const result = normalizeSharpOddsHistory(fixture.spread, { market: 'spread', side: 'away', timezone: '-0400' });
    assert.deepEqual(
      result.points.map((point) => point.time),
      ['2026-09-01T13:00:00.000Z', '2026-09-01T16:00:00.000Z']
    );
    assert.equal(result.lineHistoryUsable, true);
  });

  it('treats +0000 and offset minutes consistently', () => {
    const metaDate = { year: 2026, month: 9, day: 1 };
    const point = { date: '09/01', time: '9:00 AM' };
    assert.equal(
      new Date(inferSharpOddsTimeMs(point, metaDate, '+0000').timeMs).toISOString(),
      '2026-09-01T09:00:00.000Z'
    );
    assert.equal(
      inferSharpOddsTimeMs(point, metaDate, -240).timeMs,
      inferSharpOddsTimeMs(point, metaDate, '-0400').timeMs
    );
    assert.equal(parseTimezoneOffsetMinutes('-0400'), -240);
    assert.equal(parseTimezoneOffsetMinutes('+0000'), 0);
  });

  it('fails closed when the timezone is missing', () => {
    const result = normalizeSharpOddsHistory(fixture.spread, { market: 'spread', side: 'away' });
    assert.ok(result.points.every((point) => point.time === null));
    assert.equal(result.lineHistoryUsable, false);
    assert.ok(result.warnings.includes('timestamp_timezone_unknown'));
    assert.ok(result.warnings.includes('missing_timestamps'));
  });

  it('fails closed on unsupported IANA timezone names', () => {
    const result = normalizeSharpOddsHistory(fixture.spread, {
      market: 'spread',
      side: 'away',
      timezone: 'America/Chicago'
    });
    assert.ok(result.points.every((point) => point.time === null));
    assert.equal(result.lineHistoryUsable, false);
    assert.ok(result.warnings.includes('timestamp_timezone_unknown'));
    assert.ok(result.warnings.includes('missing_timestamps'));
  });

  it('nulls impossible calendar dates instead of normalizing them into March', () => {
    const metaDate = { year: 2026, month: 3, day: 1 };
    const bad = inferSharpOddsTimeMs({ date: '02/31', time: '9:00 AM' }, metaDate, '-0400');
    assert.equal(bad.timeMs, null);
    assert.equal(bad.warning, 'timestamp_unparseable');
    const nonLeapFeb29 = inferSharpOddsTimeMs({ date: '02/29', time: '9:00 AM' }, metaDate, '-0400');
    assert.equal(nonLeapFeb29.timeMs, null);

    const payload = {
      meta: { ...fixture.spread.meta, date: '2026-03-01' },
      markets: {
        SPREADS: [
          { date: '02/31', time: '9:00 AM', away: '+10.5 -108', home: '-10.5 -112', pub: null },
          { date: '02/28', time: '10:00 AM', away: '+9.5 -110', home: '-9.5 -110', pub: null }
        ]
      }
    };
    const result = normalizeSharpOddsHistory(payload, { market: 'spread', side: 'away', timezone: '-0400' });
    assert.equal(result.points.filter((point) => point.time === null).length, 1);
    assert.equal(result.lineHistoryUsable, false);
    assert.ok(result.warnings.includes('timestamp_unparseable'));
    assert.ok(result.warnings.includes('missing_timestamps'));
  });
});
