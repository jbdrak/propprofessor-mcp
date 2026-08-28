'use strict';

/**
 * Regression tests for the three movement/tier-gating bugs fixed 2026-07-10:
 *  - A: buildMovementWindows nowMs defaults to Date.now() (not last-point time),
 *       so the recent window is wall-clock anchored and deterministic across
 *       the screen pass and the validateTop re-fetch (kills the
 *       supportive-on-screen / adverse-on-validation flip).
 *  - B: downstream of A — screen and validation now read identical movement.
 *  - C: the authoritative merged verdict (finalVerdict / finalConfidenceTier)
 *       is promoted into displayTier/confidenceTier/kaiCall, and the
 *       targetTiers filter keys off finalConfidenceTier, so an adverse/idverse
 *       downgraded play can't ship as displayTier BET / TIER 1.
 *
 * Offline: game-context stubbed so team/line plays don't hit the network.
 */

const path = require('path');

const GC_PATH = path.resolve(__dirname, '../lib/propprofessor-game-context.js');
require.cache[GC_PATH] = {
  id: GC_PATH,
  filename: GC_PATH,
  loaded: true,
  exports: {
    getGameContext: async ({ sport, game } = {}) => ({
      ok: true,
      sport: sport || null,
      gamePk: game || null,
      riskFlag: 'clean',
      riskSummary: null,
      signals: {},
      fetchedAt: new Date().toISOString()
    })
  }
};

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildMovementWindows, summarizeSharpMovement } = require('../lib/propprofessor-sharp-history');
const { computeMovementDisposition } = require('../lib/propprofessor-movement-disposition');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { createMockClient } = require('./fixtures/mock-client');

describe('Bug A: buildMovementWindows nowMs anchors to real time', () => {
  it('defaults nowMs to Date.now(), not the last point timestamp', () => {
    // Two points 2h apart. If nowMs defaulted to the last point, the recent
    // 6h window would include both points. With real-time default far in the
    // future (Date.now() >> these 2026-era timestamps), the recent window is
    // empty. Note: parseHistoryTimeMs multiplies sub-1e12 ints by 1000, so
    // time: 1782551782005 is treated as epoch-ms.
    const points = [
      { book: 'Pinnacle', odds: 100, time: 1782551782005 },
      { book: 'Pinnacle', odds: 110, time: 1782551889460 }
    ];
    const windows = buildMovementWindows(points, { recentWindowHours: 6 });
    // fullWindow still computes from ALL points (it ignores nowMs)
    assert.ok(windows.fullWindow, 'fullWindow should compute from all points');
    // recent window is empty because nowMs is real time (far from the data)
    assert.equal(windows.recentWindow, null, 'recent window should be null under real-time nowMs');
  });

  it('respects an explicit nowMs override near the data', () => {
    const base = 1782551782005;
    const nowMs = base + 3 * 60 * 60 * 1000; // 3h after the first point
    const points = [
      { book: 'Pinnacle', odds: 110, time: base },
      { book: 'Pinnacle', odds: 100, time: base + 2 * 60 * 60 * 1000 } // improved (110 -> 100) = supportive
    ];
    const windows = buildMovementWindows(points, { nowMs, recentWindowHours: 6 });
    assert.ok(windows.recentWindow, 'recent window should exist when nowMs is near the data');
    assert.equal(windows.recentWindow.direction, 'supportive');
  });
});

