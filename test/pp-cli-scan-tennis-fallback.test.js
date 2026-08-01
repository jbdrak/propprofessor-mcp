'use strict';

/**
 * Regression coverage for mixed-scan tennis fallback injection.
 *
 * When Tennis is among requested leagues but returns 0 plays from the
 * quick_screen pipeline, the CLI should call recoverTennisFromScreen()
 * and inject the fallback Tennis bucket alongside non-Tennis results.
 *
 * These tests exercise cmdScan directly (exported by pp-cli.js when
 * required, guarded so main() does not auto-run).
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');

describe('cmdScan tennis fallback in mixed-league scans', () => {
  let cmdScan;
  let formatScan;
  let momentumLabel;
  let recentDriftContextLabel;
  let snapshotStore;
  const SNAPSHOT_FILE = path.join(os.tmpdir(), 'pp-scan-snapshot-test-' + process.pid + '.json');

  // ── mock recoverTennisFromScreen ─────────────────────────────────
  // We replace the tennis-fallback module in require.cache BEFORE
  // loading pp-cli.js so that cmdScan's module-level import gets our
  // deterministic mock instead of the real recovery logic (which calls
  // external APIs via client + correctTennisTimes).

  const SAMPLE_TENNIS_PLAY = {
    game: 'Djokovic N vs Alcaraz C',
    gameId: 'tennis-game-1',
    league: 'Tennis',
    market: 'Moneyline',
    start: '2026-07-30T18:00:00.000Z',
    selection: 'Djokovic N',
    participant: 'Djokovic N',
    odds: -120,
    book: 'NoVigApp',
    tier: 'TIER 1',
    verdict: 'BET',
    movementDisposition: 'supportive_clean',
    edge: 2.1,
    clvProxyPct: 2.1,
    source: 'tennis_fallback (Pinnacle)'
  };

  // Simulates a live tennis fallback play that should be filtered out by -B
  const CONSIDER_TENNIS_PLAY = {
    game: 'Nakashima vs Thompson',
    gameId: 'tennis-game-2',
    league: 'Tennis',
    market: 'Moneyline',
    start: '2026-07-30T20:00:00.000Z',
    selection: 'Nakashima',
    participant: 'Nakashima',
    odds: -110,
    book: 'NoVigApp',
    tier: 'TIER 2',
    verdict: 'CONSIDER',
    movementDisposition: 'adverse_full',
    edge: 0,
    clvProxyPct: 0,
    source: 'tennis_fallback'
  };

  before(() => {
    process.env.PP_SCAN_SNAPSHOT_FILE = SNAPSHOT_FILE;
    const tennisFallbackPath = require.resolve(PROJECT + '/lib/tennis-fallback');
    // Remove any stale cache entry
    delete require.cache[tennisFallbackPath];
    // Register the mock before anything imports it
    require.cache[tennisFallbackPath] = {
      id: tennisFallbackPath,
      filename: tennisFallbackPath,
      loaded: true,
      exports: {
        recoverTennisFromScreen: async () => [SAMPLE_TENNIS_PLAY, CONSIDER_TENNIS_PLAY],
        computeClvFromHistory: () => null,
        deriveMovementFromClv: () => 'insufficient',
        assignTierFromClv: () => 'TIER 2',
        isTennisAlternateLine: () => false
      }
    };

    const mod = require(PROJECT + '/bin/pp-cli');
    cmdScan = mod.cmdScan;
    formatScan = mod.formatScan;
    momentumLabel = mod.momentumLabel;
    recentDriftContextLabel = mod.recentDriftContextLabel;
    snapshotStore = require(PROJECT + '/lib/pp-scan-snapshot-store');
  });

  beforeEach(() => {
    fs.rmSync(SNAPSHOT_FILE, { force: true });
  });

  afterEach(() => {
    fs.rmSync(SNAPSHOT_FILE, { force: true });
  });

  // ── helpers ──────────────────────────────────────────────────────

  function suppressConsole() {
    const orig = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = () => {};
    return orig;
  }

  function restoreConsole(orig) {
    console.log = orig.log;
    console.error = orig.error;
  }

  // ── tests ────────────────────────────────────────────────────────

  it('injects tennis fallback when tennis is among requested leagues but returned empty', async () => {
    const res = {
      data: {
        results: [
          { league: 'MLB', market: 'Moneyline', plays: [{ selection: 'Yankees', odds: -120 }] },
          { league: 'NBA', market: 'Spread', plays: [{ selection: 'Lakers', odds: -110 }] }
        ],
        totalCount: 2
      }
    };

    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'mlb', 'tennis'], {}, {});
    } finally {
      restoreConsole(orig);
    }

    // Results should have 3 groups: MLB, NBA, Tennis
    const results = res.data.results;
    assert.equal(results.length, 3, 'should have 3 result groups (MLB, NBA, Tennis)');

    const tennisGroup = results.find((r) => r.league === 'Tennis');
    assert.ok(tennisGroup, 'Tennis fallback group should be injected');
    assert.equal(tennisGroup.market, 'All Markets', 'fallback bucket uses All Markets label');
    assert.ok(tennisGroup.plays.length > 0, 'fallback group should contain plays');
    assert.equal(tennisGroup.plays[0].selection, 'Djokovic N');

    // Non-tennis groups should be untouched
    const mlbGroup = results.find((r) => r.league === 'MLB');
    assert.ok(mlbGroup, 'MLB group preserved');
    assert.equal(mlbGroup.plays.length, 1);

    const nbaGroup = results.find((r) => r.league === 'NBA');
    assert.ok(nbaGroup, 'NBA group preserved');
    assert.equal(nbaGroup.plays.length, 1);
  });

  it('does not inject tennis fallback when tennis already has plays', async () => {
    const res = {
      data: {
        results: [
          { league: 'MLB', market: 'Moneyline', plays: [{ selection: 'Yankees', odds: -120 }] },
          { league: 'Tennis', market: 'Moneyline', plays: [{ selection: 'Djokovic', odds: -150 }] },
          { league: 'NBA', market: 'Spread', plays: [{ selection: 'Lakers', odds: -110 }] }
        ],
        totalCount: 3
      }
    };

    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'mlb', 'tennis', 'nba'], {}, {});
    } finally {
      restoreConsole(orig);
    }

    assert.equal(res.data.results.length, 3, 'should still have 3 result groups');
    const tennisGroup = res.data.results.find((r) => r.league === 'Tennis');
    assert.equal(tennisGroup.plays.length, 1, 'Tennis should still have original play');
    assert.equal(tennisGroup.market, 'Moneyline', 'Tennis market should be unchanged');
  });

  it("respects --no-tennis-fallback flag (flags['tennis-fallback'] === false)", async () => {
    const res = {
      data: {
        results: [{ league: 'MLB', market: 'Moneyline', plays: [{ selection: 'Yankees', odds: -120 }] }],
        totalCount: 1
      }
    };

    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'mlb', 'tennis'], { 'tennis-fallback': false }, {});
    } finally {
      restoreConsole(orig);
    }

    assert.equal(res.data.results.length, 1, 'should still have only the original group');
    const tennisGroup = res.data.results.find((r) => r.league === 'Tennis');
    assert.equal(tennisGroup, undefined, 'Tennis fallback should NOT be injected');
  });

  it('does not affect scans that do not include tennis', async () => {
    const res = {
      data: {
        results: [
          { league: 'MLB', market: 'Moneyline', plays: [{ selection: 'Yankees', odds: -120 }] },
          { league: 'NBA', market: 'Spread', plays: [{ selection: 'Lakers', odds: -110 }] }
        ],
        totalCount: 2
      }
    };

    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'mlb', 'nba'], {}, {});
    } finally {
      restoreConsole(orig);
    }

    assert.equal(res.data.results.length, 2, 'should have only the original groups');
    const tennisGroup = res.data.results.find((r) => r.league === 'Tennis');
    assert.equal(tennisGroup, undefined, 'Tennis should not appear');
  });

  it('handles case where tennis bucket is absent from results (not just empty)', async () => {
    // quick_screen may not include a Tennis result group at all when
    // the pipeline dropped it — fallback should still inject one.
    const res = {
      data: {
        results: [{ league: 'MLB', market: 'Moneyline', plays: [{ selection: 'Yankees', odds: -120 }] }],
        totalCount: 1
      }
    };

    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'mlb', 'tennis', 'nba'], {}, {});
    } finally {
      restoreConsole(orig);
    }

    const results = res.data.results;
    const tennisGroup = results.find((r) => r.league === 'Tennis');
    assert.ok(tennisGroup, 'Tennis fallback should be injected even when absent from results');
    assert.ok(tennisGroup.plays.length > 0, 'fallback group should have plays');
    assert.equal(results.length, 2, 'should have 2 groups (MLB + injected Tennis); NBA not in source results');
    // NBA was requested but not in quick_screen results (pipeline dropped it,
    // not the same issue as tennis — the fallback only injects tennis)
  });

  it('handles mixed case where tennis bucket exists but has 0 plays', async () => {
    const res = {
      data: {
        results: [
          { league: 'MLB', market: 'Moneyline', plays: [{ selection: 'Yankees', odds: -120 }] },
          { league: 'Tennis', market: 'Moneyline', plays: [] },
          { league: 'NBA', market: 'Spread', plays: [{ selection: 'Lakers', odds: -110 }] }
        ],
        totalCount: 2
      }
    };

    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'mlb', 'tennis', 'nba'], {}, {});
    } finally {
      restoreConsole(orig);
    }

    const results = res.data.results;
    assert.equal(results.length, 3, 'should have 3 groups');
    const tennisGroup = results.find((r) => r.league === 'Tennis');
    assert.ok(tennisGroup, 'Tennis group should exist');
    assert.equal(tennisGroup.market, 'All Markets', 'empty Tennis bucket was replaced with fallback');
    assert.ok(tennisGroup.plays.length > 0, 'Tennis should have fallback plays');
  });

  it('replaces lowercase tennis buckets instead of appending duplicate fallback output', async () => {
    const res = {
      data: {
        results: [
          { league: 'tennis', market: 'Moneyline', plays: [] },
          { league: 'tennis', market: 'Game Handicap', plays: [] },
          { league: 'MLB', market: 'Moneyline', plays: [{ selection: 'Yankees', odds: -120 }] }
        ],
        totalCount: 1
      }
    };

    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'tennis', 'mlb'], {}, {});
    } finally {
      restoreConsole(orig);
    }

    const tennisGroups = res.data.results.filter((r) => String(r.league).toLowerCase() === 'tennis');
    assert.equal(tennisGroups.length, 1, 'should leave exactly one Tennis group after fallback replacement');
    assert.equal(tennisGroups[0].league, 'Tennis', 'fallback output should normalize league casing');
    assert.equal(
      tennisGroups[0].market,
      'All Markets',
      'fallback output should replace empty per-market tennis buckets'
    );
    assert.ok(tennisGroups[0].plays.length > 0, 'replacement tennis group should contain fallback plays');
    assert.ok(res.data.totalCount >= tennisGroups[0].plays.length, 'totalCount should include fallback plays');
  });

  it('does not inject fallback when lowercase tennis bucket already has plays', async () => {
    const res = {
      data: {
        results: [
          { league: 'tennis', market: 'Moneyline', plays: [{ selection: 'Djokovic', odds: -150 }] },
          { league: 'MLB', market: 'Moneyline', plays: [{ selection: 'Yankees', odds: -120 }] }
        ],
        totalCount: 2
      }
    };

    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'tennis', 'mlb'], {}, {});
    } finally {
      restoreConsole(orig);
    }

    const tennisGroups = res.data.results.filter((r) => String(r.league).toLowerCase() === 'tennis');
    assert.equal(tennisGroups.length, 1, 'existing lowercase tennis bucket should be preserved');
    assert.equal(tennisGroups[0].market, 'Moneyline', 'existing populated tennis bucket should not be replaced');
    assert.equal(tennisGroups[0].plays.length, 1, 'existing populated tennis bucket should stay intact');
    assert.equal(res.data.totalCount, 2, 'totalCount unchanged (2 original plays)');
  });

  it('preserves totalCount with addition of fallback plays', async () => {
    const res = {
      data: {
        results: [{ league: 'MLB', market: 'Moneyline', plays: [{ selection: 'Yankees', odds: -120 }] }],
        totalCount: 1
      }
    };

    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'mlb', 'tennis'], {}, {});
    } finally {
      restoreConsole(orig);
    }

    // totalCount should have been incremented by fallback plays
    assert.ok(res.data.totalCount >= 2, 'totalCount should include fallback plays');
  });

  it('handles tennis-only scan where quick_screen returns empty results (fallback injects Tennis bucket)', async () => {
    const res = {
      data: {
        results: [],
        totalCount: 0
      }
    };

    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'tennis'], {}, {});
    } finally {
      restoreConsole(orig);
    }

    const results = res.data.results;
    assert.equal(results.length, 1, 'should have 1 result group');
    assert.equal(results[0].league, 'Tennis', 'bucket league should be canonical Tennis');
    assert.equal(results[0].market, 'All Markets', 'fallback bucket uses All Markets label');
    assert.ok(results[0].plays.length > 0, 'fallback group should contain plays');
    assert.ok(res.data.totalCount >= 1, 'totalCount should include fallback plays');
  });

  it('handles tennis-only scan with lowercase empty tennis buckets (normalizes to single canonical Tennis)', async () => {
    const res = {
      data: {
        results: [
          { league: 'tennis', market: 'Moneyline', plays: [] },
          { league: 'tennis', market: 'Game Handicap', plays: [] }
        ],
        totalCount: 0
      }
    };

    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'tennis'], {}, {});
    } finally {
      restoreConsole(orig);
    }

    const results = res.data.results;
    const tennisGroups = results.filter((r) => String(r.league).toLowerCase() === 'tennis');
    assert.equal(tennisGroups.length, 1, 'should leave exactly one Tennis group');
    assert.equal(tennisGroups[0].league, 'Tennis', 'normalized to canonical casing');
    assert.equal(
      tennisGroups[0].market,
      'All Markets',
      'fallback replaces per-market buckets with a single All Markets group'
    );
    assert.ok(tennisGroups[0].plays.length > 0, 'fallback group should contain plays');
    assert.equal(results.length, 1, 'only Tennis bucket in results');
    assert.ok(res.data.totalCount >= 1, 'totalCount should include fallback plays');
  });

  it('does not replace lowercase tennis bucket with plays in tennis-only scan', async () => {
    const res = {
      data: {
        results: [{ league: 'tennis', market: 'Moneyline', plays: [{ selection: 'Djokovic', odds: -150 }] }],
        totalCount: 1
      }
    };

    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'tennis'], {}, {});
    } finally {
      restoreConsole(orig);
    }

    const results = res.data.results;
    const tennisGroups = results.filter((r) => String(r.league).toLowerCase() === 'tennis');
    assert.equal(tennisGroups.length, 1, 'existing lowercase tennis bucket preserved');
    assert.equal(tennisGroups[0].market, 'Moneyline', 'existing bucket not replaced');
    assert.equal(tennisGroups[0].plays.length, 1, 'existing plays intact');
    assert.equal(res.data.totalCount, 1, 'totalCount unchanged');
  });

  // ── -B (onlyBets) regression tests ──────────────────────────────
  // These prove the fix for the live scan bug where non-BET tennis
  // fallback rows leaked into `pp scan -b NoVigApp -B -j` output.

  it('-B filters out CONSIDER tennis fallback rows in mixed-league scan', async () => {
    const res = {
      data: {
        results: [{ league: 'MLB', market: 'Moneyline', plays: [{ selection: 'Yankees', odds: -120 }] }],
        totalCount: 1
      }
    };
    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'mlb', 'tennis', '-B'], { B: true }, {});
    } finally {
      restoreConsole(orig);
    }
    const results = res.data.results;
    const tennisGroup = results.find((r) => r.league === 'Tennis');
    assert.ok(tennisGroup, 'Tennis group should exist');
    // Only the BET play should survive; CONSIDER should be filtered out
    assert.equal(tennisGroup.plays.length, 1, 'only BET play should survive -B filter');
    assert.equal(tennisGroup.plays[0].verdict, 'BET', 'surviving play must be BET');
    assert.equal(tennisGroup.plays[0].selection, 'Djokovic N', 'BET play is Djokovic');
  });

  it('-B updates totalCount to reflect only retained BET rows', async () => {
    const res = {
      data: {
        results: [{ league: 'MLB', market: 'Moneyline', plays: [{ selection: 'Yankees', odds: -120 }] }],
        totalCount: 1
      }
    };
    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'mlb', 'tennis', '-B'], { B: true }, {});
    } finally {
      restoreConsole(orig);
    }
    // totalCount should be 1 (MLB) + 1 (BET tennis) = 2, not 1 + 2 = 3
    assert.equal(res.data.totalCount, 2, 'totalCount = original + BET plays only');
  });

  it('-B filters CONSIDER rows in tennis-only scan', async () => {
    const res = {
      data: {
        results: [],
        totalCount: 0
      }
    };
    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'tennis', '-B'], { B: true }, {});
    } finally {
      restoreConsole(orig);
    }
    const results = res.data.results;
    assert.equal(results.length, 1, 'should have 1 Tennis result group');
    assert.equal(results[0].plays.length, 1, 'only BET play survives -B in tennis-only scan');
    assert.equal(results[0].plays[0].verdict, 'BET');
    assert.equal(res.data.totalCount, 1, 'totalCount should reflect only BET rows');
  });

  it('without -B, all tennis fallback rows (BET + CONSIDER) are included', async () => {
    const res = {
      data: {
        results: [{ league: 'MLB', market: 'Moneyline', plays: [{ selection: 'Yankees', odds: -120 }] }],
        totalCount: 1
      }
    };
    const handlers = { quick_screen: async () => res };
    const orig = suppressConsole();
    try {
      await cmdScan(handlers, ['pp', 'scan', 'mlb', 'tennis'], {}, {});
    } finally {
      restoreConsole(orig);
    }
    const tennisGroup = res.data.results.find((r) => r.league === 'Tennis');
    assert.ok(tennisGroup, 'Tennis group should exist');
    assert.equal(tennisGroup.plays.length, 2, 'both BET and CONSIDER plays included without -B');
    assert.equal(res.data.totalCount, 3, 'totalCount includes all fallback plays');
  });

  // ── formatScan opener context regression tests ──────────────────

  it('prints opener to current odds line when both are present and different', () => {
    const results = [
      {
        league: 'Tennis',
        market: 'Moneyline',
        plays: [
          {
            selection: 'Djokovic',
            odds: -120,
            openingOdds: -140,
            currentOdds: -120,
            tier: 'TIER 1',
            verdict: 'BET',
            clvProxyPct: 3.4,
            edge: 2.1,
            books: 5,
            game: 'Djokovic vs Alcaraz',
            movementDisposition: 'supportive_clean'
          }
        ]
      }
    ];
    const out = formatScan(results);
    assert.match(out, /open -140 -> now -120/, 'shows opener-to-current path');
    assert.match(out, /vs open: longer/, 'indicates direction vs opener (American odds: -140→-120 is longer)');
    assert.match(out, /CLV vs open \+3¢/, 'CLV label references opener');
  });

  it('suppresses opener line when openingOdds equals currentOdds', () => {
    const results = [
      {
        league: 'Tennis',
        market: 'Moneyline',
        plays: [
          {
            selection: 'Djokovic',
            odds: -120,
            openingOdds: -120,
            currentOdds: -120,
            tier: 'TIER 1',
            verdict: 'BET',
            clvProxyPct: 0,
            edge: 1.5,
            books: 4,
            game: 'Djokovic vs Alcaraz',
            movementDisposition: 'insufficient'
          }
        ]
      }
    ];
    const out = formatScan(results);
    assert.equal(/open.*->.*now/.test(out), false, 'no opener line when equal');
  });

  it('suppresses opener line when openingOdds is missing', () => {
    const results = [
      {
        league: 'Tennis',
        market: 'Moneyline',
        plays: [
          {
            selection: 'Djokovic',
            odds: -120,
            openingOdds: undefined,
            currentOdds: -120,
            tier: 'TIER 2',
            verdict: 'CONSIDER',
            clvProxyPct: 0,
            edge: 0,
            books: 3,
            game: 'Djokovic vs Alcaraz',
            movementDisposition: 'insufficient'
          }
        ]
      }
    ];
    const out = formatScan(results);
    assert.equal(/open.*->.*now/.test(out), false, 'no opener line when opener missing');
  });

  it('suppresses opener line when currentOdds is missing', () => {
    const results = [
      {
        league: 'Tennis',
        market: 'Moneyline',
        plays: [
          {
            selection: 'Djokovic',
            odds: -120,
            openingOdds: -140,
            currentOdds: undefined,
            tier: 'TIER 2',
            verdict: 'CONSIDER',
            clvProxyPct: 0,
            edge: 0,
            books: 3,
            game: 'Djokovic vs Alcaraz',
            movementDisposition: 'insufficient'
          }
        ]
      }
    ];
    const out = formatScan(results);
    assert.equal(/open.*->.*now/.test(out), false, 'no opener line when current missing');
  });

  it('momentumLabel uses "vs open" wording for CLV', () => {
    const label = momentumLabel({ clvProxyPct: 6, movementDisposition: 'supportive_clean' });
    assert.match(label, /CLV vs open \+5¢/, 'high CLV references opener');
  });

  it('momentumLabel uses "vs open" wording for lower CLV', () => {
    const label = momentumLabel({ clvProxyPct: 4, movementDisposition: 'supportive_clean' });
    assert.match(label, /CLV vs open \+3¢/, 'medium CLV references opener');
  });

  it('formatScan shows "vs open: longer" when current is worse than opener', () => {
    const results = [
      {
        league: 'Tennis',
        market: 'Moneyline',
        plays: [
          {
            selection: 'Alcaraz',
            odds: 110,
            openingOdds: -105,
            currentOdds: 110,
            tier: 'TIER 2',
            verdict: 'CONSIDER',
            clvProxyPct: 0,
            edge: 0,
            books: 3,
            game: 'Djokovic vs Alcaraz',
            movementDisposition: 'adverse_full'
          }
        ]
      }
    ];
    const out = formatScan(results);
    assert.match(out, /open -105 -> now \+110/, 'shows adjusted odds path');
    assert.match(out, /vs open: longer/, 'indicates longer odds vs opener');
  });

  it('recentDriftContextLabel marks longer odds as recent adverse', () => {
    const label = recentDriftContextLabel(-147, -141);
    assert.match(label, /prev -147 -> now -141/);
    assert.match(label, /since last scan: longer \(recent adverse\)/);
  });

  it('recentDriftContextLabel marks shorter odds as recent supportive', () => {
    const label = recentDriftContextLabel(163, 150);
    assert.match(label, /prev \+163 -> now \+150/);
    assert.match(label, /since last scan: shorter \(recent supportive\)/);
  });

  it('formatScan prints previous-scan drift when previousSeenOdds is present', () => {
    const results = [
      {
        league: 'MLB',
        market: 'Moneyline',
        plays: [
          {
            selection: 'Braves',
            odds: -141,
            currentOdds: -141,
            previousSeenOdds: -147,
            openingOdds: -152,
            tier: 'TIER 1',
            verdict: 'BET',
            clvProxyPct: 2.1,
            edge: 1.5,
            books: 4,
            game: 'Nationals vs Braves',
            movementDisposition: 'supportive_clean'
          }
        ]
      }
    ];
    const out = formatScan(results);
    assert.match(out, /prev -147 -> now -141/);
    assert.match(out, /recent adverse/);
  });

  it('cmdScan stores prior snapshot and shows drift on the next scan', async () => {
    const first = {
      data: {
        results: [
          {
            league: 'MLB',
            market: 'Moneyline',
            plays: [
              {
                selection: 'Braves',
                odds: -147,
                currentOdds: -147,
                game: 'Nationals vs Braves',
                gameId: 'MLB:1',
                book: 'NoVigApp',
                movementDisposition: 'supportive_clean',
                tier: 'TIER 1',
                verdict: 'BET'
              }
            ]
          }
        ],
        totalCount: 1
      }
    };
    const second = {
      data: {
        results: [
          {
            league: 'MLB',
            market: 'Moneyline',
            plays: [
              {
                selection: 'Braves',
                odds: -141,
                currentOdds: -141,
                game: 'Nationals vs Braves',
                gameId: 'MLB:1',
                book: 'NoVigApp',
                movementDisposition: 'supportive_clean',
                tier: 'TIER 1',
                verdict: 'BET'
              }
            ]
          }
        ],
        totalCount: 1
      }
    };

    const handlers = {
      quick_screen: async () => {
        const next = handlers.__calls === 0 ? first : second;
        handlers.__calls += 1;
        return next;
      },
      __calls: 0
    };

    let logs = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(' '));
    console.error = () => {};
    try {
      await cmdScan(handlers, ['pp', 'scan', 'mlb'], {}, {});
      logs = [];
      await cmdScan(handlers, ['pp', 'scan', 'mlb'], {}, {});
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    const joined = logs.join('\n');
    assert.match(joined, /prev -147 -> now -141/);
    assert.match(joined, /recent adverse/);
  });

  it('snapshot keys include the book so scans from different books do not cross-contaminate', () => {
    const noVigKey = snapshotStore.buildSnapshotKey({
      league: 'MLB',
      market: 'Moneyline',
      gameId: 'MLB:1',
      selection: 'Braves',
      book: 'NoVigApp'
    });
    const dkKey = snapshotStore.buildSnapshotKey({
      league: 'MLB',
      market: 'Moneyline',
      gameId: 'MLB:1',
      selection: 'Braves',
      book: 'DraftKings'
    });
    assert.notEqual(noVigKey, dkKey);
  });

  it('ignores stale previous snapshots older than the TTL', () => {
    const staleSeenAt = new Date(Date.now() - snapshotStore.DEFAULT_PREVIOUS_SNAPSHOT_TTL_MS - 1000).toISOString();
    const key = snapshotStore.buildSnapshotKey({
      league: 'MLB',
      market: 'Moneyline',
      gameId: 'MLB:1',
      selection: 'Braves',
      book: 'NoVigApp'
    });
    const results = [
      {
        league: 'MLB',
        market: 'Moneyline',
        plays: [
          {
            selection: 'Braves',
            gameId: 'MLB:1',
            book: 'NoVigApp',
            currentOdds: -141,
            odds: -141
          }
        ]
      }
    ];
    snapshotStore.annotateResultsWithPreviousSnapshot(results, {
      [key]: { odds: -147, seenAt: staleSeenAt }
    });
    assert.equal(results[0].plays[0].previousSeenOdds, undefined);
  });

  it('preserves existing snapshot entries when a later scan returns no plays', async () => {
    const first = {
      data: {
        results: [
          {
            league: 'MLB',
            market: 'Moneyline',
            plays: [
              {
                selection: 'Braves',
                odds: -147,
                currentOdds: -147,
                game: 'Nationals vs Braves',
                gameId: 'MLB:1',
                book: 'NoVigApp',
                movementDisposition: 'supportive_clean',
                tier: 'TIER 1',
                verdict: 'BET'
              }
            ]
          }
        ],
        totalCount: 1
      }
    };
    const empty = {
      data: {
        results: [],
        totalCount: 0
      }
    };

    const handlers = {
      quick_screen: async () => {
        const next = handlers.__calls === 0 ? first : empty;
        handlers.__calls += 1;
        return next;
      },
      __calls: 0
    };

    const origLog = console.log;
    const origError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      await cmdScan(handlers, ['pp', 'scan', 'mlb'], {}, {});
      const afterFirst = snapshotStore.loadSnapshot();
      assert.equal(Object.keys(afterFirst).length, 1);
      await cmdScan(handlers, ['pp', 'scan', 'mlb'], {}, {});
      const afterEmpty = snapshotStore.loadSnapshot();
      assert.equal(Object.keys(afterEmpty).length, 1);
      assert.deepEqual(afterEmpty, afterFirst);
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  });
});
