'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Use a temp dir for pick storage
const tmpDir = path.join(require('node:os').tmpdir(), 'pp-mcp-picks-test-' + Date.now());
process.env.PP_PICKS_FILE = path.join(tmpDir, 'test-picks.json');
process.env.PP_CHECKPOINT_FILE = path.join(tmpDir, 'test-checkpoint.json');
process.env.HOME = tmpDir;

const {
  CURRENT_PICKS_SCHEMA_VERSION,
  getPickHistory,
  getPickStats,
  getPicksSchemaVersion,
  logPick,
  readCheckpoint,
  resolvePick,
  writeCheckpoint
} = require('../lib/ssb-picks');

describe('Pick Tracking', () => {
  before(() => {
    fs.mkdirSync(path.join(tmpDir, '.ssb-for-agents'), { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logPick creates a pick with id and defaults', () => {
    const result = logPick('Lakers vs Celtics', 'NBA', 'Moneyline', 'Lakers', -110, { stake: 50 });
    assert.equal(result.ok, true);
    assert.ok(result.pick.id);
    assert.equal(result.pick.game, 'Lakers vs Celtics');
    assert.equal(result.pick.league, 'NBA');
    assert.equal(result.pick.odds, -110);
    assert.equal(result.pick.stake, 50);
    assert.equal(result.pick.status, 'pending');
  });

  it('logPick throws on missing required fields', () => {
    assert.throws(() => logPick('', 'NBA', 'Moneyline', 'Lakers', -110), /required/);
    assert.throws(() => logPick('Game', '', 'Moneyline', 'Lakers', -110), /required/);
    assert.throws(() => logPick('Game', 'NBA', 'Moneyline', '', -110), /required/);
    assert.throws(() => logPick('Game', 'NBA', 'Moneyline', 'Lakers', 'abc'), /finite/);
  });

  it('getPickHistory returns picks with most recent first', () => {
    const result = getPickHistory();
    assert.equal(result.ok, true);
    assert.ok(result.picks.length > 0);
    assert.equal(result.total, 1);
    // Most recent first
    if (result.picks.length > 1) {
      const t0 = new Date(result.picks[0].loggedAt).getTime();
      const t1 = new Date(result.picks[1].loggedAt).getTime();
      assert.ok(t0 >= t1, 'most recent first');
    }
  });

  it('getPickHistory filters by status', () => {
    const pending = getPickHistory({ status: 'pending' });
    assert.equal(pending.total, 1);
    const won = getPickHistory({ status: 'won' });
    assert.equal(won.total, 0);
  });

  it('resolvePick updates status', () => {
    const { pick } = logPick('Test Game', 'MLB', 'Spread', 'Team A', +150, { stake: 25 });
    const result = resolvePick(pick.id, 'won');
    assert.equal(result.ok, true);
    assert.equal(result.pick.status, 'won');
    assert.ok(result.pick.resolvedAt);
  });

  it('resolvePick rejects invalid results', () => {
    assert.throws(() => resolvePick('some-id', 'invalid'), /must be "won"/);
  });

  it('resolvePick returns error for unknown id', () => {
    const result = resolvePick('nonexistent-id-12345', 'won');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });

  it('getPickStats calculates win rate and profit', () => {
    logPick('Game 1', 'NBA', 'Moneyline', 'Team A', -110, { stake: 100 });
    logPick('Game 2', 'NBA', 'Moneyline', 'Team B', -110, { stake: 100 });
    logPick('Game 3', 'MLB', 'Moneyline', 'Team C', +150, { stake: 50 });

    const history = getPickHistory();
    const resolveable = history.picks.filter((p) => p.status === 'pending');
    if (resolveable.length >= 2) {
      resolvePick(resolveable[0].id, 'won');
      resolvePick(resolveable[1].id, 'lost');
    }

    const stats = getPickStats();
    assert.equal(stats.ok, true);
    assert.ok(stats.stats.total >= 5);
    assert.ok(stats.stats.resolved >= 2);
    assert.ok(typeof stats.stats.winRate === 'string' || stats.stats.winRate === null);
    assert.ok(stats.stats.byLeague);
    assert.ok(stats.stats.byTier);
  });
});

describe('Alert Checkpoint', () => {
  it('readCheckpoint returns defaults on first call', () => {
    const cp = readCheckpoint();
    assert.equal(cp.lastCheckedAt, null);
    assert.deepEqual(cp.leagues, {});
  });

  it('writeCheckpoint persists data', () => {
    writeCheckpoint({ lastCheckedAt: '2026-01-01T00:00:00Z', leagues: { NBA: '2026-01-01T00:00:00Z' } });
    const cp = readCheckpoint();
    assert.equal(cp.lastCheckedAt, '2026-01-01T00:00:00Z');
    assert.equal(cp.leagues.NBA, '2026-01-01T00:00:00Z');
  });

  it('survives corrupt checkpoint file', () => {
    const picksFile = path.join(tmpDir, '.ssb-for-agents', 'picks.json');
    fs.writeFileSync(picksFile, '{corrupt', 'utf8');
    const result = getPickHistory();
    assert.equal(result.ok, true);
    assert.equal(result.total, 0);
  });
});

describe('picks.json schema versioning', () => {
  const tmpDir2 = path.join(require('node:os').tmpdir(), 'pp-mcp-picks-schema-test-' + Date.now());
  const testFile = path.join(tmpDir2, 'picks.json');

  before(() => {
    fs.mkdirSync(tmpDir2, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  it('exports the current schema version constant', () => {
    assert.equal(typeof CURRENT_PICKS_SCHEMA_VERSION, 'number');
    assert.ok(CURRENT_PICKS_SCHEMA_VERSION >= 1);
  });

  it('getPicksSchemaVersion returns null when the file is missing', () => {
    assert.equal(getPicksSchemaVersion(testFile), null);
  });

  it('getPicksSchemaVersion returns 0 for legacy files (no schemaVersion key)', () => {
    fs.writeFileSync(testFile, JSON.stringify({ picks: [] }));
    assert.equal(getPicksSchemaVersion(testFile), 0);
  });

  it('getPicksSchemaVersion returns the version number for new files', () => {
    fs.writeFileSync(testFile, JSON.stringify({ schemaVersion: 1, picks: [] }));
    assert.equal(getPicksSchemaVersion(testFile), 1);
  });

  it('getPicksSchemaVersion tolerates non-numeric schemaVersion values', () => {
    fs.writeFileSync(testFile, JSON.stringify({ schemaVersion: 'oops', picks: [] }));
    // 'oops' is not a finite number → falls back to 0 (legacy) per the
    // function's defensive coercion.
    const v = getPicksSchemaVersion(testFile);
    assert.ok(v === 0 || v === null, `expected 0 or null for non-numeric version, got ${v}`);
  });
});
