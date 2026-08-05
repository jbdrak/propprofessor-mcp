'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const settleCli = require('../scripts/settle-record');

// Task 5 CLI tests: scripts/settle-record.js settles bets from the local
// ledger (PP_RECORD_LEDGER) against SUPPLIED result data — no network, no
// PropProfessor. Runs against temp ledgers + temp results files so the
// user's home directory is never touched. Malformed inputs are rejected
// without mutating the ledger; --dry-run never writes.

function makeTotalBet(overrides = {}) {
  return {
    id: 'bet-under-75',
    candidateId: 'cand-under-75',
    gameId: 'g-123',
    game: 'Pirates @ Brewers',
    league: 'MLB',
    market: 'Total Runs',
    selection: 'Under 7.5',
    line: 7.5,
    oddsAtDecision: -115,
    stake: 50,
    decisionAt: '2026-08-04T02:30:00.000Z',
    status: 'pending',
    settlementId: null,
    candidateSnapshot: {
      candidateId: 'cand-under-75',
      gameId: 'g-123',
      game: 'Pirates @ Brewers',
      league: 'MLB',
      market: 'Total Runs',
      selection: 'Under 7.5',
      start: '2026-08-04T23:40:00.000Z',
      startCST: '2026-08-04 18:40'
    },
    ...overrides
  };
}

// Aug 4 acceptance case: Brewers 4-2 Pirates, Under 7.5 wins.
function brewersPiratesResults() {
  return {
    provider: 'espn',
    sourceUrl: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
    events: [
      {
        eventId: 'g-123',
        homeTeam: 'Milwaukee Brewers',
        awayTeam: 'Pittsburgh Pirates',
        homeScore: 4,
        awayScore: 2,
        status: 'final',
        rawStatus: 'Final',
        date: '2026-08-05T02:00:00.000Z'
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

function withTempEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-record-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  const previous = process.env.PP_RECORD_LEDGER;
  process.env.PP_RECORD_LEDGER = ledgerPath;
  t.after(() => {
    if (previous === undefined) delete process.env.PP_RECORD_LEDGER;
    else process.env.PP_RECORD_LEDGER = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, ledgerPath };
}

function writeLedger(ledgerPath, bets) {
  const ledger = { version: 2, scans: [], candidates: [], bets, settlements: [] };
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  return ledger;
}

function readLedger(ledgerPath) {
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
}

async function runCli(args) {
  const capture = captureConsole();
  const previousExitCode = process.exitCode;
  try {
    const result = await settleCli.main(['node', 'scripts/settle-record.js', ...args]);
    return { result, logs: capture.logs, errors: capture.errors };
  } finally {
    process.exitCode = previousExitCode;
    capture.restore();
  }
}

describe('settle-record CLI: settlement run', () => {
  it('settles a total bet from a temp ledger against a temp results file', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(brewersPiratesResults()), 'utf8');

    const { result, logs, errors } = await runCli(['--results', resultsPath]);

    assert.equal(result.ok, true);
    assert.equal(result.settled.length, 1);
    assert.equal(result.pending.length, 0);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.wrote, true);
    assert.equal(result.settled[0].status, 'win');
    assert.equal(result.settled[0].betId, 'bet-under-75');
    assert.equal(result.settled[0].market, 'Total Runs');
    assert.equal(result.settled[0].reason, 'final total 6 under 7.5');
    assert.equal(result.settled[0].sourceUrl, brewersPiratesResults().sourceUrl);

    const ledger = readLedger(env.ledgerPath);
    assert.equal(ledger.settlements.length, 1);
    assert.equal(ledger.settlements[0].status, 'win');
    assert.equal(ledger.settlements[0].evidence.homeScore, 4);

    assert.equal(errors.length, 0, 'human status goes to stdout, not stderr');
    assert.equal(logs.length, 1, 'one summary write on stdout');
    assert.match(logs[0], /^settle-record: 1 settled, 0 pending, 0 skipped/);
  });

  it('uses the points line field and the candidate snapshot start when present', async (t) => {
    const env = withTempEnv(t);
    const bet = makeTotalBet({ points: 7.5 });
    delete bet.line;
    writeLedger(env.ledgerPath, [bet]);
    const resultsPath = path.join(env.dir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(brewersPiratesResults()), 'utf8');

    const { result } = await runCli(['--results', resultsPath]);
    assert.equal(result.ok, true);
    assert.equal(result.settled.length, 1);
    assert.equal(result.settled[0].status, 'win');
    assert.equal(result.settled[0].scheduledStart, '2026-08-04T23:40:00.000Z');
  });

  it('prints machine-readable JSON to stdout with --json', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(brewersPiratesResults()), 'utf8');

    const { result, logs, errors } = await runCli(['--results', resultsPath, '--json']);

    assert.equal(result.ok, true);
    assert.equal(logs.length, 1, 'exactly one stdout write (the JSON payload)');
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.settled.length, 1);
    assert.equal(parsed.settled[0].status, 'win');
    assert.equal(parsed.path, env.ledgerPath);
    assert.equal(parsed.wrote, true);
    assert.equal(errors.length, 0);
  });
});

