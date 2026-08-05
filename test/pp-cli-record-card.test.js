'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../bin/pp-cli');

// Task 4: `pp record-card` integration tests. The command reads a reviewed
// decision card (JSON file or inline --json payload), loads the tracker
// ledger, promotes BET cards into official bets, records LEAN/PASS decisions
// without bets, is idempotent, writes machine-readable JSON only with the
// --json output flag, and exits nonzero for malformed/missing cards without
// mutating the ledger. Everything runs against a temp ledger + temp files so
// the user's home directory is never touched.

function makeCandidate() {
  return {
    candidateId: 'cand-under-75',
    scanId: 'scan-1',
    gameId: 'g-123',
    game: 'Pirates @ Brewers',
    league: 'MLB',
    market: 'Total Runs',
    selection: 'Under 7.5',
    odds: -110,
    tier: 'A',
    verdict: 'BET',
    movement: '+5',
    edge: 3.2,
    clvProxyPct: 2.1,
    books: 4,
    start: '2026-08-04T23:40:00.000Z',
    startCST: '2026-08-04 18:40',
    startDisplay: 'Aug 4, 6:40 PM',
    startSource: 'pp_schedule',
    startConfidence: 'high',
    status: 'unreviewed',
    reviewNote: null
  };
}

function makeCard(overrides = {}) {
  return {
    candidateId: 'cand-under-75',
    decision: 'BET',
    odds: -115,
    stake: 50,
    researchSummary: 'Brewers park plays under; public totals inflated.',
    scheduleVerification: 'start confirmed 2026-08-04 23:40Z via schedule check',
    lineVerification: 'Under 7.5 available at -115 at decision time',
    decisionSource: 'manual_review',
    notes: 'fade the public',
    ...overrides
  };
}

function makeLeanCard(overrides = {}) {
  return {
    candidateId: 'cand-under-75',
    decision: 'LEAN',
    decisionSource: 'manual_review',
    notes: 'needs more movement evidence',
    ...overrides
  };
}

