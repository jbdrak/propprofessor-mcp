'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const migrate = require('../scripts/migrate-tracker');

// Task 7 CLI tests: scripts/migrate-tracker.js imports the legacy Python
// tracker's bets (~/.propprofessor/tracker/bets.json) into the v2 local
// ledger without double-counting. All tests run against temp files — the
// real ~/.propprofessor/tracker/bets.json is never read or written here.
// Dry-run is the default; only --apply writes, and it backs up the
// destination ledger first. Malformed input never touches any file.

function legacyBets() {
  return [
    {
      id: 'aaa111',
      loggedAt: '2026-07-26T08:55:07.422070+00:00',
      game: 'Boston Red Sox vs Toronto Blue Jays',
      gameId: 'MLB:PREMATCH:Boston_Red_Sox:Toronto_Blue_Jays:1785087300',
      league: 'MLB',
      market: 'Moneyline',
      selection: 'Boston Red Sox',
      odds: -130,
      tier: 'TIER 1',
      kai: 'BET',
      movement: 'supportive_bouncy',
      edge: 2.0,
      consensusBookCount: 5,
      sport: 'mlb',
      stake: 1,
      status: 'win',
      settledAt: '2026-07-27T15:01:11.722906+00:00',
      plUnits: 0.77
    },
    {
      id: 'bbb222',
      loggedAt: '2026-07-26T08:55:07.422070+00:00',
      game: 'Assche vs Blockx',
      gameId: 'Tennis:PREMATCH:Assche:Blockx:1785083700',
      league: 'Tennis',
      market: 'Moneyline',
      selection: 'Blockx',
      odds: -174,
      stake: 1,
      status: 'loss',
      settledAt: '2026-07-28T18:13:50.713336+00:00',
      plUnits: -1
    }
  ];
}

function writeLegacyFile(dir, bets, version = 1) {
  const sourcePath = path.join(dir, 'bets.json');
  fs.writeFileSync(sourcePath, `${JSON.stringify({ version, bets }, null, 2)}\n`, 'utf8');
  return sourcePath;
}

function withTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-tracker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readLedger(ledgerPath) {
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
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

async function runCli(args) {
  const capture = captureConsole();
  const previousExitCode = process.exitCode;
  try {
    const result = await migrate.main(['node', 'scripts/migrate-tracker.js', ...args]);
    return { result, logs: capture.logs, errors: capture.errors };
  } finally {
    process.exitCode = previousExitCode;
    capture.restore();
  }
}

describe('migrate-tracker: argument parsing', () => {
  it('defaults to dry-run with the standard source and ledger paths', () => {
    const options = migrate.parseArgs(['node', 'scripts/migrate-tracker.js']);
    assert.equal(options.apply, false);
    assert.equal(options.dryRun, false); // dryRun flag only tracks an explicit --dry-run
    assert.equal(options.json, false);
    assert.equal(options.source, null);
    assert.equal(options.ledger, null);
  });

  it('parses --source/--ledger in both flag and equals forms', () => {
    const spaced = migrate.parseArgs(['node', 'x', '--source', 'a.json', '--ledger', 'b.json']);
    assert.equal(spaced.source, 'a.json');
    assert.equal(spaced.ledger, 'b.json');
    const equals = migrate.parseArgs(['node', 'x', '--source=a.json', '--ledger=b.json']);
    assert.equal(equals.source, 'a.json');
    assert.equal(equals.ledger, 'b.json');
  });

  it('rejects combining --apply with --dry-run', () => {
    const options = migrate.parseArgs(['node', 'x', '--apply', '--dry-run']);
    assert.match(options.parseError, /cannot combine/);
  });

  it('rejects unknown arguments and missing values', () => {
    assert.match(migrate.parseArgs(['node', 'x', '--nope']).parseError, /unknown argument/);
    assert.match(migrate.parseArgs(['node', 'x', '--source']).parseError, /missing value/);
  });
});

describe('migrate-tracker: legacy file validation', () => {
  it('accepts a valid { version, bets } legacy file', () => {
    const result = migrate.validateLegacyFile({ version: 1, bets: legacyBets() });
    assert.equal(result.ok, true);
    assert.equal(result.bets.length, 2);
  });

  it('rejects non-objects, missing bets arrays, and non-object bets', () => {
    for (const bad of [null, 'x', 5, [], { version: 1 }, { bets: 'nope' }, { bets: [null] }, { bets: [['x']] }]) {
      const result = migrate.validateLegacyFile(bad);
      assert.equal(result.ok, false, JSON.stringify(bad));
    }
  });

  it('rejects duplicate legacy ids within one file', () => {
    const bets = legacyBets();
    bets[1] = { ...bets[0] };
    const result = migrate.validateLegacyFile({ version: 1, bets });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /duplicate legacy id/);
  });

  it('rejects invalid statuses and missing selections', () => {
    const badStatus = legacyBets();
    badStatus[0].status = 'refunded';
    const result1 = migrate.validateLegacyFile({ version: 1, bets: badStatus });
    assert.equal(result1.ok, false);
    assert.match(result1.errors.join(' '), /status must be one of/);

    const noSelection = legacyBets();
    delete noSelection[1].selection;
    const result2 = migrate.validateLegacyFile({ version: 1, bets: noSelection });
    assert.equal(result2.ok, false);
    assert.match(result2.errors.join(' '), /selection/);
  });
});

