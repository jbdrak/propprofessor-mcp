'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const results = require('../lib/record-results');

describe('record-results payload validation', () => {
  it('accepts a valid flat result payload', () => {
    const result = results.validateResultPayload({
      provider: 'espn',
      sourceUrl: 'https://example.test/results',
      events: [{ eventId: 'g-1', status: 'final' }]
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'espn');
    assert.equal(result.sourceUrl, 'https://example.test/results');
  });

  it('rejects missing provider and source URL', () => {
    const result = results.validateResultPayload({ events: [] });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ['provider is required', 'sourceUrl is required']);
  });

  it('rejects bare arrays and missing events', () => {
    assert.equal(results.validateResultPayload([]).ok, false);
    assert.equal(results.validateResultPayload({ provider: 'espn', sourceUrl: 'x' }).ok, false);
  });

  it('reports malformed event entries without rejecting valid payload provenance', () => {
    const result = results.validateResultPayload({
      provider: 'espn',
      sourceUrl: 'https://example.test/results',
      events: [{ eventId: 'g-1' }, null, 'bad']
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ['events[1] must be an object', 'events[2] must be an object']);
  });
});
