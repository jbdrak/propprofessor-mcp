'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ok, fail } = require('../lib/response-envelope');

describe('response-envelope ok()', () => {
  it('wraps a plain object with ok:true and data', () => {
    const result = ok({ plays: [{ id: 1 }] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { plays: [{ id: 1 }] });
    assert.deepEqual(result.plays, [{ id: 1 }], 'legacy spread keeps plays readable at root');
  });

  it('preserves legacy root fields already present on the payload', () => {
    const result = ok({ plays: [1], warning: 'stale' });
    assert.equal(result.ok, true);
    assert.equal(result.warning, 'stale', 'legacy field should be spread to root');
    assert.deepEqual(result.data.plays, [1]);
  });

  it('strips a nested ok so the wrapper is authoritative', () => {
    const result = ok({ ok: false, plays: [1] });
    assert.equal(result.ok, true, 'wrapper ok must win over payload ok');
    assert.deepEqual(result.data, { ok: false, plays: [1] });
  });

  it('returns an empty data envelope for null input', () => {
    const result = ok(null);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, {});
  });

  it('returns an empty data envelope for non-object input', () => {
    const result = ok('not-an-object');
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, {});
  });
});

describe('response-envelope fail()', () => {
  it('wraps an error with ok:false and code/message', () => {
    const result = fail('NO_DATA', 'no rows');
    assert.equal(result.ok, false);
    assert.deepEqual(result.error, { code: 'NO_DATA', message: 'no rows' });
  });

  it('merges extra fields at root', () => {
    const result = fail('BAD_REQ', 'missing player', { statusCode: 400 });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400, 'extra field spread to root');
    assert.deepEqual(result.error, { code: 'BAD_REQ', message: 'missing player' });
  });

  it('defaults extra to {} when omitted', () => {
    const result = fail('X', 'y');
    assert.deepEqual(result, { ok: false, error: { code: 'X', message: 'y' } });
  });
});
