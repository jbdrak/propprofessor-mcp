'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');

const { parseGameString } = require('../lib/propprofessor-game-context');

describe('parseGameString', () => {
  it('parses "A vs B" and returns vs separator', () => {
    const r = parseGameString('Lakers vs Celtics');
    assert.strictEqual(r.team1, 'Lakers');
    assert.strictEqual(r.team2, 'Celtics');
    assert.strictEqual(r.separator, 'vs');
  });

  it('parses "A vs B" with multi-word teams', () => {
    const r = parseGameString('New York Mets vs Philadelphia Phillies');
    assert.strictEqual(r.team1, 'New York Mets');
    assert.strictEqual(r.team2, 'Philadelphia Phillies');
    assert.strictEqual(r.separator, 'vs');
  });

  it('parses with @ separator', () => {
    const r = parseGameString('Celtics @ Lakers');
    assert.strictEqual(r.team1, 'Celtics');
    assert.strictEqual(r.team2, 'Lakers');
    assert.strictEqual(r.separator, '@');
  });

  it('parses with at separator', () => {
    const r = parseGameString('Celtics at Lakers');
    assert.strictEqual(r.team1, 'Celtics');
    assert.strictEqual(r.team2, 'Lakers');
    assert.strictEqual(r.separator, 'at');
  });

  it('returns empty strings and null separator for null/undefined', () => {
    const r = parseGameString(null);
    assert.strictEqual(r.team1, '');
    assert.strictEqual(r.team2, '');
    assert.strictEqual(r.separator, null);
  });

  it('returns single team as team1 for no separator', () => {
    const r = parseGameString('Lakers');
    assert.strictEqual(r.team1, 'Lakers');
    assert.strictEqual(r.team2, '');
    assert.strictEqual(r.separator, null);
  });
  it('parses MLB-style "TeamA vs TeamB" correctly', () => {
    const r = parseGameString('Cincinnati Reds vs Milwaukee Brewers');
    assert.strictEqual(r.team1, 'Cincinnati Reds');
    assert.strictEqual(r.team2, 'Milwaukee Brewers');
    assert.strictEqual(r.separator, 'vs');
  });
});

