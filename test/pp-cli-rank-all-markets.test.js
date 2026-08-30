'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cmdRank, parseArgs } = require('../bin/pp-cli');
const { getMarketsForSport } = require('../lib/propprofessor-market-registry');

// Capture stdout/stderr and record every screen_ranked invocation so the test
// can assert which (league, market) pairs the rank command dispatched.
function makeCapture() {
  const originalError = console.error;
  const originalLog = console.log;
  const stdout = [];
  const stderr = [];
  const calls = [];
  console.error = (value) => stderr.push(String(value));
  console.log = (value) => stdout.push(value);
  const handlers = {
    screen_ranked: async (args) => {
      calls.push(args);
      return { result: [] };
    }
  };
  function restore() {
    console.error = originalError;
    console.log = originalLog;
  }
  return { handlers, calls, stdout, stderr, restore };
}

async function runRank(flags, positional = ['rank', 'MLB']) {
  const cap = makeCapture();
  try {
    await cmdRank(cap.handlers, positional, flags);
  } finally {
    cap.restore();
  }
  return cap;
}

// A capture whose screen_ranked echoes back the requested market and stamps a
// per-call resultMeta so we can assert the --all-markets JSON merge preserves
// market metadata and diagnostics from each dispatched call.
function makeMetaCapture() {
  const cap = makeCapture();
  cap.handlers.screen_ranked = async (args) => {
    cap.calls.push(args);
    const idx = cap.calls.length;
    // One synthetic row per call, tagged with the market, so the merged
    // result carries identifiable per-market rows.
    return {
      market: args.market,
      book: (args.books && args.books[0]) || 'NoVigApp',
      result: [{ market: args.market, selection: 'Row ' + idx }],
      resultMeta: { calledWithMarket: args.market, callIndex: idx }
    };
  };
  return cap;
}

async function runRankMeta(flags, positional = ['rank', 'MLB']) {
  const cap = makeMetaCapture();
  try {
    await cmdRank(cap.handlers, positional, flags);
  } finally {
    cap.restore();
  }
  return cap;
}

describe('pp rank explicit market selection', () => {
  it('passes the explicit -m market straight through to screen_ranked', async () => {
    const cap = await runRank({ m: 'Run Line' });
    assert.equal(cap.calls.length, 1);
    assert.equal(cap.calls[0].league, 'MLB');
    assert.equal(cap.calls[0].market, 'Run Line');
    // No fallback market should be applied when one is given.
    assert.notEqual(cap.calls[0].market, 'Moneyline');
  });

  it('passes the long --market form through to screen_ranked', async () => {
    const cap = await runRank({ market: 'Total Runs' });
    assert.equal(cap.calls.length, 1);
    assert.equal(cap.calls[0].market, 'Total Runs');
  });

  it('leaves market undefined (no -m) so the handler applies its own default', async () => {
    const cap = await runRank({});
    assert.equal(cap.calls.length, 1);
    assert.equal(cap.calls[0].market, undefined);
  });

  it('parseArgs surfaces --all-markets as a boolean flag', () => {
    const { flags } = parseArgs(['node', 'pp', 'rank', 'NBA', '--all-markets']);
    assert.equal(flags['all-markets'], true);
  });
});

describe('pp rank --all-markets dispatch contract', () => {
  it('dispatches one screen_ranked call per registry-default market for the league', async () => {
    const expected = getMarketsForSport('MLB');
    const cap = await runRank({ 'all-markets': true }, ['rank', 'MLB']);

    assert.ok(expected.length > 0, 'MLB must have registry-default markets');
    assert.equal(
      cap.calls.length,
      expected.length,
      `--all-markets should fan out to exactly the ${expected.length} MLB registry markets`
    );

    const dispatched = cap.calls.map((c) => c.market).sort();
    const wanted = [...expected].sort();
    assert.deepEqual(dispatched, wanted, 'every registry-default market must be dispatched exactly once');

    // Every dispatched call must target the same league and the same book list.
    for (const c of cap.calls) {
      assert.equal(c.league, 'MLB');
      assert.deepEqual(c.books, ['NoVigApp']);
    }
  });

  it('dispatches the correct per-league registry markets (NBA)', async () => {
    const expected = getMarketsForSport('NBA');
    const cap = await runRank({ 'all-markets': true }, ['rank', 'NBA']);
    const dispatched = cap.calls.map((c) => c.market).sort();
    assert.deepEqual(dispatched, [...expected].sort());
  });

  it('explicit -m takes precedence over --all-markets (single market wins)', async () => {
    const cap = await runRank({ 'all-markets': true, m: 'Run Line' }, ['rank', 'MLB']);
    assert.equal(cap.calls.length, 1, 'when both flags are given, explicit -m must win');
    assert.equal(cap.calls[0].market, 'Run Line');
  });
});

describe('pp rank --all-markets merged JSON/metadata contract', () => {
  it('merges per-market rows into a single result and stamps resultMeta', async () => {
    const expected = getMarketsForSport('MLB');
    const cap = await runRankMeta({ 'all-markets': true, j: true }, ['rank', 'MLB']);

    // JSON output is a single stringified object on stdout.
    assert.equal(cap.stdout.length, 1, 'JSON mode writes exactly one object');
    const merged = JSON.parse(cap.stdout[0]);

    // All per-market rows are present, exactly once each.
    assert.equal(merged.result.length, expected.length, 'one merged row per registry market');
    const mergedMarkets = merged.result.map((r) => r.market).sort();
    assert.deepEqual(mergedMarkets, [...expected].sort(), 'every market row survived the merge');

    // resultMeta diagnostics are preserved.
    assert.equal(merged.resultMeta.source, 'pp-rank-all-markets');
    assert.equal(merged.resultMeta.league, 'MLB');
    assert.equal(merged.resultMeta.marketCount, expected.length);
    assert.equal(merged.resultMeta.dispatched, expected.length);
    assert.equal(merged.resultMeta.merged, expected.length);
    assert.equal(merged.resultMeta.markets.length, expected.length);
    for (const m of merged.resultMeta.markets) {
      assert.ok(expected.includes(m.market), 'resultMeta.markets lists a real registry market');
      assert.equal(m.dispatched, 1);
      assert.equal(m.merged, 1);
    }
  });

  it('preserves each call’s per-market resultMeta diagnostics under callDiagnostics', async () => {
    const cap = await runRankMeta({ 'all-markets': true, j: true }, ['rank', 'NBA']);
    const merged = JSON.parse(cap.stdout[0]);

    assert.ok(Array.isArray(merged.resultMeta.callDiagnostics), 'callDiagnostics captured per-call meta');
    assert.equal(merged.resultMeta.callDiagnostics.length, getMarketsForSport('NBA').length);
    // Every call's calledWithMarket diagnostic is retained.
    const called = merged.resultMeta.callDiagnostics.map((d) => d.calledWithMarket).sort();
    assert.deepEqual(called, [...getMarketsForSport('NBA')].sort());
  });

  it('non-JSON --all-markets still dispatches every market and renders grouped output', async () => {
    const expected = getMarketsForSport('MLB');
    const cap = await runRankMeta({ 'all-markets': true }, ['rank', 'MLB']);
    assert.equal(cap.calls.length, expected.length, 'dispatches every registry market');
    // Human-readable header includes the league and a merged market tag list.
    const header = cap.stdout.find((l) => String(l).includes('ranked plays'));
    assert.ok(header, 'grouped header rendered');
    assert.ok(String(header).includes('MLB'), 'league present in header');
    for (const m of expected) {
      assert.ok(String(header).includes(m), `market ${m} tagged in header`);
    }
  });
});
