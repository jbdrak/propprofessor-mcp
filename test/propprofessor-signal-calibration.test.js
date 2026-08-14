'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Isolate test calibration from real data: point the module at a throwaway
// tmp dir BEFORE requiring it (the module reads the env var at load time).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mcp-calibration-test-'));
process.env.PP_SIGNAL_CALIBRATION_FILE = path.join(tmpDir, 'signal-calibration.json');

const mod = require('../lib/propprofessor-signal-calibration');

// Cleanup only removes the tmp dir — the real calibration file is never touched.
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('PP_SIGNAL_CALIBRATION_FILE overrides the default calibration path', () => {
  mod.save({});

  mod.recordResolution({
    status: 'won',
    confidenceTier: 'TIER 1',
    movementGrade: 'green',
    league: 'NBA',
    market: 'Moneyline'
  });

  // The module must write to the override path, not ~/.propprofessor
  const written = JSON.parse(fs.readFileSync(path.join(tmpDir, 'signal-calibration.json'), 'utf8'));
  assert.equal(written['TIER 1:green:NBA:Moneyline'].wins, 1);
});

test('record and retrieve calibration', () => {
  // Clean state
  mod.save({});

  mod.recordResolution({
    status: 'won',
    confidenceTier: 'TIER 1',
    movementGrade: 'green',
    league: 'NBA',
    market: 'Moneyline'
  });

  mod.recordResolution({
    status: 'lost',
    confidenceTier: 'TIER 1',
    movementGrade: 'green',
    league: 'NBA',
    market: 'Moneyline'
  });

  mod.recordResolution({
    status: 'won',
    confidenceTier: 'TIER 4',
    movementGrade: 'red',
    league: 'MLB',
    market: 'Total Runs'
  });

  const cal = mod.getCalibration();
  const key1 = 'TIER 1:green:NBA:Moneyline';
  const key2 = 'TIER 4:red:MLB:Total Runs';

  assert.equal(cal[key1].wins, 1);
  assert.equal(cal[key1].losses, 1);
  assert.equal(cal[key1].total, 2);
  assert.equal(cal[key1].hitRate, '50.0');
  assert.equal(cal[key2].wins, 1);
  assert.equal(cal[key2].losses, 0);
  assert.equal(cal[key2].hitRate, '100.0');
});

test('missing fields use defaults', () => {
  mod.save({});

  mod.recordResolution({
    status: 'won'
    // no tier, no grade, no league, no market
  });

  const cal = mod.getCalibration();
  const key = 'TIER 4:unknown:?:?';
  assert.equal(cal[key].wins, 1);
});

test('push does not count as win or loss', () => {
  mod.save({});

  mod.recordResolution({
    status: 'push',
    confidenceTier: 'TIER 2',
    movementGrade: 'yellow',
    league: 'NFL',
    market: 'Spread'
  });

  const cal = mod.getCalibration();
  const key = 'TIER 2:yellow:NFL:Spread';
  assert.equal(cal[key].pushes, 1);
  assert.equal(cal[key].wins, 0);
  assert.equal(cal[key].losses, 0);
  assert.equal(cal[key].total, 0);
});
