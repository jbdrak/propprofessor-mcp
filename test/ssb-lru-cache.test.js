'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { LruCache } = require('../lib/ssb-lru-cache');

describe('LruCache — basic ops', () => {
  it('returns undefined on miss', () => {
    const c = new LruCache();
    assert.equal(c.get('nope'), undefined);
  });

  it('returns value on hit', () => {
    const c = new LruCache();
    c.set('k', 'v', 60_000);
    assert.equal(c.get('k'), 'v');
  });

  it('expires entries after TTL', async () => {
    const c = new LruCache();
    c.set('k', 'v', 20);
    assert.equal(c.get('k'), 'v');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(c.get('k'), undefined);
  });

  it('throws on non-positive TTL', () => {
    const c = new LruCache();
    assert.throws(() => c.set('k', 'v', 0));
    assert.throws(() => c.set('k', 'v', -1));
    assert.throws(() => c.set('k', 'v', NaN));
  });

  it('throws on non-positive maxEntries', () => {
    assert.throws(() => new LruCache(0));
    assert.throws(() => new LruCache(-5));
    assert.throws(() => new LruCache(1.5));
  });

  it('tracks hits and misses', () => {
    const c = new LruCache();
    c.set('k', 'v', 60_000);
    c.get('k');
    c.get('k');
    c.get('missing');
    const stats = c.stats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 1);
  });
});

describe('LruCache — eviction', () => {
  it('evicts least-recently-used when over capacity', () => {
    const c = new LruCache(3);
    c.set('a', 1, 60_000);
    c.set('b', 2, 60_000);
    c.set('c', 3, 60_000);
    // Touch 'a' so 'b' becomes LRU
    c.get('a');
    c.set('d', 4, 60_000); // should evict 'b'
    assert.equal(c.get('b'), undefined);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('c'), 3);
    assert.equal(c.get('d'), 4);
    assert.equal(c.stats().evictions, 1);
  });
});

describe('LruCache — delete + deleteMatching', () => {
  it('delete removes a single key', () => {
    const c = new LruCache();
    c.set('player1|tennis', {}, 60_000);
    c.set('player2|tennis', {}, 60_000);
    c.delete('player1|tennis');
    assert.equal(c.get('player1|tennis'), undefined);
    assert.ok(c.get('player2|tennis'));
  });

  it('deleteMatching removes all keys with a prefix', () => {
    const c = new LruCache();
    c.set('tiafoe|tennis|', {}, 60_000);
    c.set('tiafoe|tennis|2026-06-02', {}, 60_000);
    c.set('alcaraz|tennis|', {}, 60_000);
    const removed = c.deleteMatching('tiafoe|tennis');
    assert.equal(removed, 2);
    assert.equal(c.get('tiafoe|tennis|'), undefined);
    assert.equal(c.get('tiafoe|tennis|2026-06-02'), undefined);
    assert.ok(c.get('alcaraz|tennis|'));
  });
});

describe('LruCache — clear', () => {
  it('clear removes everything', () => {
    const c = new LruCache();
    c.set('a', 1, 60_000);
    c.set('b', 2, 60_000);
    c.clear();
    assert.equal(c.size(), 0);
    assert.equal(c.get('a'), undefined);
  });
});
