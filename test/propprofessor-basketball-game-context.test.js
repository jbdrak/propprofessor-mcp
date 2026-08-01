'use strict';

const { describe, it, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const path = require('path');

const MODULE_PATH = path.resolve(__dirname, '../lib/propprofessor-basketball-game-context');

/**
 * Build a scoreboardv3 response object for a single date.
 * Each game object follows the public stats.nba.com scoreboardv3 shape.
 */
function scoreboardResponse(gameDate, games) {
  return JSON.stringify({
    scoreboard: {
      gameDate,
      leagueId: '00',
      leagueName: 'National Basketball Association',
      games
    }
  });
}

function makeGame({ gameId = '0022300001', homeTeamName = 'Lakers', awayTeamName = 'Celtics' } = {}) {
  return {
    gameId,
    gameStatus: 1,
    gameStatusText: '7:00 pm ET',
    gameDateTimeUTC: '2026-06-22T00:00:00Z',
    homeTeam: {
      teamId: 1610612747,
      teamName: homeTeamName,
      teamTricode: homeTeamName === 'Lakers' ? 'LAL' : 'XXX',
      teamNickname: homeTeamName,
      wins: 40,
      losses: 20
    },
    awayTeam: {
      teamId: 1610612738,
      teamName: awayTeamName,
      teamTricode: awayTeamName === 'Celtics' ? 'BOS' : 'YYY',
      teamNickname: awayTeamName,
      wins: 35,
      losses: 25
    }
  };
}

describe('propprofessor-basketball-game-context', { concurrency: false }, () => {
  let originalExecFile;

  beforeEach(() => {
    originalExecFile = cp.execFile;
  });

  afterEach(() => {
    cp.execFile = originalExecFile;
    delete require.cache[require.resolve(MODULE_PATH)];
  });

  // ── Basic exports ────────────────────────────────────────────────────

  it('exports getBasketballGameContext as a function', () => {
    const mod = require(MODULE_PATH);
    assert.strictEqual(typeof mod.getBasketballGameContext, 'function');
  });

  // ── Unknown sport → riskFlag: unknown ────────────────────────────────

  it('returns riskFlag: unknown for NCAAB', async () => {
    // No curl mocks needed — unknown sport path doesn't reach fetchJsonNba
    const mod = require(MODULE_PATH);
    const result = await mod.getBasketballGameContext({
      gamePk: '123',
      sport: 'NCAAB',
      awayTeam: 'Duke',
      homeTeam: 'UNC'
    });
    assert.strictEqual(result.riskFlag, 'unknown');
    assert.ok(result.riskSummary.includes('not NBA or WNBA'));
  });

  it('returns riskFlag: unknown for NFL', async () => {
    const mod = require(MODULE_PATH);
    const result = await mod.getBasketballGameContext({
      gamePk: '99',
      sport: 'NFL',
      awayTeam: 'Chiefs',
      homeTeam: '49ers'
    });
    assert.strictEqual(result.riskFlag, 'unknown');
  });

  it('returns riskFlag: unknown for empty params', async () => {
    const mod = require(MODULE_PATH);
    const result = await mod.getBasketballGameContext({});
    assert.strictEqual(result.riskFlag, 'unknown');
  });

  // ── NBA context — schedule fetch ────────────────────────────────────

  it('returns clean risk when no recent games found', async () => {
    // Mock all 8 curl calls (offset -7…0) to return empty scoreboards
    let callCount = 0;
    cp.execFile = (_cmd, _args, _opts, cb) => {
      const fn = typeof cb === 'function' ? cb : typeof _opts === 'function' ? _opts : null;
      callCount++;
      if (fn) fn(null, scoreboardResponse('2026-06-21', []), '');
    };
    const mod = require(MODULE_PATH);
    const result = await mod.getBasketballGameContext({
      gamePk: 'g1',
      sport: 'NBA',
      awayTeam: 'Celtics',
      homeTeam: 'Lakers',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.sport, 'NBA');
    assert.strictEqual(result.awayTeam.restDays, null);
    assert.strictEqual(result.homeTeam.restDays, null);
    assert.strictEqual(result.riskFlag, 'clean');
    assert.strictEqual(result.riskSummary, null);
    // Should have been called for each of the 8 date offsets
    assert.ok(callCount > 0);
  });

  it('computes rest days from recent schedule', async () => {
    // Return scheduled Jun 20 games on the Jun 20 curl, empty for all others
    cp.execFile = (_cmd, args, _opts, cb) => {
      const fn = typeof cb === 'function' ? cb : typeof _opts === 'function' ? _opts : null;
      const joined = Array.isArray(args) ? args.join(' ') : String(args);
      if (joined.includes('GameDate=2026-06-20')) {
        // LAL played Jun 20
        fn(
          null,
          scoreboardResponse('2026-06-20', [
            makeGame({ gameId: 'prev', homeTeamName: 'Lakers', awayTeamName: 'Jazz' })
          ]),
          ''
        );
      } else if (joined.includes('GameDate=2026-06-18')) {
        // BOS played Jun 18
        fn(
          null,
          scoreboardResponse('2026-06-18', [
            makeGame({ gameId: 'prev2', homeTeamName: 'Celtics', awayTeamName: 'Knicks' })
          ]),
          ''
        );
      } else {
        fn(null, scoreboardResponse('2026-06-21', []), '');
      }
    };
    const mod = require(MODULE_PATH);
    const result = await mod.getBasketballGameContext({
      gamePk: 'g2',
      sport: 'NBA',
      awayTeam: 'Celtics',
      homeTeam: 'Lakers',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(result.ok, true);
    // LAL last played Jun 20 → 1 day rest (back-to-back)
    assert.strictEqual(result.homeTeam.restDays, 1);
    assert.strictEqual(result.homeTeam.backToBack, true);
    // BOS last played Jun 18 → 3 days rest
    assert.strictEqual(result.awayTeam.restDays, 3);
    assert.strictEqual(result.awayTeam.backToBack, false);
    // riskFlag is low because one team is on b2b AND restDisparity >= 2
    assert.strictEqual(result.riskFlag, 'low');
    assert.strictEqual(result.signals.restDisparity, 2); // 3 - 1
  });

  it('detects both-teams on back-to-back', async () => {
    cp.execFile = (_cmd, args, _opts, cb) => {
      const fn = typeof cb === 'function' ? cb : typeof _opts === 'function' ? _opts : null;
      const joined = Array.isArray(args) ? args.join(' ') : String(args);
      if (joined.includes('GameDate=2026-06-20')) {
        fn(
          null,
          scoreboardResponse('2026-06-20', [
            makeGame({ gameId: 'a', homeTeamName: 'Lakers', awayTeamName: 'Jazz' }),
            makeGame({ gameId: 'b', homeTeamName: 'Celtics', awayTeamName: 'Bulls' })
          ]),
          ''
        );
      } else {
        fn(null, scoreboardResponse('2026-06-21', []), '');
      }
    };
    const mod = require(MODULE_PATH);
    const result = await mod.getBasketballGameContext({
      gamePk: 'g3',
      sport: 'NBA',
      awayTeam: 'Celtics',
      homeTeam: 'Lakers',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.homeTeam.backToBack, true);
    assert.strictEqual(result.awayTeam.backToBack, true);
    assert.strictEqual(result.signals.awayBackToBack, true);
    assert.strictEqual(result.signals.homeBackToBack, true);
    // Both on b2b → low risk
    assert.strictEqual(result.riskFlag, 'low');
    assert.ok(result.riskSummary.includes('both teams on back-to-back'));
  });

  // ── WNBA ─────────────────────────────────────────────────────────────

  it('works for WNBA sport', async () => {
    cp.execFile = (_cmd, _args, _opts, cb) => {
      const fn = typeof cb === 'function' ? cb : typeof _opts === 'function' ? _opts : null;
      if (fn) fn(null, scoreboardResponse('2026-06-21', []), '');
    };
    const mod = require(MODULE_PATH);
    const result = await mod.getBasketballGameContext({
      gamePk: 'wnba1',
      sport: 'WNBA',
      awayTeam: 'Lynx',
      homeTeam: 'Liberty',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(result.sport, 'WNBA');
    assert.strictEqual(result.ok, true);
    assert.ok(typeof result.riskFlag === 'string');
  });

  // ── Validation errors ────────────────────────────────────────────────

  it('returns VALIDATION_ERROR when gameDate missing for NBA', async () => {
    const mod = require(MODULE_PATH);
    const result = await mod.getBasketballGameContext({
      gamePk: 'x',
      sport: 'NBA',
      awayTeam: 'A',
      homeTeam: 'B'
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'VALIDATION_ERROR');
  });

  it('returns VALIDATION_ERROR when team names missing for NBA', async () => {
    const mod = require(MODULE_PATH);
    const r1 = await mod.getBasketballGameContext({
      gamePk: 'x',
      sport: 'NBA',
      homeTeam: 'B',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(r1.error?.code, 'VALIDATION_ERROR');

    const r2 = await mod.getBasketballGameContext({
      gamePk: 'x',
      sport: 'NBA',
      awayTeam: 'A',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(r2.error?.code, 'VALIDATION_ERROR');
  });

  // ── Caching ──────────────────────────────────────────────────────────

  it('caches results for repeated calls with same params', async () => {
    let callCount = 0;
    cp.execFile = (_cmd, _args, _opts, cb) => {
      const fn = typeof cb === 'function' ? cb : typeof _opts === 'function' ? _opts : null;
      callCount++;
      if (fn) fn(null, scoreboardResponse('2026-06-21', []), '');
    };
    const mod = require(MODULE_PATH);
    const r1 = await mod.getBasketballGameContext({
      gamePk: 'cached1',
      sport: 'NBA',
      awayTeam: 'Celtics',
      homeTeam: 'Lakers',
      gameDate: '2026-06-21'
    });
    const firstCallCount = callCount;
    const r2 = await mod.getBasketballGameContext({
      gamePk: 'cached1',
      sport: 'NBA',
      awayTeam: 'Celtics',
      homeTeam: 'Lakers',
      gameDate: '2026-06-21'
    });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.cached, true);
    // Second call shouldn't have added any curl calls
    assert.strictEqual(callCount, firstCallCount);
  });

  // ── Unit helpers ─────────────────────────────────────────────────────

  it('parseScoreboardGames returns empty for null/invalid', () => {
    const { parseScoreboardGames } = require(MODULE_PATH);
    assert.deepStrictEqual(parseScoreboardGames(null), []);
    assert.deepStrictEqual(parseScoreboardGames({}), []);
    assert.deepStrictEqual(parseScoreboardGames({ scoreboard: {} }), []);
  });

  it('parseScoreboardGames parses a valid response', () => {
    const { parseScoreboardGames } = require(MODULE_PATH);
    const raw = JSON.parse(scoreboardResponse('2026-06-21', [makeGame({ gameId: 'g1' })]));
    const games = parseScoreboardGames(raw);
    assert.strictEqual(games.length, 1);
    assert.strictEqual(games[0].gameId, 'g1');
    assert.strictEqual(games[0].gameDate, '2026-06-21');
    assert.strictEqual(games[0].homeTeam.name, 'Lakers');
    assert.strictEqual(games[0].awayTeam.name, 'Celtics');
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
      { gameDate: '2026-06-20', homeTeam: { name: 'Celtics' }, awayTeam: { name: 'Bulls' } },
      { gameDate: '2026-06-21', homeTeam: { name: 'Celtics' }, awayTeam: { name: 'Lakers' } } // same date, skipped
    ];
    const result = findLastPlayedGame(games, 'Celtics', '2026-06-21');
    assert.strictEqual(result, '2026-06-20');
  });

  it('findLastPlayedGame returns null when no prior game exists', () => {
    const { findLastPlayedGame } = require(MODULE_PATH);
    const games = [{ gameDate: '2026-06-21', homeTeam: { name: 'Celtics' }, awayTeam: { name: 'Lakers' } }];
    assert.strictEqual(findLastPlayedGame(games, 'Celtics', '2026-06-21'), null);
  });

  it('resolveSport returns null for non-basketball sports', () => {
    const { resolveSport } = require(MODULE_PATH);
    assert.strictEqual(resolveSport('NCAAB'), null);
    assert.strictEqual(resolveSport('NCAA'), null);
    assert.strictEqual(resolveSport(''), null);
    assert.strictEqual(resolveSport(null), null);
  });

  it('resolveSport returns NBA/WNBA for matched input', () => {
    const { resolveSport } = require(MODULE_PATH);
    assert.strictEqual(resolveSport('NBA'), 'NBA');
    assert.strictEqual(resolveSport('nba'), 'NBA');
    assert.strictEqual(resolveSport('WNBA'), 'WNBA');
    assert.strictEqual(resolveSport('wnba'), 'WNBA');
  });
});