describe('migrate-tracker: event date handling', () => {
  it('maps missing event dates to unknown rather than guessing', () => {
    const event = migrate.extractEventDate({ loggedAt: '2026-07-26T08:55:07Z', settledAt: '2026-07-27T15:01:11Z' });
    assert.equal(event.value, 'unknown');
    assert.equal(event.sourceField, null);
    assert.equal(event.warning, null);
  });

  it('uses an explicit legacy date field when present', () => {
    const event = migrate.extractEventDate({ eventDate: '2026-07-26T18:00:00-05:00' });
    assert.equal(event.value, '2026-07-26T23:00:00.000Z');
    assert.equal(event.sourceField, 'eventDate');
    const start = migrate.extractEventDate({ start: '2026-07-26T18:40:00-05:00' });
    assert.equal(start.value, '2026-07-26T23:40:00.000Z');
    assert.equal(start.sourceField, 'start');
  });

  it('treats a present-but-unparseable date as unknown with a warning', () => {
    const event = migrate.extractEventDate({ start: 'not-a-date' });
    assert.equal(event.value, 'unknown');
    assert.match(event.warning, /not a parseable date/);
  });
});

describe('migrate-tracker: dry-run is the default and never writes', () => {
  it('reports the would-be import without creating any file', async (t) => {
    const dir = withTempDir(t);
    const sourcePath = writeLegacyFile(dir, legacyBets());
    const ledgerPath = path.join(dir, 'ledger.json');

    const { result, logs, errors } = await runCli(['--source', sourcePath, '--ledger', ledgerPath]);

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.apply, false);
    assert.equal(result.wrote, false);
    assert.equal(result.summary.total, 2);
    assert.equal(result.summary.new, 2);
    assert.equal(result.summary.duplicates, 0);
    assert.equal(result.summary.unknownDates, 2);
    assert.equal(result.imported.length, 2);
    assert.equal(fs.existsSync(ledgerPath), false, 'no ledger file created');
    assert.equal(fs.readdirSync(dir).length, 1, 'only the source file exists');
    assert.equal(errors.length, 0);
    assert.ok(
      logs.some((line) => line.includes('[dry-run]')),
      'summary flags dry-run'
    );
  });

  it('leaves an existing ledger byte-for-byte unchanged and makes no backup', async (t) => {
    const dir = withTempDir(t);
    const sourcePath = writeLegacyFile(dir, legacyBets());
    const ledgerPath = path.join(dir, 'ledger.json');
    const existing = { version: 2, scans: [], candidates: [], bets: [], settlements: [] };
    fs.writeFileSync(ledgerPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
    const before = fs.readFileSync(ledgerPath, 'utf8');

    const { result } = await runCli(['--source', sourcePath, '--ledger', ledgerPath]);

    assert.equal(result.ok, true);
    assert.equal(result.wrote, false);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), before, 'ledger bytes unchanged');
    assert.equal(
      fs.readdirSync(dir).filter((name) => name.includes('.bak-')).length,
      0,
      'no backup created during dry-run'
    );
  });
});