function makePassCard(overrides = {}) {
  return {
    candidateId: 'cand-under-75',
    decision: 'PASS',
    decisionSource: 'manual_review',
    ...overrides
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cli-record-card-'));
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

function writeLedgerFixture(ledgerPath, extraCandidates = []) {
  const ledger = {
    version: 2,
    scans: [
      {
        id: 'scan-1',
        source: 'pp-cli',
        command: 'scan',
        leagues: ['MLB'],
        playCount: 1
      }
    ],
    candidates: [makeCandidate(), ...extraCandidates],
    bets: [],
    settlements: []
  };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  return ledger;
}

function readLedger(ledgerPath) {
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
}

async function runRecordCard({ positional, flags }) {
  const capture = captureConsole();
  try {
    const result = await cli.cmdRecordCard(positional, flags);
    return { result, logs: capture.logs, errors: capture.errors };
  } finally {
    capture.restore();
  }
}

describe('pp-cli record-card: BET promotion', () => {
  it('promotes a BET card from a JSON file into an official bet', async (t) => {
    const env = withTempEnv(t);
    writeLedgerFixture(env.ledgerPath);
    const cardPath = path.join(env.dir, 'card.json');
    fs.writeFileSync(cardPath, JSON.stringify(makeCard()), 'utf8');

    const { result, logs, errors } = await runRecordCard({
      positional: ['record-card', cardPath],
      flags: {}
    });

    assert.equal(result.ok, true);
    assert.equal(result.summary.promoted, 1);
    assert.equal(result.summary.recorded, 0);
    assert.equal(result.summary.rejected, 0);
    assert.equal(result.ledgerPath, env.ledgerPath);

    const ledger = readLedger(env.ledgerPath);
    assert.equal(ledger.bets.length, 1);
    const bet = ledger.bets[0];
    assert.equal(bet.candidateId, 'cand-under-75');
    assert.equal(bet.id, 'bet-cand-under-75');
    assert.equal(bet.selection, 'Under 7.5');
    assert.equal(bet.oddsAtDecision, -115);
    assert.equal(bet.stake, 50);
    assert.equal(bet.status, 'pending');
    assert.ok(!Number.isNaN(Date.parse(bet.decisionAt)), 'decisionAt is a real timestamp');
    assert.equal(ledger.candidates[0].status, 'promoted');

    assert.equal(logs.length, 0, 'human mode writes nothing to stdout');
    assert.ok(
      errors.some((e) => e.startsWith('record-card:')),
      'human status goes to stderr'
    );
  });

  it('accepts an inline --json payload (no file)', async (t) => {
    const env = withTempEnv(t);
    writeLedgerFixture(env.ledgerPath);

    const { result, logs } = await runRecordCard({
      positional: ['record-card'],
      flags: { json: JSON.stringify(makeCard()) }
    });

    assert.equal(result.ok, true);
    assert.equal(result.summary.promoted, 1);
    assert.equal(logs.length, 0, 'a string-valued --json is input, not output mode');
    assert.equal(readLedger(env.ledgerPath).bets.length, 1);
  });

  it('writes machine-readable JSON to stdout only with the --json output flag', async (t) => {
    const env = withTempEnv(t);
    writeLedgerFixture(env.ledgerPath);
    const cardPath = path.join(env.dir, 'card.json');
    fs.writeFileSync(cardPath, JSON.stringify(makeCard()), 'utf8');

    const { result, logs, errors } = await runRecordCard({
      positional: ['record-card', cardPath],
      flags: { json: true }
    });

    assert.equal(result.ok, true);
    assert.equal(logs.length, 1, 'exactly one stdout write (the JSON payload)');
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.summary.promoted, 1);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].bet.candidateId, 'cand-under-75');
    assert.equal(parsed.ledgerPath, env.ledgerPath);
    assert.ok(
      errors.some((e) => e.startsWith('record-card:')),
      'human status still on stderr'
    );
  });
});

describe('pp-cli record-card: LEAN and PASS', () => {
  it('records LEAN and PASS decisions without creating bets', async (t) => {
    const env = withTempEnv(t);
    writeLedgerFixture(env.ledgerPath);
    const cardPath = path.join(env.dir, 'cards.json');
    fs.writeFileSync(cardPath, JSON.stringify([makeLeanCard(), makePassCard()]), 'utf8');

    const { result } = await runRecordCard({
      positional: ['record-card', cardPath],
      flags: {}
    });

    assert.equal(result.ok, true);
    assert.equal(result.summary.promoted, 0);
    assert.equal(result.summary.recorded, 2);
    const ledger = readLedger(env.ledgerPath);
    assert.equal(ledger.bets.length, 0, 'LEAN/PASS never create bet records');
    assert.equal(ledger.candidates[0].status, 'pass');
    // lib/record-card never clears a prior reviewNote when a later card has no
    // notes; the last decision (PASS) wins on status, notes are cumulative.
    assert.equal(ledger.candidates[0].reviewNote, 'needs more movement evidence');
  });
});

describe('pp-cli record-card: idempotency', () => {
  it('re-running the same card file adds no duplicate bets', async (t) => {
    const env = withTempEnv(t);
    writeLedgerFixture(env.ledgerPath);
    const cardPath = path.join(env.dir, 'card.json');
    fs.writeFileSync(cardPath, JSON.stringify(makeCard()), 'utf8');

    const first = await runRecordCard({ positional: ['record-card', cardPath], flags: {} });
    assert.equal(first.result.summary.promoted, 1);

    const second = await runRecordCard({ positional: ['record-card', cardPath], flags: {} });
    assert.equal(second.result.ok, true);
    assert.equal(second.result.summary.promoted, 0);
    assert.equal(second.result.summary.duplicates, 1);
    const ledger = readLedger(env.ledgerPath);
    assert.equal(ledger.bets.length, 1, 'no second bet row');
    assert.ok(
      second.errors.some((e) => e.includes('duplicate')),
      're-run reports the duplicate on stderr'
    );
  });
});

