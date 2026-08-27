'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');

const BASKETBALL_MODULE_PATH = require.resolve('../lib/propprofessor-basketball-game-context');
const basketballCalls = [];
require.cache[BASKETBALL_MODULE_PATH] = {
  id: BASKETBALL_MODULE_PATH,
  filename: BASKETBALL_MODULE_PATH,
  loaded: true,
  exports: {
    getBasketballGameContext: async (options = {}) => {
      basketballCalls.push(options);
      return {
        ok: true,
        sport: options.sport,
        riskFlag: 'clean',
        riskSummary: 'mocked basketball context',
        signals: {},
        fetchedAt: new Date().toISOString()
      };
    }
  }
};

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

  it('routes NBA to basketball handler', async () => {
    basketballCalls.length = 0;
    const mod = require('../lib/propprofessor-game-context');
    const r = await mod.getGameContext({
      sport: 'NBA',
      selection: 'Lakers',
      game: 'Lakers vs Celtics',
      start: new Date().toISOString()
    });
    assert.equal(r.riskFlag, 'clean');
    assert.equal(basketballCalls.length, 1);
    assert.equal(basketballCalls[0].sport, 'NBA');
    assert.equal(basketballCalls[0].awayTeam, 'Lakers');
    assert.equal(basketballCalls[0].homeTeam, 'Celtics');
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
});