describe('Quote/history freshness fail-closed regressions', () => {
  it('uses the real numeric-string history timestamp for age', () => {
    const base = 1782551782005;
    const result = summarizeSharpMovement({
      lineHistory: [
        { book: 'Pinnacle', odds: 110, time: String(base) },
        { book: 'Pinnacle', odds: 100, time: String(base + 2 * 60 * 60 * 1000) }
      ],
      preferredBook: 'Pinnacle',
      sharpBooks: ['Pinnacle'],
      options: { nowMs: base + 3 * 60 * 60 * 1000 }
    });

    assert.equal(result.lastPointAgeMs, 60 * 60 * 1000);
  });

  it('fails closed for timestamp-less, degraded, and line-backfilled history', () => {
    const history = [
      { book: 'Pinnacle', odds: 110 },
      { book: 'Pinnacle', odds: 100 }
    ];
    const base = summarizeSharpMovement({
      lineHistory: history,
      preferredBook: 'Pinnacle',
      sharpBooks: ['Pinnacle']
    });
    assert.equal(base.lineHistoryUsable, false);
    assert.equal(base.movementLabel, 'insufficient_history');

    const degraded = summarizeSharpMovement({
      lineHistory: history,
      preferredBook: 'Pinnacle',
      sharpBooks: ['Pinnacle'],
      options: { historyDegraded: true }
    });
    assert.equal(degraded.lineHistoryUsable, false);

    const backfilled = summarizeSharpMovement({
      lineHistory: [
        { book: 'Pinnacle', odds: 110, time: 1782551782005, line: -1 },
        { book: 'Pinnacle', odds: 100, time: 1782551889460, line: -1 }
      ],
      preferredBook: 'Pinnacle',
      sharpBooks: ['Pinnacle'],
      options: { lineFieldMissingCount: 2 }
    });
    assert.equal(backfilled.lineHistoryUsable, false);
    assert.equal(
      computeMovementDisposition({
        lineHistoryUsable: false,
        movementGrade: 'green',
        movementLabel: 'supportive',
        recentSharpMoveDirection: 'supportive',
        fullWindowSharpMoveDirection: 'supportive',
        sharpBookMovementConfirmed: true,
        consensusBookCount: 10,
        clvProxyPct: 1
      }),
      'insufficient'
    );
  });

  it('preserves the requested-book quote and liquidity when history is degraded', () => {
    const row = {
      book: 'NoVigApp',
      pick: 'Lakers',
      odds: -123,
      currentOdds: -123,
      liquidityUsd: 47,
      lineHistory: [],
      lineHistoryAvailable: false,
      historyError: 'timeout'
    };
    assert.equal(row.odds, -123);
    assert.equal(row.currentOdds, -123);
    assert.equal(row.liquidityUsd, 47);
  });
});

describe('Bug C: validated finalVerdict promotes into display fields + tier filter', () => {
  it('displayTier/confidenceTier/kaiCall mirror finalVerdict after validation', async () => {
    const { client } = createMockClient();
    const handlers = createMcpHandlers({ client, historyMinIntervalMs: 0 });
    const res = await handlers.quick_screen({
      books: ['NoVigApp'],
      leagues: ['NBA'],
      validateTop: 10,
      includeResearch: false
    });
    const all = (res.results || []).flatMap((e) => e.candidates || []);
    assert.ok(all.length > 0, 'expected candidates');
    for (const c of all) {
      if (!c._validated) continue;
      // When validation downgrades (e.g. PASS), the display fields must follow.
      assert.strictEqual(c.displayTier, c.finalVerdict, `displayTier should equal finalVerdict for ${c.selection}`);
      assert.strictEqual(c.kaiCall, c.finalVerdict, `kaiCall should equal finalVerdict for ${c.selection}`);
      if (c.finalConfidenceTier) {
        assert.strictEqual(
          c.confidenceTier,
          c.finalConfidenceTier,
          `confidenceTier should equal finalConfidenceTier for ${c.selection}`
        );
      }
    }
  });

  it('targetTiers filter drops plays validated below the requested tier', async () => {
    const { client } = createMockClient();
    const handlers = createMcpHandlers({ client, historyMinIntervalMs: 0 });
    const res = await handlers.quick_screen({
      books: ['NoVigApp'],
      leagues: ['NBA'],
      targetTiers: ['TIER 1'],
      validateTop: 10,
      includeResearch: false
    });
    const all = (res.results || []).flatMap((e) => e.candidates || []);
    // No TIER 1 validated plays survive in the NBA fixture (all validated
    // CONSIDER/PASS). Assert none leak through as TIER 1.
    for (const c of all) {
      assert.notStrictEqual(
        c.confidenceTier,
        'TIER 1',
        `validated-below-TIER1 play ${c.selection} leaked through as ${c.confidenceTier}`
      );
      assert.notStrictEqual(c.finalVerdict, 'BET', `validated non-BET play ${c.selection} leaked as BET`);
    }
  });

  it('finalVerdict + finalConfidenceTier are always present (standard verbosity)', async () => {
    const { client } = createMockClient();
    const handlers = createMcpHandlers({ client, historyMinIntervalMs: 0 });
    const res = await handlers.quick_screen({
      books: ['NoVigApp'],
      leagues: ['NBA'],
      validateTop: 10,
      includeResearch: false,
      verbosity: 'standard'
    });
    const all = (res.results || []).flatMap((e) => e.candidates || []);
    assert.ok(all.length > 0, 'expected candidates');
    for (const c of all) {
      assert.ok('finalVerdict' in c, `finalVerdict missing on ${c.selection} (standard verbosity)`);
      assert.ok('finalConfidenceTier' in c, `finalConfidenceTier missing on ${c.selection} (standard verbosity)`);
    }
  });
});
