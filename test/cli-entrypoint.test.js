'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { describe, it } = require('node:test');
const { renderScanOutput, formatError } = require('../bin/pp-cli');

const projectRoot = path.join(__dirname, '..');
const ppPath = path.join(projectRoot, 'bin', 'pp');
const backtestPath = path.join(projectRoot, 'bin', 'backtest');
const queryPath = path.join(projectRoot, 'scripts', 'query-propprofessor.js');

describe('pp CLI entrypoint', () => {
  it('formats a null error without throwing another error', () => {
    assert.equal(formatError(null, 'pp scan'), 'Error: null');
  });

  it('prints help through the bin/pp wrapper', () => {
    const result = execFileSync(process.execPath, [ppPath, '--help'], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    assert.match(result, /pp — PropProfessor CLI/);
    assert.match(result, /Usage: pp <command> \[args\.\.\.\]/);
    assert.notEqual(result.trim(), '');
  });

  it('documents all-market rank recovery in rank help', () => {
    const result = execFileSync(process.execPath, [ppPath, 'rank', '--help'], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    assert.match(result, /--all-markets/);
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
      assert.match(stderr.join('\n'), /incomplete\/truncated/);
      assert.match(stderr.join('\n'), /scan validation budget exhausted/);
      assert.match(stderr.join('\n'), /pp rank MLB/);
      const parsed = JSON.parse(stdout[0]);
      assert.equal(parsed.scanHealth.validationBudgetExhausted, true);
      assert.deepEqual(parsed.results, res.results);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  it('preserves zero-result watch candidates in JSON and human diagnostics', () => {
    const originalLog = console.log;
    const originalError = console.error;
    const stdout = [];
    const stderr = [];
    const watchCandidates = [{ gameId: 'watch-1', selection: 'Yankees', official: false }];
    const res = {
      results: [],
      scanHealth: { incomplete: true, validation: { eligible: 1, selected: 0 } },
      watchCandidates
    };
    try {
      console.log = (value) => stdout.push(value);
      console.error = (value) => stderr.push(value);
      renderScanOutput(res, {
        flags: { json: true },
        leagues: ['MLB'],
        marketList: ['Moneyline'],
        book: 'NoVigApp',
        targetTiers: ['TIER 1'],
        cardWindow: 'all',
        limit: 5
      });
      const parsed = JSON.parse(stdout[0]);
      assert.deepEqual(parsed.watchCandidates, watchCandidates);

      stdout.length = 0;
      stderr.length = 0;
      renderScanOutput(res, {
        flags: {},
        leagues: ['MLB'],
        marketList: ['Moneyline'],
        book: 'NoVigApp',
        targetTiers: ['TIER 1'],
        cardWindow: 'all',
        limit: 5
      });
      assert.match(stderr.join('\n'), /diagnostic only: 1 watch candidate/i);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });
});
