'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { compactRow } = require('../lib/propprofessor-shared-utils');

describe('compactRow', () => {
  it('strips null and empty-string fields by default', () => {
    const input = { id: 'abc', market: 'Moneyline', b: null, c: '', d: 'keep' };
    const out = compactRow(input);
    assert.equal(out.id, 'abc');
    assert.equal(out.market, 'Moneyline');
    assert.equal(out.d, 'keep');
    assert.equal('b' in out, false, 'null field should be stripped');
    assert.equal('c' in out, false, 'empty-string field should be stripped');
  });

  it('strips empty arrays and objects by default', () => {
    const input = { id: 'abc', arr: [], obj: {}, keep: [1] };
    const out = compactRow(input);
    assert.equal('arr' in out, false);
    assert.equal('obj' in out, false);
    assert.deepEqual(out.keep, [1]);
  });

  it('keeps fields explicitly listed in keepFields even when null/empty', () => {
    const input = { id: 'abc', odds: -110, line: null, extra: '' };
    const out = compactRow(input, ['id', 'odds', 'line']);
    assert.equal(out.id, 'abc');
    assert.equal(out.odds, -110);
    assert.equal(out.line, null, 'keepFields should preserve nulls for listed fields');
    assert.equal('extra' in out, false, 'fields not in keepFields are dropped');
  });

  it('handles zero as a real value (does not strip zeros)', () => {
    const input = { score: 0, count: 0, dropped: null };
    const out = compactRow(input);
    assert.equal(out.score, 0);
    assert.equal(out.count, 0);
    assert.equal('dropped' in out, false);
  });

  it('does not mutate the input row', () => {
    const input = { id: 'abc', b: null };
    const snapshot = JSON.stringify(input);
    compactRow(input);
    assert.equal(JSON.stringify(input), snapshot);
  });

  it('returns a new object reference', () => {
    const input = { id: 'abc' };
    const out = compactRow(input);
    assert.notEqual(out, input);
  });
});

describe('DEFAULT_LEAGUES', () => {
  const { DEFAULT_LEAGUES } = require('../lib/propprofessor-shared-utils');

  it('exports every league the PropProfessor backend supports', () => {
    const expected = ['NBA', 'NBASL', 'MLB', 'NFL', 'NHL', 'WNBA', 'NCAAB', 'NCAAF', 'Soccer', 'MLS', 'Tennis', 'UFC'];
    assert.deepEqual([...DEFAULT_LEAGUES], expected);
  });

  it('is frozen so callers cannot accidentally mutate the source of truth', () => {
    assert.ok(Object.isFrozen(DEFAULT_LEAGUES), 'DEFAULT_LEAGUES should be frozen');
  });

  it('covers both the main US sports and the international / niche leagues', () => {
    // Sanity guards — if a league is added or removed, update the test on the
    // line above and re-verify the propprofessor backend actually supports it.
    assert.ok(DEFAULT_LEAGUES.includes('NBA'), 'must include NBA');
    assert.ok(DEFAULT_LEAGUES.includes('NFL'), 'must include NFL');
    assert.ok(DEFAULT_LEAGUES.includes('Soccer'), 'must include Soccer');
    assert.ok(DEFAULT_LEAGUES.includes('MLS'), 'must include MLS');
    assert.ok(DEFAULT_LEAGUES.includes('Tennis'), 'must include Tennis');
    assert.ok(!DEFAULT_LEAGUES.includes(''), 'must not contain empty string');
  });
});

describe('createCrossCallMemoizedQuery', () => {
  const { createCrossCallMemoizedQuery } = require('../lib/propprofessor-shared-utils');
  const { LruCache } = require('../lib/propprofessor-lru-cache');

  it('deduplicates concurrent calls for the same key (in-flight mutex)', async () => {
    let calls = 0;
    let resolveFn;
    const fn = () =>
      new Promise((resolve) => {
        calls += 1;
        resolveFn = () => resolve({ value: calls });
      });
    const cache = new LruCache(10);
    const memoized = createCrossCallMemoizedQuery(fn, { cache, keyFn: (p) => p.id });
    const p1 = memoized({ id: 'x' });
    const p2 = memoized({ id: 'x' });
    const p3 = memoized({ id: 'x' });
    resolveFn();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(calls, 1, 'fn should fire exactly once for concurrent calls');
    assert.deepEqual([r1, r2, r3], [{ value: 1 }, { value: 1 }, { value: 1 }]);
  });

  it('serves cached results on subsequent calls (cross-call LRU)', async () => {
    let calls = 0;
    const fn = async (p) => {
      calls += 1;
      return { value: p.id, calls };
    };
    const cache = new LruCache(10);
    const memoized = createCrossCallMemoizedQuery(fn, { cache, keyFn: (p) => p.id });
    const r1 = await memoized({ id: 'a' });
    const r2 = await memoized({ id: 'a' });
    const r3 = await memoized({ id: 'b' });
    assert.deepEqual(r1, { value: 'a', calls: 1 });
    assert.deepEqual(r2, { value: 'a', calls: 1 }, 'second call should hit cache');
    assert.deepEqual(r3, { value: 'b', calls: 2 });
    assert.equal(calls, 2);
  });

  it('does not cache failures (so the next call retries)', async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw new Error('upstream timeout');
      return { ok: true };
    };
    const cache = new LruCache(10);
    const memoized = createCrossCallMemoizedQuery(fn, { cache, keyFn: () => 'k' });
    await assert.rejects(() => memoized({}), /upstream timeout/);
    const r2 = await memoized({});
    assert.deepEqual(r2, { ok: true });
    assert.equal(calls, 2, 'second call must retry the network request, not serve cached failure');
  });

  it('throws when fn is not a function', () => {
    const cache = new LruCache(10);
    assert.throws(() => createCrossCallMemoizedQuery(null, { cache }), /fn must be a function/);
  });

  it('throws when cache is not an LRU-like object', () => {
    assert.throws(
      () => createCrossCallMemoizedQuery(async () => null, { cache: null }),
      /cache must be an LRU-like object/
    );
  });
});

describe('mapWithConcurrency', () => {
  const { mapWithConcurrency } = require('../lib/propprofessor-shared-utils');

  it('returns an empty array for empty input', async () => {
    const out = await mapWithConcurrency([], async () => 1);
    assert.deepEqual(out, []);
  });

  it('preserves input order even with concurrency > 1', async () => {
    const out = await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      async (value) => {
        // Variable delay so order can't be relied on from wall-clock timing.
        await new Promise((resolve) => setTimeout(resolve, 6 - value));
        return value * 10;
      },
      { concurrency: 3 }
    );
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
  });

  it('caps in-flight workers at the requested concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      async (value) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return value;
      },
      { concurrency: 4 }
    );
    assert.equal(maxInFlight, 4, 'in-flight count should never exceed the cap');
    assert.ok(maxInFlight <= 4);
  });

  it('coerces non-numeric concurrency to 1', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(
      [1, 2, 3],
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
      { concurrency: 'bogus' }
    );
    assert.equal(maxInFlight, 1, 'non-numeric concurrency should fall back to 1');
  });
});