describe('migrate-tracker: --apply imports records', () => {
  it('imports legacy records preserving id, status, P&L, and legacy metadata', async (t) => {
    const dir = withTempDir(t);
    const sourcePath = writeLegacyFile(dir, legacyBets());
    const ledgerPath = path.join(dir, 'ledger.json');

    const { result, logs } = await runCli(['--source', sourcePath, '--ledger', ledgerPath, '--apply', '--json']);

    assert.equal(result.ok, true);
    assert.equal(result.apply, true);
    assert.equal(result.dryRun, false);
    assert.equal(result.wrote, true);
    assert.equal(result.backupPath, null, 'no backup needed on first migration');
    assert.equal(result.summary.new, 2);
    assert.equal(result.summary.pnlUnitsImported, -0.23);

    const ledger = readLedger(ledgerPath);
    assert.equal(ledger.version, 2);
    assert.equal(ledger.bets.length, 2);

    const first = ledger.bets.find((bet) => bet.id === 'aaa111');
    assert.equal(first.status, 'win');
    assert.equal(first.plUnits, 0.77);
    assert.equal(first.selection, 'Boston Red Sox');
    assert.equal(first.market, 'Moneyline');
    assert.equal(first.oddsAtDecision, -130);
    assert.equal(first.stake, 1);
    assert.equal(first.eventDate, 'unknown');
    assert.equal(first.eventDateSource, null);
    assert.equal(first.settlementId, null);
    assert.equal(first.migration.source, 'legacy_tracker_bets_json');
    assert.equal(first.migration.legacyId, 'aaa111');
    assert.equal(first.migration.sourceVersion, 1);
    // Full original record preserved verbatim in metadata.
    assert.deepEqual(first.legacy, legacyBets()[0]);
    assert.equal(first.legacy.kai, 'BET');
    assert.equal(first.legacy.movement, 'supportive_bouncy');

    const second = ledger.bets.find((bet) => bet.id === 'bbb222');
    assert.equal(second.status, 'loss');
    assert.equal(second.plUnits, -1);

    assert.ok(
      logs.some((line) => line.includes('"wrote":true')),
      '--json prints the result object'
    );
  });

  it('is idempotent: re-running --apply never double-counts', async (t) => {
    const dir = withTempDir(t);
    const sourcePath = writeLegacyFile(dir, legacyBets());
    const ledgerPath = path.join(dir, 'ledger.json');

    const first = await runCli(['--source', sourcePath, '--ledger', ledgerPath, '--apply']);
    assert.equal(first.result.wrote, true);
    assert.equal(first.result.summary.new, 2);
    const afterFirst = fs.readFileSync(ledgerPath, 'utf8');

    const second = await runCli(['--source', sourcePath, '--ledger', ledgerPath, '--apply']);
    assert.equal(second.result.ok, true);
    assert.equal(second.result.alreadyMigrated, true);
    assert.equal(second.result.wrote, false, 'nothing new -> no write');
    assert.equal(second.result.summary.new, 0);
    assert.equal(second.result.summary.duplicates, 2);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), afterFirst, 'ledger unchanged on re-run');
    assert.equal(readLedger(ledgerPath).bets.length, 2, 'still exactly 2 bets');
  });

  it('backs up an existing destination ledger before apply', async (t) => {
    const dir = withTempDir(t);
    const sourcePath = writeLegacyFile(dir, legacyBets());
    const ledgerPath = path.join(dir, 'ledger.json');
    const existing = {
      version: 2,
      scans: [],
      candidates: [],
      bets: [
        {
          id: 'bet-existing',
          candidateId: 'cand-x',
          game: 'Pirates @ Brewers',
          league: 'MLB',
          market: 'Total Runs',
          selection: 'Under 7.5',
          status: 'pending',
          settlementId: null
        }
      ],
      settlements: []
    };
    fs.writeFileSync(ledgerPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
    const before = fs.readFileSync(ledgerPath, 'utf8');

    const { result } = await runCli(['--source', sourcePath, '--ledger', ledgerPath, '--apply']);

    assert.equal(result.ok, true);
    assert.equal(result.wrote, true);
    assert.ok(result.backupPath, 'backup path reported');
    assert.match(result.backupPath, /\.bak-/);
    assert.equal(fs.existsSync(result.backupPath), true, 'backup file exists');
    assert.equal(fs.readFileSync(result.backupPath, 'utf8'), before, 'backup holds the pre-apply ledger');

    const ledger = readLedger(ledgerPath);
    assert.equal(ledger.bets.length, 3, 'existing bet preserved, 2 imported');
    assert.ok(
      ledger.bets.some((bet) => bet.id === 'bet-existing'),
      'existing bet untouched'
    );
    assert.ok(ledger.bets.some((bet) => bet.id === 'aaa111'));
  });

  it('never modifies the legacy source file', async (t) => {
    const dir = withTempDir(t);
    const sourcePath = writeLegacyFile(dir, legacyBets());
    const ledgerPath = path.join(dir, 'ledger.json');
    const before = fs.readFileSync(sourcePath, 'utf8');

    const { result } = await runCli(['--source', sourcePath, '--ledger', ledgerPath, '--apply']);
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), before, 'bets.json untouched');
  });

  it('imports a legacy record with an explicit event date as a real date', async (t) => {
    const dir = withTempDir(t);
    const bets = legacyBets();
    bets[0].eventDate = '2026-07-26T23:40:00.000Z';
    const sourcePath = writeLegacyFile(dir, bets);
    const ledgerPath = path.join(dir, 'ledger.json');

    const { result } = await runCli(['--source', sourcePath, '--ledger', ledgerPath, '--apply']);
    assert.equal(result.ok, true);
    assert.equal(result.summary.unknownDates, 1, 'only the date-less record is unknown');
    const ledger = readLedger(ledgerPath);
    assert.equal(ledger.bets.find((bet) => bet.id === 'aaa111').eventDate, '2026-07-26T23:40:00.000Z');
    assert.equal(ledger.bets.find((bet) => bet.id === 'bbb222').eventDate, 'unknown');
  });
});

