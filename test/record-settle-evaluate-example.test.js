'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { runExample } = require('../examples/record-settle-evaluate');

describe('record-settle-evaluate offline example', () => {
  it('runs the complete in-memory flow with an immutable decision snapshot', () => {
    const report = runExample();

    assert.deepEqual(report.flow, {
      candidates: 1,
      officialBets: 1,
      settlements: 1,
      evaluationRows: 1
    });
    assert.deepEqual(report.decisionSnapshot, {
      schemaVersion: 1,
      marketFairProbability: 0.52,
      modelWinProbability: 0.56,
      eloProbability: 0.54
    });
    assert.equal(report.outcome, 'win');
    assert.equal(report.calibration.totalDecided, 1);
    assert.equal(report.calibration.insufficientSample, true);
    assert.match(report.caveat, /Insufficient sample/i);
    assert.doesNotMatch(report.caveat, /demonstrates|proves|statistically significant/i);
  });

  it('prints deterministic JSON and never needs user paths or credentials', () => {
    const script = path.join(__dirname, '..', 'examples', 'record-settle-evaluate.js');
    const env = {
      PATH: process.env.PATH,
      HOME: path.join(__dirname, 'does-not-exist'),
      PP_RECORD_LEDGER: path.join(__dirname, 'must-not-be-created.json')
    };
    const first = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
    const second = spawnSync(process.execPath, [script], { encoding: 'utf8', env });

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stderr, '');
    assert.equal(first.stdout, second.stdout);
    assert.deepEqual(JSON.parse(first.stdout), runExample());
  });
});
