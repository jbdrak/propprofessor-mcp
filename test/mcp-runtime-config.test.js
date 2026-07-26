'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS, getOddsHistoryLookbackHours } = require('../lib/mcp-runtime-config');
const { getDebugFlag } = require('../lib/propprofessor-mcp-ranked-screen');

const ORIGINAL_LOOKBACK = process.env.PROPPROFESSOR_ODDS_HISTORY_LOOKBACK_HOURS;

afterEach(() => {
  if (ORIGINAL_LOOKBACK === undefined) {
    delete process.env.PROPPROFESSOR_ODDS_HISTORY_LOOKBACK_HOURS;
  } else {
    process.env.PROPPROFESSOR_ODDS_HISTORY_LOOKBACK_HOURS = ORIGINAL_LOOKBACK;
  }
});

describe('mcp runtime config', () => {
  it('uses the default 6 hour lookback when env is unset', () => {
    delete process.env.PROPPROFESSOR_ODDS_HISTORY_LOOKBACK_HOURS;
    assert.equal(getOddsHistoryLookbackHours(), DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS);
  });

  it('uses the env-configured lookback when present', () => {
    process.env.PROPPROFESSOR_ODDS_HISTORY_LOOKBACK_HOURS = '9';
    assert.equal(getOddsHistoryLookbackHours(), 9);
  });

  it('falls back to the default for invalid env values', () => {
    process.env.PROPPROFESSOR_ODDS_HISTORY_LOOKBACK_HOURS = '0';
    assert.equal(getOddsHistoryLookbackHours(), DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS);
    process.env.PROPPROFESSOR_ODDS_HISTORY_LOOKBACK_HOURS = 'abc';
    assert.equal(getOddsHistoryLookbackHours(), DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS);
  });

  it('prefers an explicit function argument over env', () => {
    process.env.PROPPROFESSOR_ODDS_HISTORY_LOOKBACK_HOURS = '9';
    assert.equal(getOddsHistoryLookbackHours('4'), 4);
  });

  it('normalizes debug flags with a default-on behavior', () => {
    assert.equal(getDebugFlag(undefined), true);
    assert.equal(getDebugFlag(false), false);
    assert.equal(getDebugFlag('false'), false);
    assert.equal(getDebugFlag('0'), false);
    assert.equal(getDebugFlag('true'), true);
    assert.equal(getDebugFlag('1'), true);
  });
});