describe('migrate-tracker: malformed input fails without writes', () => {
  it('rejects invalid JSON before touching the ledger', async (t) => {
    const dir = withTempDir(t);
    const sourcePath = path.join(dir, 'bets.json');
    fs.writeFileSync(sourcePath, '{not json', 'utf8');
    const ledgerPath = path.join(dir, 'ledger.json');

    const { result, errors } = await runCli(['--source', sourcePath, '--ledger', ledgerPath, '--apply']);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /invalid JSON/);
    assert.equal(fs.existsSync(ledgerPath), false, 'no ledger created');
    assert.ok(errors.some((e) => e.includes('migrate-tracker:')));
  });

  it('rejects invalid records and leaves an existing ledger unchanged', async (t) => {
    const dir = withTempDir(t);
    const bad = legacyBets();
    bad[0].status = 'refunded';
    const sourcePath = writeLegacyFile(dir, bad);
    const ledgerPath = path.join(dir, 'ledger.json');
    const existing = { version: 2, scans: [], candidates: [], bets: [], settlements: [] };
    fs.writeFileSync(ledgerPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
    const before = fs.readFileSync(ledgerPath, 'utf8');

    const { result } = await runCli(['--source', sourcePath, '--ledger', ledgerPath, '--apply']);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /invalid legacy tracker file/);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), before, 'ledger untouched');
  });

  it('rejects duplicate legacy ids without writing anything', async (t) => {
    const dir = withTempDir(t);
    const bets = legacyBets();
    bets[1] = { ...bets[0] };
    const sourcePath = writeLegacyFile(dir, bets);
    const ledgerPath = path.join(dir, 'ledger.json');

    const { result } = await runCli(['--source', sourcePath, '--ledger', ledgerPath, '--apply']);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /duplicate legacy id/);
    assert.equal(fs.existsSync(ledgerPath), false);
  });

  it('refuses to run when source and ledger resolve to the same file', async (t) => {
    const dir = withTempDir(t);
    const sourcePath = writeLegacyFile(dir, legacyBets());
    const { result } = await runCli(['--source', sourcePath, '--ledger', sourcePath, '--apply']);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.error, /bets.json is never overwritten/);
  });

  it('reports missing optional fields as warnings, not guesses', async (t) => {
    const dir = withTempDir(t);
    const bets = legacyBets();
    delete bets[0].plUnits;
    delete bets[1].market;
    const sourcePath = writeLegacyFile(dir, bets);
    const ledgerPath = path.join(dir, 'ledger.json');

    const { result } = await runCli(['--source', sourcePath, '--ledger', ledgerPath]);
    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.some((w) => w.includes('aaa111: missing plUnits')));
    assert.ok(result.warnings.some((w) => w.includes('bbb222: missing market')));
    assert.equal(result.imported[0].plUnits, null, 'missing P&L stays null, never guessed');
  });
});

