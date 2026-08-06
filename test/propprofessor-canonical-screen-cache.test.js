'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeScreenArgs, createCanonicalScreenCache } = require('../lib/propprofessor-shared-utils');

describe('canonicalizeScreenArgs', () => {
  it('produces order-independent canonical key for leagues arrays', () => {
    const args1 = { gameId: '12345', leagues: ['NBA', 'MLB'] };
    const args2 = { gameId: '12345', leagues: ['MLB', 'NBA'] };
    const key1 = canonicalizeScreenArgs(args1);
    const key2 = canonicalizeScreenArgs(args2);
    assert.equal(key1, key2, 'leagues order should not affect canonical key');
  });

  it('produces order-independent canonical key for markets arrays', () => {
    const args1 = { gameId: '12345', markets: ['Moneyline', 'Spread'] };
    const args2 = { gameId: '12345', markets: ['Spread', 'Moneyline'] };
    const key1 = canonicalizeScreenArgs(args1);
    const key2 = canonicalizeScreenArgs(args2);
    assert.equal(key1, key2, 'markets order should not affect canonical key');
  });

  it('produces order-independent canonical key for books arrays', () => {
    const args1 = { gameId: '12345', books: ['Fliff', 'FanDuel'] };
    const args2 = { gameId: '12345', books: ['FanDuel', 'Fliff'] };
    const key1 = canonicalizeScreenArgs(args1);
    const key2 = canonicalizeScreenArgs(args2);
    assert.equal(key1, key2, 'books order should not affect canonical key');
  });

  it('produces different canonical keys for exact selections on the same game', () => {
    const args1 = { gameId: '12345', leagues: ['Tennis'], markets: ['Total Games'], books: ['NoVigApp'], selection: 'Over 22.5' };
    const args2 = { gameId: '12345', leagues: ['Tennis'], markets: ['Total Games'], books: ['NoVigApp'], selection: 'Over 20.5' };
    const key1 = canonicalizeScreenArgs(args1);
    const key2 = canonicalizeScreenArgs(args2);
    assert.notEqual(key1, key2, 'different exact selections must not share a cached response');
  });

  it('produces different canonical keys for different gameId values', () => {
    const args1 = { gameId: '12345', leagues: ['NBA'] };
    const args2 = { gameId: '67890', leagues: ['NBA'] };
    const key1 = canonicalizeScreenArgs(args1);
    const key2 = canonicalizeScreenArgs(args2);
    assert.notEqual(key1, key2, 'different gameIds should produce different keys');
  });

  it('returns null when gameId is absent in args (full-league scan)', () => {
    const args = { leagues: ['NBA'], markets: ['Moneyline'] };
    const key = canonicalizeScreenArgs(args);
    assert.equal(key, null, 'should return null when gameId is absent');
  });

  it('handles gameId array by using first element', () => {
    const args1 = { gameId: '12345', leagues: ['NBA'] };
    const args2 = { gameIds: ['12345'], leagues: ['NBA'] };
    const key1 = canonicalizeScreenArgs(args1);
    const key2 = canonicalizeScreenArgs(args2);
    assert.equal(key1, key2, 'gameId and gameIds[0] should produce same key');
  });
});

describe('createCanonicalScreenCache', () => {
  it('respects TTL — entry expires after TTL ms', async () => {
    const cache = createCanonicalScreenCache({ ttlMs: 50, maxEntries: 10 });
    const key = canonicalizeScreenArgs({ gameId: '12345', leagues: ['NBA'] });

    // Set an entry
    cache.set(key, { data: 'test' });

    // Should be present immediately
    assert.deepEqual(cache.get(key), { data: 'test' });

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should be expired now
    assert.equal(cache.get(key), undefined, 'entry should expire after TTL');
  });

  it('in-flight mutex: 3 concurrent identical lookups → 1 underlying call', async () => {
    let callCount = 0;
    let resolvePromise = null;

    const underlyingFn = () => {
      callCount++;
      return new Promise((resolve) => {
        resolvePromise = () => resolve({ data: 'result' });
      });
    };

    const ttlMs = 1000;
    const cache = createCanonicalScreenCache({ ttlMs, maxEntries: 10 });
    const key = canonicalizeScreenArgs({ gameId: '12345', leagues: ['NBA'] });

    // Create a memoized function - returns a callable that takes no args
    const memoized = cache.memoize(underlyingFn, key);

    // Fire 3 concurrent calls
    const promises = [memoized(), memoized(), memoized()];

    // Resolve the underlying promise
    resolvePromise();

    const results = await Promise.all(promises);

    assert.equal(callCount, 1, 'underlying function should be called exactly once');
    assert.deepEqual(results, [{ data: 'result' }, { data: 'result' }, { data: 'result' }]);
  });

  it('no caching when gameId absent in args (full-league scan passes through)', async () => {
    const cache = createCanonicalScreenCache({ ttlMs: 1000, maxEntries: 10 });
    const args = { leagues: ['NBA'], markets: ['Moneyline'] };
    const key = canonicalizeScreenArgs(args);

    // key should be null for full-league scans
    assert.equal(key, null);

    // Cache should not have a null key stored
    // The cache should handle this gracefully
    let storedValue = null;
    const memoized = cache.memoize(async () => {
      storedValue = 'computed';
      return 'result';
    }, key);

    const result = await memoized();
    assert.equal(result, 'result');
    assert.equal(storedValue, 'computed', 'should still compute when key is null');
  });

  it('returns stats() with size, max, hits, misses, evictions', async () => {
    const cache = createCanonicalScreenCache({ ttlMs: 1000, maxEntries: 5 });
    const key = canonicalizeScreenArgs({ gameId: '12345', leagues: ['NBA'] });

    cache.set(key, { data: 'test' });
    const stats = cache.stats();

    assert.equal(typeof stats.size, 'number');
    assert.equal(typeof stats.max, 'number');
    assert.equal(typeof stats.hits, 'number');
    assert.equal(typeof stats.misses, 'number');
    assert.equal(typeof stats.evictions, 'number');
    assert.equal(stats.max, 5);
    assert.equal(stats.size, 1);
  });
});
