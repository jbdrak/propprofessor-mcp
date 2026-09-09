'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const fixture = require('./fixtures/sharpodds-line-history.json');

const SAFE_META_KEYS = ['away_team', 'date', 'home_team', 'period', 'sportsbook', 'updated'].sort();
const SAFE_MARKET_KEYS = ['MONEYLINES', 'SPREADS', 'TOTALS'];
const SAFE_POINT_KEYS = ['away', 'date', 'home', 'pub', 'time'].sort();
const FORBIDDEN_KEY_RE = /(auth|cookie|token|session|password|secret|api[_-]?key|set-cookie)/i;

function collectKeys(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      out.push(key);
      collectKeys(value[key], out);
    }
  }
  return out;
}

function distinctValues(points, side) {
  return [...new Set(points.map((p) => p[side]))];
}

describe('sharpodds line-history contract (fixture only)', () => {
  it('exposes moneyline, spread, total, empty, and partial examples', () => {
    for (const key of ['moneyline', 'spread', 'total', 'empty', 'partial']) {
      assert.ok(fixture[key], `fixture should include "${key}" example`);
    }
  });

  it('uses exact safe meta keys on every example', () => {
    for (const key of ['moneyline', 'spread', 'total', 'empty', 'partial']) {
      assert.deepEqual(
        Object.keys(fixture[key].meta).sort(),
        SAFE_META_KEYS,
        `${key}.meta keys should match the redacted contract exactly`
      );
    }
  });

  it('restricts markets to the known market keys', () => {
    for (const key of ['moneyline', 'spread', 'total', 'empty', 'partial']) {
      for (const marketKey of Object.keys(fixture[key].markets)) {
        assert.ok(
          SAFE_MARKET_KEYS.includes(marketKey),
          `${key}.markets has unexpected key "${marketKey}"`
        );
      }
    }
  });

  it('uses exact safe point keys on every history point', () => {
    for (const key of ['moneyline', 'spread', 'total', 'partial']) {
      for (const marketKey of Object.keys(fixture[key].markets)) {
        for (const point of fixture[key].markets[marketKey]) {
          assert.deepEqual(
            Object.keys(point).sort(),
            SAFE_POINT_KEYS,
            `${key}.${marketKey} point keys should match the redacted contract exactly`
          );
        }
      }
    }
  });

  it('includes a clean moneyline point', () => {
    const points = fixture.moneyline.markets.MONEYLINES;
    assert.ok(points.length > 0, 'moneyline example needs at least one point');
    assert.ok(
      points.some((p) => p.away === '-617'),
      'moneyline example should include the clean "-617" point'
    );
  });

  it('shows two distinct historical line values on spread and total', () => {
    const spreadAway = distinctValues(fixture.spread.markets.SPREADS, 'away');
    const totalAway = distinctValues(fixture.total.markets.TOTALS, 'away');
    assert.ok(spreadAway.length >= 2, `spread away values should move, got ${JSON.stringify(spreadAway)}`);
    assert.ok(totalAway.length >= 2, `total away values should move, got ${JSON.stringify(totalAway)}`);
    assert.ok(
      spreadAway.some((v) => v.includes('+10.5')),
      'spread history should retain the opening +10.5 line value'
    );
    assert.ok(
      totalAway.some((v) => v.includes('o62')),
      'total history should retain the opening o62 line value'
    );
  });

  it('carries source timestamp fields on meta and every point', () => {
    for (const key of ['moneyline', 'spread', 'total']) {
      const example = fixture[key];
      assert.equal(typeof example.meta.date, 'string');
      assert.equal(typeof example.meta.updated, 'string');
      assert.ok(example.meta.date.length > 0, `${key}.meta.date should be non-empty`);
      assert.ok(example.meta.updated.length > 0, `${key}.meta.updated should be non-empty`);
      for (const marketKey of Object.keys(example.markets)) {
        for (const point of example.markets[marketKey]) {
          assert.match(point.date, /^\d{2}\/\d{2}$/, `${key}.${marketKey} point date should be MM/DD`);
          assert.ok(point.time.length > 0, `${key}.${marketKey} point time should be non-empty`);
        }
      }
    }
  });

  it('accepts pub:null on history points', () => {
    const points = fixture.moneyline.markets.MONEYLINES;
    assert.ok(points.some((p) => p.pub === null), 'at least one point should carry pub:null');
  });

  it('covers an empty response and a partial (moneylines-only) response', () => {
    assert.deepEqual(fixture.empty.markets.SPREADS, []);
    assert.deepEqual(fixture.empty.markets.TOTALS, []);
    assert.deepEqual(fixture.empty.markets.MONEYLINES, []);
    assert.deepEqual(Object.keys(fixture.partial.markets), ['MONEYLINES']);
    assert.equal(fixture.partial.markets.MONEYLINES.length, 1);
  });

  it('contains no auth/cookie/token fields anywhere', () => {
    const keys = collectKeys(fixture);
    const bad = keys.filter((k) => FORBIDDEN_KEY_RE.test(k));
    assert.deepEqual(bad, [], `forbidden credential-adjacent keys present: ${bad.join(', ')}`);
    const raw = JSON.stringify(fixture).toLowerCase();
    assert.ok(!raw.includes('set-cookie'), 'fixture payload must not contain set-cookie');
  });
});
