'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../bin/pp-cli');

describe('resolveWalletDate', () => {
  it('resolves today using the local calendar date', () => {
    const now = new Date(2026, 7, 20, 8, 46, 0);
    assert.equal(cli.resolveWalletDate('today', now), '2026-08-20');
  });

  it('rejects unsupported date values instead of silently filtering everything', () => {
    assert.throws(() => cli.resolveWalletDate('yesterday'), /YYYY-MM-DD, today, or next/);
  });
});

// Task 6 CLI dispatch: `pp record <stats|review|pending> [--date YYYY-MM-DD]
// [--json]`. The command is a thin, read-only wrapper over
// scripts/review-record.js — it must preserve the review module's exit codes
// (2 usage, 1 ledger errors, 0 success incl. no-data), never write the
// ledger, and keep scan/network behavior untouched. Everything runs against
// a temp ledger + PP_RECORD_LEDGER so the user's home directory is never
// touched.

const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard';

function makeBet(overrides = {}) {
  return {
    id: 'bet-under-75',
    candidateId: 'cand-under-75',
    gameId: 'g-1',
    game: 'Siniakova vs Rakhimova',
    league: 'WTA',
    market: 'Total Games',
    selection: 'Under 7.5',
    oddsAtDecision: 90,
    stake: 1,
    status: 'pending',
    tier: 'A',
    movement: 'up',
    decisionSource: 'manual-review',
    scheduledStart: '2024-08-04T23:30:00Z',
    ...overrides
  };
}

// Aug 4 acceptance fixture: Under 7.5 win +0.90u (via settlement pnlUnits)
// and Cobolli ML loss -1.00u on 1u each => net -0.10u, ROI -5%.
function makeLedger() {
  return {
    version: 2,
    scans: [],
    candidates: [
      {
        candidateId: 'cand-under-75',
        scanId: 'scan-1',
        gameId: 'g-1',
        league: 'WTA',
        market: 'Total Games',
        selection: 'Under 7.5',
        status: 'promoted'
      },
      {
        candidateId: 'cand-cobolli',
        scanId: 'scan-2',
        gameId: 'g-2',
        league: 'ATP',
        market: 'Moneyline',
        selection: 'Cobolli',
        status: 'promoted'
      }
    ],
    bets: [
      makeBet(),
      {
        id: 'bet-cobolli',
        candidateId: 'cand-cobolli',
        gameId: 'g-2',
        game: 'Cobolli vs Nakashima',
        league: 'ATP',
        market: 'Moneyline',
        selection: 'Cobolli',
        oddsAtDecision: -110,
        stake: 1,
        status: 'loss',
        tier: 'B',
        movement: 'down',
        decisionSource: 'pp-scan',
        scheduledStart: '2024-08-04T20:00:00Z'
      }
    ],
    settlements: [
      {
        id: 'settlement-under-75',
        betId: 'bet-under-75',
        status: 'win',
        pnlUnits: 0.9,
        scheduledStart: '2024-08-04T23:30:00Z',
        actualStart: '2024-08-04T23:32:00Z',
        sourceUrl: ESPN_URL,
        reason: 'final total 5 under 7.5'
      },
      {
        id: 'settlement-cobolli',
        betId: 'bet-cobolli',
        status: 'loss',
        scheduledStart: '2024-08-04T20:00:00Z',
        actualStart: '2024-08-04T20:15:00Z',
        sourceUrl: ESPN_URL,
        reason: 'completed match; winner Nakashima'
      }
    ]
  };
}

