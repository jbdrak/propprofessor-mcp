'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { describe, it } = require('node:test');
const { renderScanOutput } = require('../bin/pp-cli');

const projectRoot = path.join(__dirname, '..');
const ppPath = path.join(projectRoot, 'bin', 'pp');
const backtestPath = path.join(projectRoot, 'bin', 'backtest');
const queryPath = path.join(projectRoot, 'scripts', 'query-propprofessor.js');

describe('pp CLI entrypoint', () => {
  it('prints help through the bin/pp wrapper', () => {
    const result = execFileSync(process.execPath, [ppPath, '--help'], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    assert.match(result, /pp — PropProfessor CLI/);
    assert.match(result, /Usage: pp <command> \[args\.\.\.\]/);
    assert.notEqual(result.trim(), '');
  });

  it('prints help through the published backtest wrapper', () => {
    const result = execFileSync(process.execPath, [backtestPath, '--help'], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    assert.match(result, /PropProfessor Backtest Runner/);
  });

  for (const flag of ['--help', '-h']) {
    it(`prints query help for ${flag}`, () => {
      const result = execFileSync(process.execPath, [queryPath, flag], {
        cwd: projectRoot,
        encoding: 'utf8'
      });

      assert.match(result, /PropProfessor query CLI/);
    });
  }

  it('warns about incomplete scans and preserves health metadata in JSON', () => {
    const originalLog = console.log;
    const originalError = console.error;
    const stdout = [];
    const stderr = [];
    console.log = (value) => stdout.push(value);
    console.error = (value) => stderr.push(value);
    try {
      const res = {
        results: [{ league: 'MLB', market: 'Moneyline', plays: [] }],
        scanHealth: {
          incomplete: true,
          validationBudgetExhausted: true,
          truncated: true,
          preHistoryShortlist: [{ league: 'MLB', truncated: true }]
        }
      };
      renderScanOutput(res, {
        flags: { json: true },
        leagues: ['MLB'],
        marketList: ['Moneyline'],
        book: 'NoVigApp',
        targetTiers: ['TIER 1'],
        cardWindow: 'all',
        limit: 5
      });
      assert.match(stderr.join('\\n'), /incomplete\/truncated/);
      assert.match(stderr.join('\\n'), /shared odds-history budget exhausted/);
      assert.match(stderr.join('\\n'), /pp rank MLB/);
      const parsed = JSON.parse(stdout[0]);
      assert.equal(parsed.scanHealth.validationBudgetExhausted, true);
      assert.deepEqual(parsed.results, res.results);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });
});