describe('pp-cli record-card: malformed or missing input never mutates the ledger', () => {
  it('rejects a missing card file', async (t) => {
    const env = withTempEnv(t);
    writeLedgerFixture(env.ledgerPath);
    const missingPath = path.join(env.dir, 'does-not-exist.json');

    await assert.rejects(cli.cmdRecordCard(['record-card', missingPath], {}), /cannot read card file/);
    assert.equal(readLedger(env.ledgerPath).bets.length, 0, 'ledger untouched');
  });

  it('rejects malformed JSON in the card file', async (t) => {
    const env = withTempEnv(t);
    writeLedgerFixture(env.ledgerPath);
    const cardPath = path.join(env.dir, 'bad.json');
    fs.writeFileSync(cardPath, '{not json', 'utf8');

    await assert.rejects(cli.cmdRecordCard(['record-card', cardPath], {}), /invalid JSON/);
    assert.equal(readLedger(env.ledgerPath).bets.length, 0, 'ledger untouched');
  });

  it('rejects a card referencing an unknown candidate', async (t) => {
    const env = withTempEnv(t);
    writeLedgerFixture(env.ledgerPath);
    const cardPath = path.join(env.dir, 'card.json');
    fs.writeFileSync(cardPath, JSON.stringify(makeCard({ candidateId: 'no-such-cand' })), 'utf8');

    await assert.rejects(cli.cmdRecordCard(['record-card', cardPath], {}), /candidate not found|rejected/);
    const ledger = readLedger(env.ledgerPath);
    assert.equal(ledger.bets.length, 0, 'no bet written');
    assert.equal(ledger.candidates[0].status, 'unreviewed', 'candidate unchanged');
  });

  it('rejects a whole batch atomically when any card is invalid', async (t) => {
    const env = withTempEnv(t);
    writeLedgerFixture(env.ledgerPath);
    const cardPath = path.join(env.dir, 'cards.json');
    const good = makeCard();
    const bad = { candidateId: 'cand-under-75', decision: 'CONSIDER', decisionSource: 'x' };
    fs.writeFileSync(cardPath, JSON.stringify([good, bad]), 'utf8');

    await assert.rejects(cli.cmdRecordCard(['record-card', cardPath], {}), /rejected 1 card/);
    const ledger = readLedger(env.ledgerPath);
    assert.equal(ledger.bets.length, 0, 'the valid card is not promoted either');
    assert.equal(ledger.candidates[0].status, 'unreviewed');
  });

  it('rejects missing input entirely', async () => {
    await assert.rejects(cli.cmdRecordCard(['record-card'], {}), /no card input/);
  });

  it('rejects an empty card array', async (t) => {
    const env = withTempEnv(t);
    writeLedgerFixture(env.ledgerPath);
    const cardPath = path.join(env.dir, 'empty.json');
    fs.writeFileSync(cardPath, '[]', 'utf8');

    await assert.rejects(cli.cmdRecordCard(['record-card', cardPath], {}), /no cards found/);
    assert.equal(readLedger(env.ledgerPath).bets.length, 0, 'ledger untouched');
  });

  it('rejects providing both a file and an inline payload', async (t) => {
    const env = withTempEnv(t);
    writeLedgerFixture(env.ledgerPath);
    const cardPath = path.join(env.dir, 'card.json');
    fs.writeFileSync(cardPath, JSON.stringify(makeCard()), 'utf8');

    await assert.rejects(
      cli.cmdRecordCard(['record-card', cardPath], { json: JSON.stringify(makeCard()) }),
      /not both/
    );
    assert.equal(readLedger(env.ledgerPath).bets.length, 0, 'ledger untouched');
  });
});