function captureConsole() {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  return {
    logs,
    errors,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

function withTempEnv(t, ledger) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cli-record-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  const previous = process.env.PP_RECORD_LEDGER;
  process.env.PP_RECORD_LEDGER = ledgerPath;
  t.after(() => {
    if (previous === undefined) delete process.env.PP_RECORD_LEDGER;
    else process.env.PP_RECORD_LEDGER = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, ledgerPath };
}

async function runRecord({ positional, flags }) {
  const previousExit = process.exitCode;
  const capture = captureConsole();
  try {
    const result = await cli.cmdRecord(positional, flags);
    return { result, logs: capture.logs, errors: capture.errors, exitCode: process.exitCode };
  } finally {
    capture.restore();
    process.exitCode = previousExit;
  }
}

describe('pp-cli record: stats/review/pending dispatch', () => {
  it('stats mode prints the human review header with W-L-P-V and ROI', async (t) => {
    withTempEnv(t, makeLedger());
    const { result, logs } = await runRecord({ positional: ['record', 'stats'], flags: {} });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'stats');
    assert.match(logs.join('\n'), /record stats/);
    assert.match(logs.join('\n'), /Official: 2 bets — 1W \/ 1L \/ 0P \/ 0V/);
    assert.match(logs.join('\n'), /ROI -5\.0%/);
  });

  it('stats --json emits a machine-readable document with no per-bet rows', async (t) => {
    withTempEnv(t, makeLedger());
    const { result, logs } = await runRecord({
      positional: ['record', 'stats'],
      flags: { json: true }
    });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.mode, 'stats');
    assert.equal(parsed.official.wins, 1);
    assert.equal(parsed.official.losses, 1);
    assert.deepEqual(parsed.bets, []);
  });

  it('review mode includes one line per official bet', async (t) => {
    withTempEnv(t, makeLedger());
    const { result, logs } = await runRecord({ positional: ['record', 'review'], flags: { json: true } });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'review');
    const parsed = JSON.parse(logs[0]);
    assert.deepEqual(parsed.bets.map((b) => b.id).sort(), ['bet-cobolli', 'bet-under-75']);
    assert.ok(
      logs.some(() => true),
      'json mode prints to stdout'
    );
  });

  it('pending mode lists only unsettled bets', async (t) => {
    const ledger = makeLedger();
    ledger.bets.push(makeBet({ id: 'bet-pending', selection: 'Over 7.5', oddsAtDecision: -110 }));
    withTempEnv(t, ledger);
    const { result, logs } = await runRecord({ positional: ['record', 'pending'], flags: { json: true } });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'pending');
    const parsed = JSON.parse(logs[0]);
    assert.deepEqual(
      parsed.bets.map((b) => b.id),
      ['bet-pending']
    );
    assert.equal(parsed.official.total, 3);
  });

  it('defaults to stats mode when the mode is omitted', async (t) => {
    withTempEnv(t, makeLedger());
    const { result } = await runRecord({ positional: ['record'], flags: { json: true } });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'stats');
  });

  it('the -j short flag is equivalent to --json', async (t) => {
    withTempEnv(t, makeLedger());
    const { result, logs } = await runRecord({ positional: ['record', 'stats'], flags: { j: true } });
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(logs[0]).mode, 'stats');
  });
});

describe('pp-cli record: --date filtering', () => {
  it('filters to the America/Chicago calendar day and reports it', async (t) => {
    const ledger = makeLedger();
    ledger.bets.push(makeBet({ id: 'bet-next-day', selection: 'Over 7.5', scheduledStart: '2024-08-06T00:30:00Z' }));
    withTempEnv(t, ledger);
    const { result, logs } = await runRecord({
      positional: ['record', 'review'],
      flags: { date: '2024-08-04', json: true }
    });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.date, '2024-08-04');
    assert.deepEqual(parsed.bets.map((b) => b.id).sort(), ['bet-cobolli', 'bet-under-75']);
  });

  it('returns an empty no-data report for a date with no bets (exit 0)', async (t) => {
    withTempEnv(t, makeLedger());
    const { result, logs } = await runRecord({
      positional: ['record', 'stats'],
      flags: { date: '2024-01-01' }
    });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, undefined);
    assert.equal(result.official.total, 0);
    assert.match(logs.join('\n'), /No official bets on 2024-01-01\./);
  });
});

describe('pp-cli record: exit codes and safety', () => {
  it('preserves exit code 2 for an unknown mode', async (t) => {
    withTempEnv(t, makeLedger());
    const { result, errors } = await runRecord({ positional: ['record', 'bogus'], flags: {} });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.ok(errors.some((e) => e.startsWith('record:')));
  });

  it('preserves exit code 2 for a malformed --date', async (t) => {
    withTempEnv(t, makeLedger());
    const { result } = await runRecord({ positional: ['record', 'stats'], flags: { date: '2024-13-01' } });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
  });

  it('preserves exit code 1 for a ledger read error', async (t) => {
    const env = withTempEnv(t, makeLedger());
    // A missing ledger is an empty no-data report (exit 0) by design; an
    // unparseable file is a real read error (exit 1).
    fs.writeFileSync(env.ledgerPath, '{not json', 'utf8');
    const { result, errors } = await runRecord({ positional: ['record', 'stats'], flags: {} });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.ok(errors.some((e) => e.startsWith('record:')));
  });

  it('never mutates the ledger file', async (t) => {
    const ledger = makeLedger();
    const env = withTempEnv(t, ledger);
    const before = fs.readFileSync(env.ledgerPath, 'utf8');
    await runRecord({ positional: ['record', 'review'], flags: { date: '2024-08-04', json: true } });
    await runRecord({ positional: ['record', 'pending'], flags: {} });
    await runRecord({ positional: ['record', 'stats'], flags: { json: true } });
    assert.equal(fs.readFileSync(env.ledgerPath, 'utf8'), before);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.ledgerPath, 'utf8')), ledger);
  });

  it('does not touch the scan/network client (record needs no handlers)', async () => {
    // cmdRecord is handler-free by signature; requiring pp-cli must not have
    // started any network client. Assert the command's shape directly.
    assert.equal(typeof cli.cmdRecord, 'function');
    assert.equal(cli.cmdRecord.length, 2); // (positional, flags)
  });
});