describe('migrate-tracker: standalone entry point', () => {
  const script = path.join(__dirname, '..', 'scripts', 'migrate-tracker.js');

  it('runs as a real subprocess with --apply --json and exits 0', (t) => {
    const dir = withTempDir(t);
    const sourcePath = writeLegacyFile(dir, legacyBets());
    const ledgerPath = path.join(dir, 'ledger.json');

    const stdout = execFileSync(
      process.execPath,
      [script, '--source', sourcePath, '--ledger', ledgerPath, '--apply', '--json'],
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.wrote, true);
    assert.equal(parsed.summary.new, 2);
    assert.equal(readLedger(ledgerPath).bets.length, 2);
  });

  it('exits 0 on dry-run without writing, even when nothing was imported before', (t) => {
    const dir = withTempDir(t);
    const sourcePath = writeLegacyFile(dir, legacyBets());
    const ledgerPath = path.join(dir, 'ledger.json');

    const stdout = execFileSync(process.execPath, [script, '--source', sourcePath, '--ledger', ledgerPath, '--json'], {
      encoding: 'utf8'
    });
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.wrote, false);
    assert.equal(fs.existsSync(ledgerPath), false);
  });

  it('exits 2 on malformed input and leaves the ledger alone', (t) => {
    const dir = withTempDir(t);
    const sourcePath = path.join(dir, 'bets.json');
    fs.writeFileSync(sourcePath, 'nope', 'utf8');
    const ledgerPath = path.join(dir, 'ledger.json');

    let threw = null;
    let stderr = '';
    try {
      execFileSync(process.execPath, [script, '--source', sourcePath, '--ledger', ledgerPath, '--apply'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      threw = error;
      stderr = String(error.stderr || '');
    }
    assert.ok(threw, 'subprocess must exit nonzero');
    assert.equal(threw.status, 2);
    assert.match(stderr, /invalid JSON/);
    assert.equal(fs.existsSync(ledgerPath), false);
  });
});