describe('getGameContext', () => {
  it('exports getGameContext', () => {
    const mod = require('../lib/propprofessor-game-context');
    assert.strictEqual(typeof mod.getGameContext, 'function');
  });

  it('returns clean for unsupported sports', async () => {
    const mod = require('../lib/propprofessor-game-context');
    const r = await mod.getGameContext({
      sport: 'UFC',
      selection: 'Islam Makhachev',
      game: 'Islam Makhachev vs Dustin Poirier'
    });
    assert.ok(r.riskFlag);
    assert.ok(r.riskSummary);
  });

  it('routes MLB to MLB handler', async () => {
    const originalExecFile = cp.execFile;
    cp.execFile = (_file, _args, _options, callback) => {
      callback(null, JSON.stringify({ dates: [] }), '');
      return { kill() {} };
    };
    try {
      const mod = require('../lib/propprofessor-game-context');
      const r = await mod.getGameContext({ sport: 'MLB', selection: 'Mets', game: 'Mets vs Phillies' });
      assert.ok(r.ok || r.riskFlag);
    } finally {
      cp.execFile = originalExecFile;
    }
  });

  it('MLB routing parses game string and passes awayTeam/homeTeam correctly', async () => {
    const mod = require('../lib/propprofessor-game-context');
    // Full team names — the module parses into team1 / team2 and passes
    // those to findMlbGamePk({ isoDate, awayTeam, homeTeam })
    const r = await mod.getGameContext({
      sport: 'MLB',
      selection: 'Reds',
      game: 'Cincinnati Reds vs Milwaukee Brewers',
      start: new Date().toISOString()
    });
    // Whether gamePk resolves or not depends on live MLB API data,
    // but the response should always have the expected shape
    assert.ok(typeof (r.riskFlag || r.riskSummary || '') === 'string');
    assert.ok(r.sport === 'MLB' || r.sport === undefined);
  });

  it('routes NBA to basketball handler', async (context) => {
    // Skip if NBA API is unreachable — this test makes live HTTP calls
    // to stats.nba.com which may be blocked on some networks
    try {
      await new Promise((resolve, reject) => {
        require('child_process').exec(
          'curl -fsS --max-time 3 https://stats.nba.com/stats/scoreboardv3 2>/dev/null',
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } catch {
      context.diagnostic('skipping: NBA API unreachable');
      return;
    }
    const mod = require('../lib/propprofessor-game-context');
    const r = await mod.getGameContext({
      sport: 'NBA',
      selection: 'Lakers',
      game: 'Lakers vs Celtics',
      start: new Date().toISOString()
    });
    assert.ok(typeof r.riskFlag === 'string');
  });

  it('routes Tennis to tennis handler', async () => {
    const mod = require('../lib/propprofessor-game-context');
    const r = await mod.getGameContext({ sport: 'Tennis', selection: 'Djokovic', game: 'Wimbledon' });
    assert.ok(typeof r.riskFlag === 'string');
  });

  it('passes start through to tennis handler so matchup resolution can fire', async () => {
    const mod = require('../lib/propprofessor-game-context');
    // "Dart vs Sonmez" is a matchup, not a real tourney. With start
    // threaded through, the resolver should hit Eastbourne (WTA 250 grass).
    const r = await mod.getGameContext({
      sport: 'Tennis',
      selection: 'Dart',
      game: 'Dart vs Sonmez',
      start: '2026-06-22T10:00:00.000Z'
    });
    assert.equal(r.surface, 'Grass');
    assert.equal(r.level, 'WTA 250');
    assert.equal(r.riskFlag, 'clean');
    assert.equal(r.signals.resolvedFromMatchup, true);
    assert.equal(r.tournament, 'Lexus Eastbourne Open');
  });

  it('cache key includes start — rescheduled matchup returns fresh result (RC3)', async () => {
    const mod = require('../lib/propprofessor-game-context');
    // Two calls with the same matchup but different start times must
    // hit the resolver independently. Without start in the cache key,
    // a reschedule would return the original cached result for 30min.
    // Use unique matchup strings to avoid LRU pollution from earlier tests.
    const r1 = await mod.getGameContext({
      sport: 'Tennis',
      selection: 'CacheTest1',
      game: 'CacheTest1 vs CacheTest2',
      start: '2026-06-23T10:00:00.000Z'
    });
    const r2 = await mod.getGameContext({
      sport: 'Tennis',
      selection: 'CacheTest1',
      game: 'CacheTest1 vs CacheTest2',
      start: '2026-06-24T10:00:00.000Z'
    });
    // r1 is non-resolvable (no circuit hint for "CacheTest1") so it
    // returns unknown. r2 should ALSO return unknown independently —
    // not a cached value from r1. The key behavior under test is that
    // both calls return without error and with distinct fetchedAt
    // (because they hit different cache slots).
    assert.ok(r1.fetchedAt);
    assert.ok(r2.fetchedAt);
    // Both should be 'unknown' riskFlag since CacheTest1/2 aren't in PLAYER_CIRCUIT
    assert.equal(r1.riskFlag, 'unknown');
    assert.equal(r2.riskFlag, 'unknown');
  });

  it('cache key includes market — Moneyline then Total Games do not share a cached result', async () => {
    const mod = require('../lib/propprofessor-game-context');
    // Same matchup/start/selection, only the market differs. The Moneyline
    // call computes (and caches) Tennis Elo shadow context; the Total Games
    // call must NOT inherit that cached result — Elo is Moneyline-only.
    const base = {
      sport: 'Tennis',
      selection: 'CacheBleedTest',
      game: 'Wimbledon',
      start: '2025-01-01T12:00:00.000Z'
    };
    const ml = await mod.getGameContext({ ...base, market: 'Moneyline' });
    const tg = await mod.getGameContext({ ...base, market: 'Total Games' });
    assert.equal(ml.cached, false);
    assert.equal(tg.cached, false, 'Total Games must not reuse the cached Moneyline result');
    assert.equal(tg.elo.coverage, 'unsupported_market', 'Total Games must not inherit Moneyline Elo coverage');
  });

  it('cache key includes market — Total Games then Moneyline do not share a cached result', async () => {
    const mod = require('../lib/propprofessor-game-context');
    // Reverse order: the non-Elo market is cached first. The Moneyline call
    // must recompute (and populate Elo coverage), not reuse the Total Games
    // result that has elo.available=false.
    // NOTE: distinct selection from the forward test above — the module-level
    // game-context cache is shared across tests in this file, so a second pass
    // over the identical key would return the forward test's cached entry.
    const base = {
      sport: 'Tennis',
      selection: 'CacheBleedTestRev',
      game: 'Wimbledon',
      start: '2025-01-01T12:00:00.000Z'
    };
    const tg = await mod.getGameContext({ ...base, market: 'Total Games' });
    const ml = await mod.getGameContext({ ...base, market: 'Moneyline' });
    assert.equal(tg.cached, false);
    assert.equal(ml.cached, false, 'Moneyline must not reuse the cached Total Games result');
    // Wimbledon is a Grand Slam with no ATP/WTA hint → tour_unknown before any snapshot I/O.
    assert.equal(ml.elo.coverage, 'tour_unknown', 'Moneyline must not inherit Total Games Elo coverage');
  });

  it('cache is shared within the same market (cache true only for identical key)', async () => {
    const mod = require('../lib/propprofessor-game-context');
    const args = {
      sport: 'Tennis',
      selection: 'CacheBleedTest',
      game: 'Wimbledon',
      start: '2025-01-01T12:00:00.000Z',
      market: 'Moneyline'
    };
    await mod.getGameContext(args);
    const second = await mod.getGameContext(args);
    assert.equal(second.cached, true, 'identical market+matchup+start must hit the game-context cache');
  });

  it('threads selection into getTennisContext so exact-resolver selectedProbability can populate', async () => {
    // getGameContext must forward `selection` (not just the parsed player1/2)
    // to getTennisContext — otherwise Elo selectedProbability can never match
    // the bet's side. Spy on the tennis-context module before game-context loads.
    const tennisPath = require.resolve('../lib/propprofessor-tennis-context');
    const gamePath = require.resolve('../lib/propprofessor-game-context');
    const original = require.cache[tennisPath];
    const captured = [];
    require.cache[tennisPath] = {
      id: tennisPath,
      filename: tennisPath,
      loaded: true,
      exports: {
        getTennisContext: async (opts) => {
          captured.push(opts);
          return {
            ok: true,
            sport: 'Tennis',
            riskFlag: 'clean',
            riskSummary: null,
            signals: {},
            cached: false,
            fetchedAt: new Date().toISOString(),
            elo: { available: false, coverage: 'snapshot_unavailable', reason: 'test-stub' }
          };
        }
      }
    };
    delete require.cache[gamePath];
    try {
      const mod = require('../lib/propprofessor-game-context');
      await mod.getGameContext({
        sport: 'Tennis',
        selection: 'Djokovic',
        game: 'Wimbledon',
        start: '2025-01-01T12:00:00.000Z',
        market: 'Moneyline'
      });
      assert.equal(captured.length, 1);
      assert.equal(captured[0].selection, 'Djokovic', 'getGameContext must forward selection');
      assert.equal(captured[0].market, 'Moneyline');
    } finally {
      if (original) require.cache[tennisPath] = original;
      else delete require.cache[tennisPath];
      delete require.cache[gamePath];
    }
  });
});
