'use strict';

/**
 * Regression: the odds-history gate must admit concurrent requests.
 *
 * The gate was hardcoded serial (MAX_CONCURRENCY = 1, 100ms spacing), which
 * capped every scan at ~10 history calls/sec no matter the budget — the wall
 * behind the mixed-scan pair timeouts. Concurrency is now env-tunable
 * (PP_ODDS_HISTORY_CONCURRENCY, clamped 1..8), default 3. Upstream 429s still
 * halt the gate with cooldown, so this only spends the local budget faster.
 *
 * Hermetic: each case re-requires the module with a scrubbed cache and a
 * controlled env value, then asserts the exported constant. No network.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const API_PATH = require.resolve('../lib/propprofessor-api');

let savedEnv;

function loadWithConcurrencyEnv(value) {
  delete require.cache[API_PATH];
  if (value === undefined) delete process.env.PP_ODDS_HISTORY_CONCURRENCY;
  else process.env.PP_ODDS_HISTORY_CONCURRENCY = value;
  const api = require(API_PATH);
  return api.ODDS_HISTORY_MAX_CONCURRENCY;
}

describe('odds-history gate concurrency', () => {
  beforeEach(() => {
    savedEnv = process.env.PP_ODDS_HISTORY_CONCURRENCY;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PP_ODDS_HISTORY_CONCURRENCY;
    else process.env.PP_ODDS_HISTORY_CONCURRENCY = savedEnv;
    delete require.cache[API_PATH];
  });

  it('defaults to 3 concurrent history requests', () => {
    assert.equal(loadWithConcurrencyEnv(undefined), 3);
  });

  it('honors an explicit mid-range value', () => {
    assert.equal(loadWithConcurrencyEnv('5'), 5);
  });

  it('allows opting back down to serial', () => {
    assert.equal(loadWithConcurrencyEnv('1'), 1);
  });

  it('clamps above 8 and below 1', () => {
    assert.equal(loadWithConcurrencyEnv('99'), 8);
    assert.equal(loadWithConcurrencyEnv('0'), 1);
    assert.equal(loadWithConcurrencyEnv('-2'), 1);
  });

  it('falls back to default on garbage', () => {
    assert.equal(loadWithConcurrencyEnv('lots'), 3, 'garbage falls back to 3');
  });
});
