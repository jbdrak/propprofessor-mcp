'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const path = require('path');

const MODULE_PATH = path.resolve(__dirname, '../lib/propprofessor-basketball-game-context');
const { parseScoreboardGames, findLastPlayedGame, getBasketballGameContext } = require(MODULE_PATH);

// ── parseScoreboardGames: missing team fields ──────────────────────────────
describe('parseScoreboardGames — partial team objects', () => {
  it('handles games with missing home/away team fields via optional chaining', () => {
    const games = parseScoreboardGames({
      scoreboard: {
        gameDate: '2026-06-21',
        games: [
          { gameId: 'g1', homeTeam: { teamTricode: 'LAL' }, awayTeam: { teamName: 'Celtics' } },
          { gameId: 'g2', awayTeam: { teamNickname: 'Bulls' } },
          { gameId: 'g3', homeTeam: null, awayTeam: undefined }
        ]
      }
    });
    assert.equal(games.length, 3);
    assert.equal(games[0].homeTeam.tricode, 'LAL');
    assert.equal(games[0].homeTeam.name, '');
    assert.equal(games[0].awayTeam.name, 'Celtics');
    assert.equal(games[1].awayTeam.name, 'Bulls');
    assert.equal(games[2].homeTeam.name, '');
    assert.equal(games[2].awayTeam.name, '');
  });

  it('handles a game with no games array', () => {
    const games = parseScoreboardGames({ scoreboard: { gameDate: '2026-06-21' } });
    assert.deepEqual(games, []);
  });

  it('handles gameStatus/gameDateTimeUTC defaults', () => {
    const games = parseScoreboardGames({ scoreboard: { games: [{ gameId: 'x' }] } });
    assert.equal(games[0].gameStatus, 0);
    assert.equal(games[0].gameDateTimeUtc, '');
    assert.equal(games[0].gameStatusText, '');
  });
});

// ── leagueIdForSport is internal (not exported); skip direct test. ──────────

// ── findLastPlayedGame — empty / missing team ───────────────────────────────
describe('findLastPlayedGame — edge cases', () => {
  it('returns null for empty team name', () => {
    assert.equal(findLastPlayedGame([{ gameDate: '2026-06-20', homeTeam: { name: 'X' } }], '', '2026-06-21'), null);
  });

  it('matches on away team name case-insensitively', () => {
    const games = [{ gameDate: '2026-06-19', awayTeam: { name: 'Los Angeles Lakers' }, homeTeam: { name: 'Bulls' } }];
    assert.equal(findLastPlayedGame(games, 'Los Angeles Lakers', '2026-06-21'), '2026-06-19');
  });

  it('excludes games on the same date as the current game', () => {
    const games = [
      { gameDate: '2026-06-21', homeTeam: { name: 'Celtics' }, awayTeam: { name: 'Lakers' } },
      { gameDate: '2026-06-18', awayTeam: { name: 'Celtics' }, homeTeam: { name: 'Knicks' } }
    ];
    assert.equal(findLastPlayedGame(games, 'Celtics', '2026-06-21'), '2026-06-18');
  });
});

// ── getBasketballGameContext — risk composition branches ────────────────────
describe('getBasketballGameContext — risk composition branches', () => {
  function scoreboardResponse(gameDate, games) {
    return JSON.stringify({ scoreboard: { gameDate, leagueId: '00', games } });
  }
  function makeGame(homeName, awayName) {
    return {
      gameId: 'g',
      homeTeam: { teamId: 1, teamName: homeName, teamTricode: 'H', teamNickname: homeName, wins: 1, losses: 1 },
      awayTeam: { teamId: 2, teamName: awayName, teamTricode: 'A', teamNickname: awayName, wins: 1, losses: 1 }
    };
  }

  let originalExecFile;
  before(() => {
    originalExecFile = cp.execFile;
  });
  after(() => {
    if (originalExecFile) cp.execFile = originalExecFile;
  });

  const setupMock = (responsesByDate) => {
    cp.execFile = (_cmd, args, _opts, cb) => {
      const fn = typeof cb === 'function' ? cb : typeof _opts === 'function' ? _opts : null;
      const joined = Array.isArray(args) ? args.join(' ') : String(args);
      let body = scoreboardResponse('2026-06-21', []);
      for (const [date, games] of Object.entries(responsesByDate)) {
        if (joined.includes('GameDate=' + date)) body = scoreboardResponse(date, games);
      }
      if (fn) fn(null, body, '');
    };
  };

  it('flags low risk with rest disparity >= 2 but only one team on b2b', async () => {
    setupMock({
      '2026-06-20': [makeGame('Lakers', 'Jazz')],
      '2026-06-18': [makeGame('Knicks', 'Celtics')]
    });
    const result = await getBasketballGameContext({
      gamePk: 'g2',
      sport: 'NBA',
      awayTeam: 'Celtics',
      homeTeam: 'Lakers',
      gameDate: '2026-06-21'
    });
    assert.equal(result.ok, true);
    assert.equal(result.homeTeam.backToBack, true);
    assert.equal(result.awayTeam.backToBack, false);
    assert.equal(result.signals.restDisparity, 2);
    assert.equal(result.riskFlag, 'low');
    assert.ok(result.riskSummary.includes('more days rest'));
  });

  it('returns API_ERROR when gameDate is malformed (fetchSchedule throws)', async () => {
    const result = await getBasketballGameContext({
      gamePk: 'x',
      sport: 'NBA',
      awayTeam: 'A',
      homeTeam: 'B',
      gameDate: 'not-a-date'
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'API_ERROR');
  });

  it('omits rest disparity reason when only one team has rest data', async () => {
    // Use unique teams + a date no other test caches so the schedule cache
    // can't leak a prior game for the "no rest" team.
    setupMock({ '2026-07-14': [makeGame('Suns', 'Jazz')] });
    const result = await getBasketballGameContext({
      gamePk: 'g-uniquerestdiff',
      sport: 'NBA',
      awayTeam: 'Clippers',
      homeTeam: 'Suns',
      gameDate: '2026-07-15'
    });
    assert.equal(result.awayTeam.restDays, null);
    assert.equal(result.homeTeam.restDays, 1);
    assert.equal(result.signals.restDisparity, null);
    assert.equal(result.riskFlag, 'low');
  });
});
