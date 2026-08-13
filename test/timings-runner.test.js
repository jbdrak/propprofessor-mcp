'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { describe, it } = require('node:test');
const { parseTapTestCount, summarizeChildResult } = require('./timings');

const TIMINGS_PATH = path.join(__dirname, 'timings.js');

describe('timings quality gate helpers', () => {
  it('does not run the timing table when imported', () => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const timings = require(${JSON.stringify(TIMINGS_PATH)}); console.log(Object.keys(timings).sort().join(','));`
      ],
      {
        encoding: 'utf8'
      }
    );

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'parseTapTestCount,summarizeChildResult\n');
  });

  it('parses current and legacy Node TAP test summaries', () => {
    assert.equal(parseTapTestCount('ℹ tests 7'), 7);
    assert.equal(parseTapTestCount('# tests 3'), 3);
  });

  it('reports a nonzero child exit status as a failure', () => {
    const result = summarizeChildResult({ status: 1, signal: null, error: null, stdout: 'failed', stderr: '' });
    assert.equal(result.ok, false);
    assert.match(result.message, /failed/);
  });

  it('reports spawn errors and timeouts as failures', () => {
    for (const child of [
      { status: null, signal: null, error: new Error('spawn failed'), stdout: '', stderr: '' },
      { status: null, signal: 'SIGTERM', error: null, stdout: '', stderr: 'timed out' }
    ]) {
      const result = summarizeChildResult(child);
      assert.equal(result.ok, false);
    }
  });

  it('rejects status-0 children with malformed TAP output', () => {
    const result = summarizeChildResult({ status: 0, signal: null, error: null, stdout: 'not TAP', stderr: '' });
    assert.equal(result.ok, false);
    assert.match(result.message, /positive test count/i);
  });

  it('rejects status-0 children that report zero tests', () => {
    const result = summarizeChildResult({ status: 0, signal: null, error: null, stdout: 'ℹ tests 0', stderr: '' });
    assert.equal(result.ok, false);
    assert.match(result.message, /positive test count/i);
  });
});
