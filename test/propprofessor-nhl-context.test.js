'use strict';

const { describe, it, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const path = require('path');

const MODULE_PATH = path.resolve(__dirname, '../lib/propprofessor-nhl-context');

/**
 * Build an NHL schedule response for a single date.
 * Matches the api-web.nhle.com shape.
 */
function scheduleResponse(date, games) {
  return JSON.stringify({
    nextStartDate: '2026-06-28',
    previousStartDate: '2026-06-14',
    gameWeek: [
      {
        date,
        games
      }
    ]
  });
}

/**
 * Build a single NHL game object matching the NHL API shape.
 */
function makeGame({
  gameId = 2024021234,
  _date = '2026-06-20',
  awayPlace = 'Boston',
  awayCommon = 'Bruins',
  awayAbbrev = 'BOS',
  homePlace = 'Montréal',
  homeCommon = 'Canadiens',
  homeAbbrev = 'MTL',
  gameType = 2,
  gameState = 'OFF'
} = {}) {
  return {
    id: gameId,
    gameType,
    gameState,
    awayTeam: {
      abbrev: awayAbbrev,
      placeName: { default: awayPlace },
      commonName: { default: awayCommon }
    },
    homeTeam: {
      abbrev: homeAbbrev,
      placeName: { default: homePlace },
      commonName: { default: homeCommon }
    }
  };
}

describe('propprofessor-nhl-context', { concurrency: false }, () => {
  let originalExecFile;

  beforeEach(() => {
    originalExecFile = cp.execFile;
  });

  afterEach(() => {
    cp.execFile = originalExecFile;
    delete require.cache[require.resolve(MODULE_PATH)];
  });

  // ── Basic exports ────────────────────────────────────────────────────

  it('exports getNhlContext as a function', () => {
    const mod = require(MODULE_PATH);
    assert.strictEqual(typeof mod.getNhlContext, 'function');
  });

  // ── Unknown / empty params → riskFlag: unknown ───────────────────────

  it('returns riskFlag: unknown for empty params', async () => {
    const mod = require(MODULE_PATH);
    const result = await mod.getNhlContext({});
    assert.strictEqual(result.riskFlag, 'unknown');
    assert.ok(result.riskSummary.includes('Insufficient parameters'));
  });

  it('returns riskFlag: unknown when only gamePk provided', async () => {
    const mod = require(MODULE_PATH);
    const result = await mod.getNhlContext({ gamePk: '123' });
    assert.strictEqual(result.riskFlag, 'unknown');
  });

  it('returns riskFlag: unknown when missing gameDate', async () => {
    const mod = require(MODULE_PATH);
    const result = await mod.getNhlContext({
      gamePk: '123',
      awayTeam: 'Boston Bruins',
      homeTeam: 'Montreal Canadiens'
    });
    assert.strictEqual(result.riskFlag, 'unknown');
  });

  it('returns riskFlag: unknown when missing awayTeam', async () => {
    const mod = require(MODULE_PATH);
    const result = await mod.getNhlContext({
      gamePk: '123',
      homeTeam: 'Montreal Canadiens',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(result.riskFlag, 'unknown');
  });

  it('returns riskFlag: unknown when missing homeTeam', async () => {
    const mod = require(MODULE_PATH);
    const result = await mod.getNhlContext({
      gamePk: '123',
      awayTeam: 'Boston Bruins',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(result.riskFlag, 'unknown');
  });

  // ── NHL context — schedule fetch ─────────────────────────────────────

  it('returns clean risk when no recent games found', async () => {
    // Mock all 6 curl calls (offset -5…0) to return empty scoreboards
    let callCount = 0;
    cp.execFile = (_cmd, _args, _opts, cb) => {
      const fn = typeof cb === 'function' ? cb : typeof _opts === 'function' ? _opts : null;
      callCount++;
      if (fn) fn(null, scheduleResponse('2026-06-21', []), '');
    };
    const mod = require(MODULE_PATH);
    const result = await mod.getNhlContext({
      gamePk: 'g1',
      awayTeam: 'Boston Bruins',
      homeTeam: 'Montreal Canadiens',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.sport, 'NHL');
    assert.strictEqual(result.awayTeam.restDays, null);
    assert.strictEqual(result.homeTeam.restDays, null);
    assert.strictEqual(result.riskFlag, 'clean');
    assert.strictEqual(result.riskSummary, null);
    // Should have been called for each of the 6 date offsets (-5…0)
    assert.ok(callCount >= 6);
  });

  it('computes rest days from recent schedule', async () => {
    // Return games on specific dates matching team names
    cp.execFile = (_cmd, args, _opts, cb) => {
      const fn = typeof cb === 'function' ? cb : typeof _opts === 'function' ? _opts : null;
      const joined = Array.isArray(args) ? args.join(' ') : String(args);
      if (joined.includes('/2026-06-20')) {
        // BOS (Boston Bruins) played Jun 20
        fn(
          null,
          scheduleResponse('2026-06-20', [
            makeGame({
              gameId: 100,
              awayPlace: 'Boston',
              awayCommon: 'Bruins',
              awayAbbrev: 'BOS',
              homePlace: 'Toronto',
              homeCommon: 'Maple Leafs',
              homeAbbrev: 'TOR'
            })
          ]),
          ''
        );
      } else if (joined.includes('/2026-06-18')) {
        // MTL (Montreal Canadiens) played Jun 18
        fn(
          null,
          scheduleResponse('2026-06-18', [
            makeGame({
              gameId: 101,
              awayPlace: 'Montréal',
              awayCommon: 'Canadiens',
              awayAbbrev: 'MTL',
              homePlace: 'Ottawa',
              homeCommon: 'Senators',
              homeAbbrev: 'OTT'
            })
          ]),
          ''
        );
      } else {
        fn(null, scheduleResponse('2026-06-21', []), '');
      }
    };
    const mod = require(MODULE_PATH);
    const result = await mod.getNhlContext({
      gamePk: 'g2',
      awayTeam: 'Boston Bruins',
      homeTeam: 'Montreal Canadiens',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(result.ok, true);
    // BOS last played Jun 20 → 1 day rest (back-to-back)
    assert.strictEqual(result.awayTeam.restDays, 1);
    assert.strictEqual(result.awayTeam.backToBack, true);
    // MTL last played Jun 18 → 3 days rest
    assert.strictEqual(result.homeTeam.restDays, 3);
    assert.strictEqual(result.homeTeam.backToBack, false);
    // riskFlag is low because one team is on b2b AND restDisparity >= 2
    assert.strictEqual(result.riskFlag, 'low');
    assert.strictEqual(result.signals.restDisparity, -2); // 1 - 3 = -2 (away has less rest)
  });

  it('detects both-teams on back-to-back', async () => {
    cp.execFile = (_cmd, args, _opts, cb) => {
      const fn = typeof cb === 'function' ? cb : typeof _opts === 'function' ? _opts : null;
      const joined = Array.isArray(args) ? args.join(' ') : String(args);
      if (joined.includes('/2026-06-20')) {
        fn(
          null,
          scheduleResponse('2026-06-20', [
            makeGame({
              gameId: 200,
              awayPlace: 'Boston',
              awayCommon: 'Bruins',
              awayAbbrev: 'BOS',
              homePlace: 'New York',
              homeCommon: 'Rangers',
              homeAbbrev: 'NYR'
            }),
            makeGame({
              gameId: 201,
              awayPlace: 'Montréal',
              awayCommon: 'Canadiens',
              awayAbbrev: 'MTL',
              homePlace: 'Toronto',
              homeCommon: 'Maple Leafs',
              homeAbbrev: 'TOR'
            })
          ]),
          ''
        );
      } else {
        fn(null, scheduleResponse('2026-06-21', []), '');
      }
    };
    const mod = require(MODULE_PATH);
    const result = await mod.getNhlContext({
      gamePk: 'g3',
      awayTeam: 'Boston Bruins',
      homeTeam: 'Montreal Canadiens',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.awayTeam.backToBack, true);
    assert.strictEqual(result.homeTeam.backToBack, true);
    assert.strictEqual(result.signals.awayBackToBack, true);
    assert.strictEqual(result.signals.homeBackToBack, true);
    assert.strictEqual(result.riskFlag, 'low');
    assert.ok(result.riskSummary.includes('both teams on back-to-back'));
  });

  // ── Team name matching (abbrev, accent handling) ─────────────────────

  it('matches team by abbreviation', async () => {
    cp.execFile = (_cmd, args, _opts, cb) => {
      const fn = typeof cb === 'function' ? cb : typeof _opts === 'function' ? _opts : null;
      const joined = Array.isArray(args) ? args.join(' ') : String(args);
      if (joined.includes('/2026-06-20')) {
        fn(
          null,
          scheduleResponse('2026-06-20', [
            makeGame({
              gameId: 300,
              awayPlace: 'Boston',
              awayCommon: 'Bruins',
              awayAbbrev: 'BOS',
              homePlace: 'New York',
              homeCommon: 'Rangers',
              homeAbbrev: 'NYR'
            })
          ]),
          ''
        );
      } else {
        fn(null, scheduleResponse('2026-06-21', []), '');
      }
    };
    const mod = require(MODULE_PATH);
    const result = await mod.getNhlContext({
      gamePk: 'g4',
      awayTeam: 'BOS',
      homeTeam: 'Montreal Canadiens',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.awayTeam.restDays, 1);
    assert.strictEqual(result.awayTeam.backToBack, true);
  });

  it('matches team with accented characters (Montréal → Montreal)', async () => {
    cp.execFile = (_cmd, args, _opts, cb) => {
      const fn = typeof cb === 'function' ? cb : typeof _opts === 'function' ? _opts : null;
      const joined = Array.isArray(args) ? args.join(' ') : String(args);
      if (joined.includes('/2026-06-20')) {
        fn(
          null,
          scheduleResponse('2026-06-20', [
            makeGame({
              gameId: 400,
              awayPlace: 'Montréal',
              awayCommon: 'Canadiens',
              awayAbbrev: 'MTL',
              homePlace: 'Boston',
              homeCommon: 'Bruins',
              homeAbbrev: 'BOS'
            })
          ]),
          ''
        );
      } else {
        fn(null, scheduleResponse('2026-06-21', []), '');
      }
    };
    const mod = require(MODULE_PATH);
    // Pass "Montreal" (without accent) — should match "Montréal" (with accent)
    const result = await mod.getNhlContext({
      gamePk: 'g5',
      awayTeam: 'Montreal Canadiens',
      homeTeam: 'Boston Bruins',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.awayTeam.restDays, 1);
    assert.strictEqual(result.awayTeam.backToBack, true);
  });

  // ── Validation ───────────────────────────────────────────────────────

  it('returns API_ERROR when fetch fails (invalid date format)', async () => {
    // The fetchSchedule function throws for invalid date format, which
    // propagates to the outer catch in getNhlContext.
    const mod = require(MODULE_PATH);
    const result = await mod.getNhlContext({
      gamePk: 'g6',
      awayTeam: 'Boston Bruins',
      homeTeam: 'Montreal Canadiens',
      gameDate: 'not-a-date'
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'API_ERROR');
    assert.ok(result.error.message.includes('invalid gameDate'));
  });

  // ── Caching ──────────────────────────────────────────────────────────

  it('caches results for repeated calls with same params', async () => {
    let callCount = 0;
    cp.execFile = (_cmd, _args, _opts, cb) => {
      const fn = typeof cb === 'function' ? cb : typeof _opts === 'function' ? _opts : null;
      callCount++;
      if (fn) fn(null, scheduleResponse('2026-06-21', []), '');
    };
    const mod = require(MODULE_PATH);
    const r1 = await mod.getNhlContext({
      gamePk: 'cached1',
      awayTeam: 'Boston Bruins',
      homeTeam: 'Montreal Canadiens',
      gameDate: '2026-06-21'
    });
    const firstCallCount = callCount;
    const r2 = await mod.getNhlContext({
      gamePk: 'cached1',
      awayTeam: 'Boston Bruins',
      homeTeam: 'Montreal Canadiens',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.cached, true);
    // Second call shouldn't have added any curl calls
    assert.strictEqual(callCount, firstCallCount);
  });

  // ── Unit helpers ─────────────────────────────────────────────────────

  it('parseScheduleGames returns empty for null/invalid', () => {
    const { parseScheduleGames } = require(MODULE_PATH);
    assert.deepStrictEqual(parseScheduleGames(null), []);
    assert.deepStrictEqual(parseScheduleGames({}), []);
    assert.deepStrictEqual(parseScheduleGames({ gameWeek: [] }), []);
  });

  it('parseScheduleGames parses a valid response', () => {
    const { parseScheduleGames } = require(MODULE_PATH);
    const raw = JSON.parse(scheduleResponse('2026-06-21', [makeGame({ gameId: 500, date: '2026-06-21' })]));
    const games = parseScheduleGames(raw);
    assert.strictEqual(games.length, 1);
    assert.strictEqual(games[0].gameId, '500');
    assert.strictEqual(games[0].gameDate, '2026-06-21');
    assert.strictEqual(games[0].awayTeam.displayName, 'Boston Bruins');
    assert.strictEqual(games[0].homeTeam.displayName, 'Montréal Canadiens');
    assert.strictEqual(games[0].awayTeam.abbrev, 'BOS');
    assert.strictEqual(games[0].homeTeam.abbrev, 'MTL');
  });

  it('computeRestDays calculates correctly', () => {
    const { computeRestDays } = require(MODULE_PATH);
    assert.strictEqual(computeRestDays('2026-06-21', '2026-06-20'), 1);
    assert.strictEqual(computeRestDays('2026-06-21', '2026-06-19'), 2);
    assert.strictEqual(computeRestDays('2026-06-21', null), null);
    assert.strictEqual(computeRestDays(null, '2026-06-20'), null);
  });

  it('isBackToBack returns correct booleans', () => {
    const { isBackToBack } = require(MODULE_PATH);
    assert.strictEqual(isBackToBack(0), true);
    assert.strictEqual(isBackToBack(1), true);
    assert.strictEqual(isBackToBack(2), false);
    assert.strictEqual(isBackToBack(null), false);
  });

  it('findLastPlayedGame returns most recent prior game date', () => {
    const { findLastPlayedGame } = require(MODULE_PATH);
    const games = [
      {
        gameDate: '2026-06-20',
        awayTeam: { displayName: 'Boston Bruins', commonName: 'Bruins', placeName: 'Boston', abbrev: 'BOS' },
        homeTeam: { displayName: 'New York Rangers', commonName: 'Rangers', placeName: 'New York', abbrev: 'NYR' }
      },
      {
        gameDate: '2026-06-21',
        awayTeam: { displayName: 'Boston Bruins', commonName: 'Bruins', placeName: 'Boston', abbrev: 'BOS' },
        homeTeam: { displayName: 'Montréal Canadiens', commonName: 'Canadiens', placeName: 'Montréal', abbrev: 'MTL' }
      } // same date, skipped
    ];
    const result = findLastPlayedGame(games, 'Boston Bruins', '2026-06-21');
    assert.strictEqual(result, '2026-06-20');
  });

  it('findLastPlayedGame returns null when no prior game exists', () => {
    const { findLastPlayedGame } = require(MODULE_PATH);
    const games = [
      {
        gameDate: '2026-06-21',
        awayTeam: { displayName: 'Boston Bruins', commonName: 'Bruins', placeName: 'Boston', abbrev: 'BOS' },
        homeTeam: { displayName: 'Montréal Canadiens', commonName: 'Canadiens', placeName: 'Montréal', abbrev: 'MTL' }
      }
    ];
    assert.strictEqual(findLastPlayedGame(games, 'Boston Bruins', '2026-06-21'), null);
  });

  it('findLastPlayedGame matches by abbreviation', () => {
    const { findLastPlayedGame } = require(MODULE_PATH);
    const games = [
      {
        gameDate: '2026-06-19',
        awayTeam: { displayName: 'Boston Bruins', commonName: 'Bruins', placeName: 'Boston', abbrev: 'BOS' },
        homeTeam: { displayName: 'New York Rangers', commonName: 'Rangers', placeName: 'New York', abbrev: 'NYR' }
      }
    ];
    const result = findLastPlayedGame(games, 'BOS', '2026-06-21');
    assert.strictEqual(result, '2026-06-19');
  });

  it('findLastPlayedGame matches by commonName', () => {
    const { findLastPlayedGame } = require(MODULE_PATH);
    const games = [
      {
        gameDate: '2026-06-19',
        awayTeam: { displayName: 'Boston Bruins', commonName: 'Bruins', placeName: 'Boston', abbrev: 'BOS' },
        homeTeam: { displayName: 'New York Rangers', commonName: 'Rangers', placeName: 'New York', abbrev: 'NYR' }
      }
    ];
    const result = findLastPlayedGame(games, 'Bruins', '2026-06-21');
    assert.strictEqual(result, '2026-06-19');
  });

  it('normalizeName handles accented characters', () => {
    const { normalizeName } = require(MODULE_PATH);
    assert.strictEqual(normalizeName('Montréal Canadiens'), 'montreal canadiens');
    assert.strictEqual(normalizeName('José Théodore'), 'jose theodore');
    assert.strictEqual(normalizeName('Boston Bruins'), 'boston bruins');
    assert.strictEqual(normalizeName(''), '');
    assert.strictEqual(normalizeName(null), '');
  });
});