describe('settle-record CLI: --date filter', () => {
  it('settles only bets whose scheduled start is on the requested America/Chicago day', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [
      makeTotalBet(), // 2026-08-04T23:40Z = 2026-08-04 18:40 Chicago
      makeTotalBet({
        id: 'bet-next-day',
        candidateId: 'cand-next-day',
        gameId: 'g-999',
        game: 'Dodgers @ Padres',
        selection: 'Over 7.5',
        candidateSnapshot: {
          candidateId: 'cand-next-day',
          gameId: 'g-999',
          game: 'Dodgers @ Padres',
          league: 'MLB',
          market: 'Total Runs',
          selection: 'Over 7.5',
          start: '2026-08-05T18:00:00.000Z' // 2026-08-05 13:00 Chicago
        }
      })
    ]);
    const resultsPath = path.join(env.dir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(brewersPiratesResults()), 'utf8');

    const { result } = await runCli(['--results', resultsPath, '--date', '2026-08-04']);

    assert.equal(result.ok, true);
    assert.equal(result.settled.length, 1);
    assert.equal(result.settled[0].betId, 'bet-under-75');
    // The other bet was filtered out entirely — not settled, pending, or skipped.
    assert.equal(result.pending.length, 0);
    assert.equal(result.skipped.length, 0);
    const ledger = readLedger(env.ledgerPath);
    assert.equal(ledger.settlements.length, 1);
    assert.equal(ledger.settlements[0].betId, 'bet-under-75');
  });

  it('rejects an invalid --date without touching the ledger', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(brewersPiratesResults()), 'utf8');

    for (const bad of ['2026-13-01', '08-04-2026', 'not-a-date']) {
      const { result, errors } = await runCli(['--results', resultsPath, '--date', bad]);
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 2);
      assert.match(result.error, /--date/);
      assert.ok(
        errors.some((e) => e.includes('settle-record:')),
        'error goes to stderr'
      );
    }
    assert.equal(readLedger(env.ledgerPath).settlements.length, 0, 'ledger untouched');
  });
});

describe('settle-record CLI: --dry-run never writes', () => {
  it('reports the would-be settlement and leaves the ledger file unchanged', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(brewersPiratesResults()), 'utf8');
    const before = fs.readFileSync(env.ledgerPath, 'utf8');

    const { result, logs } = await runCli(['--results', resultsPath, '--dry-run']);

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.wrote, false);
    assert.equal(result.settled.length, 1);
    assert.equal(result.settled[0].status, 'win');
    assert.equal(fs.readFileSync(env.ledgerPath, 'utf8'), before, 'file bytes unchanged');
    assert.equal(readLedger(env.ledgerPath).settlements.length, 0, 'no settlement rows');
    assert.ok(
      logs.some((line) => line.includes('[dry-run]')),
      'summary flags dry-run'
    );
  });

  it('does not create a ledger file that does not exist yet', async (t) => {
    const env = withTempEnv(t);
    const resultsPath = path.join(env.dir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(brewersPiratesResults()), 'utf8');

    const { result } = await runCli(['--results', resultsPath, '--dry-run']);
    assert.equal(result.ok, true);
    assert.equal(result.settled.length, 0);
    assert.equal(result.wrote, false);
    assert.equal(fs.existsSync(env.ledgerPath), false, 'no ledger created');
  });
});

