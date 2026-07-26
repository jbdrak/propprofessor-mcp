'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { takeDailySnapshot, buildPlayId, normalizePlay } = require('../scripts/daily-snapshot');
const { resolveOutcomes, ledgerToPlays, toEngineResult } = require('../scripts/resolve-outcomes');
const { computeBacktestMetrics } = require('../lib/propprofessor-backtest-metrics');

// Two fake plays from the (mocked) recommended_bets / quick_screen source.
const FAKE_PLAYS = [
  {
    playId: 'fake001',
    gameId: 'g1',
    selection: 'Yankees',
    market: 'Moneyline',
    league: 'MLB',
    book: 'Pinnacle',
    odds: -140,
    confidenceTier: 'TIER 1',
    kaiCall: 'BET',
    screenScore: 9.1
  },
  {
    playId: 'fake002',
    gameId: 'g2',
    selection: 'Dodgers',
    market: 'Moneyline',
    league: 'MLB',
    book: 'DraftKings',
    odds: -110,
    confidenceTier: 'TIER 2',
    kaiCall: 'CONSIDER',
    screenScore: 7.4
  }
];

function makeCsv() {
  // columns: playId,result (with a third irrelevant column to test robustness)
  return ['playId,result,note', 'fake001,win,settled', 'fake002,loss,settled'].join('\n');
}

describe('daily snapshot + outcome-resolution pipeline', () => {
  let tmpDir;
  let snapFile;
  let csvFile;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-pipeline-'));
    snapFile = path.join(tmpDir, 'snapshots.jsonl');
    csvFile = path.join(tmpDir, 'results.csv');
    fs.writeFileSync(csvFile, makeCsv(), 'utf8');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds a stable playId (gameId+selection+market+book)', () => {
    const id = buildPlayId({ gameId: 'g1', selection: 'Yankees', market: 'Moneyline', book: 'Pinnacle' });
    assert.equal(typeof id, 'string');
    assert.equal(id.length, 16);
    // order/whitespace-insensitive on the same inputs
    const id2 = buildPlayId({ gameId: ' g1', selection: 'Yankees ', market: 'Moneyline', book: 'Pinnacle' });
    assert.equal(id, id2);
  });

  it('writes 2 lines to a fresh jsonl via mocked play source', async () => {
    const result = await takeDailySnapshot({
      getPlays: async () => FAKE_PLAYS,
      outFile: snapFile
    });
    assert.equal(result.written, 2);
    assert.equal(result.skipped, 0);
    const lines = fs
      .readFileSync(snapFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    assert.equal(lines.length, 2);
    const recs = lines.map((l) => JSON.parse(l));
    // captures required fields
    for (const r of recs) {
      assert.ok(r.playId && r.gameId && r.selection && r.market && r.book && r.odds != null);
      assert.ok(r.tier && r.kaiCall && r.screenScore != null);
      assert.ok(typeof r.timestamp === 'string' && !Number.isNaN(Date.parse(r.timestamp)));
      assert.equal(r.result, undefined); // unresolved at snapshot time
    }
  });

  it('is idempotent within the same UTC day (skips already-snapshotted playIds)', async () => {
    const result = await takeDailySnapshot({
      getPlays: async () => FAKE_PLAYS,
      outFile: snapFile
    });
    assert.equal(result.written, 0, 'second run same day should write nothing');
    assert.equal(result.skipped, 2);
    const lines = fs
      .readFileSync(snapFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    assert.equal(lines.length, 2, 'still exactly 2 lines');
  });

  it('resolves outcomes from a CSV and rewrites the ledger in place', async () => {
    const resolved = await resolveOutcomes({
      inFile: snapFile,
      resultsCsv: csvFile
    });
    assert.equal(resolved.resolved, 2);
    assert.equal(resolved.unresolved, 0);

    const recs = fs
      .readFileSync(snapFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(recs.length, 2);
    const byId = Object.fromEntries(recs.map((r) => [r.playId, r]));
    assert.equal(byId.fake001.result, 'win');
    assert.equal(byId.fake002.result, 'loss');
    assert.ok(byId.fake001.resolvedAt && byId.fake002.resolvedAt);
  });

  it('feeds the resolved ledger into computeBacktestMetrics (real pnl/roi/sharpe/maxDD)', async () => {
    const recs = fs
      .readFileSync(snapFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const plays = ledgerToPlays(recs);
    assert.equal(plays.length, 2);

    const m = computeBacktestMetrics(plays);
    // Yankees -140 @ (default 100) win = 100/1.4 = 71.43 ; Dodgers -110 loss = -100
    assert.equal(m.bets, 2);
    assert.equal(m.wins, 1);
    assert.equal(m.losses, 1);
    assert.equal(m.pushes, 0);
    assert.equal(typeof m.profit, 'number');
    assert.ok(Math.abs(m.profit - (100 / 1.4 - 100)) < 0.5, `profit was ${m.profit}`);
    assert.equal(typeof m.roi, 'number');
    assert.equal(typeof m.winRate, 'number');
    assert.equal(typeof m.maxDrawdown, 'number');
    // 2 plays => Sharpe is computed (a number), not null
    assert.equal(typeof m.sharpe, 'number');
  });

  it('maps snapshot result vocabulary to engine result vocabulary', () => {
    assert.equal(toEngineResult('win'), 'won');
    assert.equal(toEngineResult('loss'), 'lost');
    assert.equal(toEngineResult('push'), 'push');
  });

  it('normalizePlay fills a playId when none is present', () => {
    const n = normalizePlay({ gameId: 'g3', selection: 'Braves', market: 'Moneyline', book: 'FanDuel', odds: 155 });
    assert.ok(n.playId);
    assert.equal(n.odds, 155);
    assert.equal(n.market, 'Moneyline');
  });

  it('CSV fallback keeps unresolved plays when the CSV lacks their id', async () => {
    const file = path.join(tmpDir, 'partial.jsonl');
    await takeDailySnapshot({
      getPlays: async () => FAKE_PLAYS,
      outFile: file
    });
    // CSV only resolves one of the two
    const partialCsv = path.join(tmpDir, 'partial.csv');
    fs.writeFileSync(partialCsv, 'playId,result\nfake001,win\n', 'utf8');
    const res = await resolveOutcomes({ inFile: file, resultsCsv: partialCsv });
    assert.equal(res.resolved, 1);
    assert.equal(res.unresolved, 1);
  });
});