describe('settle-record CLI: --force re-settles', () => {
  it('skips already-settled bets by default and replaces them with --force', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(brewersPiratesResults()), 'utf8');

    const first = await runCli(['--results', resultsPath]);
    assert.equal(first.result.settled.length, 1);

    const second = await runCli(['--results', resultsPath]);
    assert.equal(second.result.settled.length, 0);
    assert.equal(second.result.skipped.length, 1);
    assert.equal(second.result.skipped[0].reason, 'already settled');
    assert.equal(readLedger(env.ledgerPath).settlements.length, 1, 'no duplicate rows');

    // Force re-settles: same game but a different pick grades to a loss.
    fs.writeFileSync(
      env.ledgerPath,
      JSON.stringify(
        {
          version: 2,
          scans: [],
          candidates: [],
          bets: [makeTotalBet({ selection: 'Over 7.5' })],
          settlements: readLedger(env.ledgerPath).settlements
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    const forced = await runCli(['--results', resultsPath, '--force']);
    assert.equal(forced.result.ok, true);
    assert.equal(forced.result.settled.length, 1);
    assert.equal(forced.result.settled[0].status, 'loss');
    assert.equal(readLedger(env.ledgerPath).settlements.length, 1, 'still one row per bet');
  });
});

describe('settle-record CLI: no-op runs do not rewrite the ledger', () => {
  it('reports wrote:false and leaves the file bytes untouched when every bet was already settled', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(brewersPiratesResults()), 'utf8');

    const first = await runCli(['--results', resultsPath]);
    assert.equal(first.result.settled.length, 1);
    const before = fs.readFileSync(env.ledgerPath, 'utf8');

    const second = await runCli(['--results', resultsPath]);
    assert.equal(second.result.settled.length, 0, 'nothing new to settle');
    assert.equal(second.result.skipped.length, 1);
    assert.equal(second.result.wrote, false, 'no new/updated records means nothing is written');
    assert.equal(fs.readFileSync(env.ledgerPath, 'utf8'), before, 'file bytes unchanged');
  });
});

describe('settle-record CLI: malformed input never mutates the ledger', () => {
  it('requires --results', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);

    const { result, errors } = await runCli([]);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /--results/);
    assert.ok(errors.some((e) => e.includes('settle-record:')));
    assert.equal(readLedger(env.ledgerPath).settlements.length, 0, 'ledger untouched');
  });

  it('rejects a missing results file', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const missing = path.join(env.dir, 'nope.json');

    const { result } = await runCli(['--results', missing]);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /cannot read results file/);
    assert.equal(readLedger(env.ledgerPath).settlements.length, 0, 'ledger untouched');
  });

  it('rejects malformed JSON in the results file', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'bad.json');
    fs.writeFileSync(resultsPath, '{not json', 'utf8');

    const { result } = await runCli(['--results', resultsPath]);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /invalid JSON/);
    assert.equal(readLedger(env.ledgerPath).settlements.length, 0, 'ledger untouched');
  });

  it('rejects results that are not an object with provenance', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'scalar.json');
    fs.writeFileSync(resultsPath, '"just a string"', 'utf8');

    const { result } = await runCli(['--results', resultsPath]);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /object with non-empty top-level provider/);
    assert.equal(readLedger(env.ledgerPath).settlements.length, 0, 'ledger untouched');
  });

  it('rejects a bare array of events (the old accepted contract)', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'bare-array.json');
    fs.writeFileSync(resultsPath, JSON.stringify(brewersPiratesResults().events), 'utf8');

    const { result } = await runCli(['--results', resultsPath]);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /object with non-empty top-level provider/);
    assert.equal(readLedger(env.ledgerPath).settlements.length, 0, 'ledger untouched');
  });

  it('rejects an object without a non-empty top-level provider', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'no-provider.json');
    const { provider: _provider, ...withoutProvider } = brewersPiratesResults();
    fs.writeFileSync(resultsPath, JSON.stringify(withoutProvider), 'utf8');

    const { result } = await runCli(['--results', resultsPath]);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /provider/);
    assert.equal(readLedger(env.ledgerPath).settlements.length, 0, 'ledger untouched');
  });

  it('rejects an object without a non-empty top-level sourceUrl', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'no-source.json');
    const { sourceUrl: _sourceUrl, ...withoutSourceUrl } = brewersPiratesResults();
    fs.writeFileSync(resultsPath, JSON.stringify(withoutSourceUrl), 'utf8');

    const { result } = await runCli(['--results', resultsPath]);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /sourceUrl/);
    assert.equal(readLedger(env.ledgerPath).settlements.length, 0, 'ledger untouched');
  });

  it('rejects empty or non-string provider/sourceUrl values', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'empty-provider.json');

    fs.writeFileSync(resultsPath, JSON.stringify({ ...brewersPiratesResults(), provider: '   ' }), 'utf8');
    const emptyProvider = await runCli(['--results', resultsPath]);
    assert.equal(emptyProvider.result.ok, false);
    assert.equal(emptyProvider.result.exitCode, 2);
    assert.match(emptyProvider.result.error, /provider/);

    fs.writeFileSync(resultsPath, JSON.stringify({ ...brewersPiratesResults(), sourceUrl: 42 }), 'utf8');
    const nonStringSource = await runCli(['--results', resultsPath]);
    assert.equal(nonStringSource.result.ok, false);
    assert.equal(nonStringSource.result.exitCode, 2);
    assert.match(nonStringSource.result.error, /sourceUrl/);
    assert.equal(readLedger(env.ledgerPath).settlements.length, 0, 'ledger untouched');
  });

  it('rejects unknown flags before doing any work', async (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(brewersPiratesResults()), 'utf8');

    const { result } = await runCli(['--results', resultsPath, '--result']);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /unknown argument/);
    assert.equal(readLedger(env.ledgerPath).settlements.length, 0, 'ledger untouched');
  });

  it('reports a ledger that cannot be read as an operational error', async (t) => {
    const env = withTempEnv(t);
    // Directory where the ledger should be, but it is a directory -> EISDIR.
    fs.mkdirSync(env.ledgerPath);
    const resultsPath = path.join(env.dir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(brewersPiratesResults()), 'utf8');

    const { result } = await runCli(['--results', resultsPath]);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.error, /Unable to read ledger/);
  });
});

describe('settle-record CLI: standalone entry point', () => {
  const script = path.join(__dirname, '..', 'scripts', 'settle-record.js');

  it('runs as a real subprocess with --json and exits 0', (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const resultsPath = path.join(env.dir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(brewersPiratesResults()), 'utf8');

    const stdout = execFileSync(process.execPath, [script, '--results', resultsPath, '--json'], {
      env: { ...process.env, PP_RECORD_LEDGER: env.ledgerPath },
      encoding: 'utf8'
    });
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.settled[0].status, 'win');
    assert.equal(parsed.path, env.ledgerPath);
    assert.equal(readLedger(env.ledgerPath).settlements.length, 1);
  });

  it('exits 2 with a stderr message for results without provenance and leaves the ledger alone', (t) => {
    const env = withTempEnv(t);
    writeLedger(env.ledgerPath, [makeTotalBet()]);
    const badPath = path.join(env.dir, 'bad.json');
    fs.writeFileSync(badPath, JSON.stringify(brewersPiratesResults().events), 'utf8');

    let threw = null;
    let stderr = '';
    try {
      execFileSync(process.execPath, [script, '--results', badPath], {
        env: { ...process.env, PP_RECORD_LEDGER: env.ledgerPath },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      threw = error;
      stderr = String(error.stderr || '');
    }
    assert.ok(threw, 'subprocess must exit nonzero');
    assert.equal(threw.status, 2);
    assert.match(stderr, /settle-record:/);
    assert.match(stderr, /provider/);
    assert.equal(readLedger(env.ledgerPath).settlements.length, 0, 'ledger untouched');
  });
});
