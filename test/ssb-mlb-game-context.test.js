'use strict';

const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');

const MODULE_PATH = '../lib/ssb-mlb-game-context';

const originalExecFile = cp.execFile;

// The test file imports at the top once, but the in-memory caches inside
// the module persist across tests. Re-require the module inside each test
// (or after clearing cp.execFile mocks) to get a fresh module with empty
// caches. Mirrors the pattern in ssb-player-context.test.js.
function clearModuleCache() {
  delete require.cache[require.resolve(MODULE_PATH)];
}

function loadModule() {
  return require(MODULE_PATH);
}

/**
 * Mock cp.execFile to return canned responses for known URLs. Routes by URL
 * substring — schedule / venue / boxscore / open-meteo — so a single mock
 * can serve an entire getMlbGameContext call.
 */
function mockCurl(routes) {
  cp.execFile = (file, args, arg3, arg4) => {
    const cb = typeof arg3 === 'function' ? arg3 : arg4;
    const argStr = Array.isArray(args) ? args.join(' ') : '';
    for (const { match, body, status } of routes) {
      if (argStr.includes(match)) {
        if (status && status >= 400) {
          return cb(Object.assign(new Error(`HTTP ${status}`), { code: status }));
        }
        return cb(null, body, '');
      }
    }
    return cb(Object.assign(new Error('unmocked url: ' + argStr.slice(0, 200)), { code: 500 }));
  };
}

function restoreCurl() {
  cp.execFile = originalExecFile;
}

describe('ssb-mlb-game-context', () => {
  after(() => {
    restoreCurl();
  });

  beforeEach(() => {
    // Each test gets a fresh module instance so caches don't leak. Also
    // restore curl between tests so a test that didn't restore doesn't
    // poison the next one.
    clearModuleCache();
    restoreCurl();
  });

  describe('getParkFactor', () => {
    it('returns the Dodger Stadium entry with the right shape', () => {
      const { getParkFactor } = loadModule();
      const pf = getParkFactor(22);
      assert.equal(pf.name, 'Dodger Stadium');
      assert.ok(typeof pf.runFactor === 'number');
      assert.equal(pf.azimuth, 26);
    });

    it('flags Coors Field as an extreme hitter park', () => {
      const { getParkFactor } = loadModule();
      const pf = getParkFactor(21);
      assert.ok(pf.runFactor >= 1.15, `expected Coors PF >= 1.15, got ${pf.runFactor}`);
    });

    it('flags Oracle Park as a strong pitcher park', () => {
      const { getParkFactor } = loadModule();
      const pf = getParkFactor(18);
      assert.ok(pf.runFactor < 0.95, `expected Oracle PF < 0.95, got ${pf.runFactor}`);
    });

    it('returns the neutral fallback for unknown venues', () => {
      const { getParkFactor } = loadModule();
      const pf = getParkFactor(99999);
      assert.equal(pf.name, 'Unknown Park');
      assert.equal(pf.runFactor, 1.0);
      assert.equal(pf.azimuth, null);
    });

    it('curated table covers all 30 current MLB parks (or a documented subset)', () => {
      const { PARK_FACTORS } = loadModule();
      assert.ok(
        Object.keys(PARK_FACTORS).length >= 25,
        `expected at least 25 parks in table, got ${Object.keys(PARK_FACTORS).length}`
      );
    });
  });

  describe('assessGameContextRisk (pure logic)', () => {
    it('returns clean riskFlag when no weather and a neutral park', () => {
      const { assessGameContextRisk } = loadModule();
      const result = assessGameContextRisk({
        weather: null,
        park: { name: 'Test Park', runFactor: 1.0, azimuth: null },
        game: { teams: { away: { probablePitcher: { fullName: 'A' } }, home: { probablePitcher: { fullName: 'B' } } } },
        boxscore: null
      });
      assert.equal(result.riskFlag, 'clean');
      assert.equal(result.riskSummary, null);
      assert.equal(result.signals.awayPitcher, 'A');
      assert.equal(result.signals.homePitcher, 'B');
    });

    it('escalates to high when strong wind blows out at a hitter park (Coors)', () => {
      const { assessGameContextRisk } = loadModule();
      const result = assessGameContextRisk({
        weather: {
          windSpeedKmh: 32,
          windDirectionDeg: 30,
          temperatureC: 20,
          precipProbPct: 5,
          hour: '2026-06-17T19:00'
        },
        park: { name: 'Coors Field', runFactor: 1.18, azimuth: 30 },
        game: { teams: { away: { probablePitcher: { fullName: 'A' } }, home: { probablePitcher: { fullName: 'B' } } } },
        boxscore: null
      });
      assert.equal(result.riskFlag, 'high');
      assert.ok(result.riskSummary.includes('strong wind'));
    });

    it('does NOT escalate to high when moderate wind blows out at a pitcher park', () => {
      const { assessGameContextRisk } = loadModule();
      const result = assessGameContextRisk({
        weather: {
          windSpeedKmh: 21,
          windDirectionDeg: 26,
          temperatureC: 18,
          precipProbPct: 0,
          hour: '2026-06-17T19:00'
        },
        park: { name: 'Dodger Stadium', runFactor: 0.96, azimuth: 26 },
        game: { teams: { away: { probablePitcher: { fullName: 'A' } }, home: { probablePitcher: { fullName: 'B' } } } },
        boxscore: null
      });
      // 21 km/h * 0.621 = 13 mph. < 15 mph → moderate-help-hitters, not strong.
      // But the runFactor is 0.96 (pitcher park), so it stays at 'low' or 'clean'.
      assert.ok(
        ['low', 'clean'].includes(result.riskFlag),
        `expected low/clean, got ${result.riskFlag}: ${result.riskSummary}`
      );
    });

    it('flags high precip probability as a risk', () => {
      const { assessGameContextRisk } = loadModule();
      const result = assessGameContextRisk({
        weather: {
          windSpeedKmh: 5,
          windDirectionDeg: 180,
          temperatureC: 15,
          precipProbPct: 80,
          hour: '2026-06-17T19:00'
        },
        park: { name: 'Wrigley Field', runFactor: 1.04, azimuth: 30 },
        game: { teams: { away: { probablePitcher: { fullName: 'A' } }, home: { probablePitcher: { fullName: 'B' } } } },
        boxscore: null
      });
      assert.equal(result.riskFlag, 'high');
      assert.ok(result.riskSummary.includes('precipitation'));
    });

    it('marks pitchers as confirmed when boxscore has pitcher lists', () => {
      const { assessGameContextRisk } = loadModule();
      const result = assessGameContextRisk({
        weather: null,
        park: { name: 'Test Park', runFactor: 1.0, azimuth: null },
        game: { teams: { away: { probablePitcher: { fullName: 'A' } }, home: { probablePitcher: { fullName: 'B' } } } },
        boxscore: {
          teams: {
            away: { pitchers: ['p1'], battingOrder: Array(9).fill('p') },
            home: { pitchers: ['p2'], battingOrder: Array(9).fill('p') }
          }
        }
      });
      assert.equal(result.signals.lineupStatus, 'locked');
    });

    it('marks lineups as pending when boxscore has no battingOrder', () => {
      const { assessGameContextRisk } = loadModule();
      const result = assessGameContextRisk({
        weather: null,
        park: { name: 'Test Park', runFactor: 1.0, azimuth: null },
        game: { teams: { away: { probablePitcher: { fullName: 'A' } }, home: { probablePitcher: { fullName: 'B' } } } },
        boxscore: null
      });
      assert.equal(result.signals.lineupStatus, 'pending');
    });

    it('handles TBD pitchers (one or both missing)', () => {
      const { assessGameContextRisk } = loadModule();
      const result = assessGameContextRisk({
        weather: null,
        park: { name: 'Test Park', runFactor: 1.0, azimuth: null },
        game: { teams: { away: {}, home: { probablePitcher: { fullName: 'B' } } } },
        boxscore: null
      });
      assert.equal(result.signals.awayPitcher, null);
      assert.equal(result.signals.homePitcher, 'B');
    });
  });

  describe('getMlbGameContext (integration with mocked curl)', () => {
    it('returns full context for a known gamePk', async () => {
      const { getMlbGameContext } = loadModule();
      const scheduleBody = JSON.stringify({
        dates: [
          {
            date: '2026-06-17',
            games: [
              {
                gamePk: 824503,
                gameDate: '2026-06-17T17:05:00Z',
                officialDate: '2026-06-17',
                venue: { id: 22, name: 'Dodger Stadium' },
                teams: {
                  away: { team: { id: 121, name: 'Mets' }, probablePitcher: { id: 1, fullName: 'Test Away SP' } },
                  home: { team: { id: 113, name: 'Reds' }, probablePitcher: { id: 2, fullName: 'Test Home SP' } }
                }
              }
            ]
          }
        ]
      });
      const venueBody = JSON.stringify({
        venues: [
          {
            id: 22,
            name: 'Dodger Stadium',
            location: { defaultCoordinates: { latitude: 34.07, longitude: -118.24 } }
          }
        ]
      });
      const weatherBody = JSON.stringify({
        hourly: {
          time: ['2026-06-17T17:00', '2026-06-17T18:00'],
          wind_speed_10m: [5, 8],
          wind_direction_10m: [200, 220],
          temperature_2m: [22, 24],
          precipitation_probability: [5, 10]
        }
      });
      const boxscoreBody = JSON.stringify({
        teams: {
          away: { pitchers: ['p1'], battingOrder: Array(9).fill('p') },
          home: { pitchers: ['p2'], battingOrder: Array(9).fill('p') }
        }
      });

      mockCurl([
        { match: 'gamePk=824503', body: scheduleBody },
        { match: '/venues/22', body: venueBody },
        { match: 'open-meteo.com', body: weatherBody },
        { match: '/game/824503/boxscore', body: boxscoreBody }
      ]);

      const result = await getMlbGameContext({ gamePk: '824503' });
      assert.equal(result.ok, true);
      assert.equal(result.gamePk, '824503');
      assert.deepEqual(result.pitchers, { away: 'Test Away SP', home: 'Test Home SP' });
      assert.equal(result.park.runFactor, 0.96);
      assert.equal(result.park.azimuth, 26);
      assert.equal(result.weather.windSpeedKmh, 5);
      assert.equal(result.lineups.status, 'locked');
      assert.equal(result.riskFlag, 'clean'); // 5 km/h = 3 mph, no flags
      assert.ok(result.cached === false);
    });

    it('returns VALIDATION_ERROR when gamePk is missing', async () => {
      const { getMlbGameContext } = loadModule();
      const result = await getMlbGameContext({});
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'VALIDATION_ERROR');
    });

    it('returns NOT_FOUND when the game does not exist', async () => {
      const { getMlbGameContext } = loadModule();
      mockCurl([{ match: 'gamePk=999999', body: JSON.stringify({ dates: [] }) }]);
      const result = await getMlbGameContext({ gamePk: '999999' });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'NOT_FOUND');
    });

    it('handles missing weather gracefully (no coords → no weather block)', async () => {
      const { getMlbGameContext } = loadModule();
      const scheduleBody = JSON.stringify({
        dates: [
          {
            date: '2026-06-17',
            games: [
              {
                gamePk: 555555,
                gameDate: '2026-06-17T17:05:00Z',
                officialDate: '2026-06-17',
                venue: { id: 99999, name: 'Neutral Site' },
                teams: {
                  away: { team: { id: 121, name: 'Mets' }, probablePitcher: { id: 1, fullName: 'A' } },
                  home: { team: { id: 113, name: 'Reds' }, probablePitcher: { id: 2, fullName: 'B' } }
                }
              }
            ]
          }
        ]
      });
      mockCurl([
        { match: 'gamePk=555555', body: scheduleBody },
        { match: '/venues/99999', body: JSON.stringify({ venues: [{ id: 99999, name: 'Neutral Site' }] }) },
        { match: '/game/555555/boxscore', body: JSON.stringify({ teams: { away: {}, home: {} } }) }
      ]);
      const result = await getMlbGameContext({ gamePk: '555555' });
      assert.equal(result.ok, true);
      assert.equal(result.weather, null);
      assert.equal(result.park.runFactor, 1.0); // Neutral fallback
      assert.equal(result.riskFlag, 'clean');
    });

    it('caches results on repeated calls', async () => {
      const { getMlbGameContext } = loadModule();
      const scheduleBody = JSON.stringify({
        dates: [
          {
            date: '2026-06-17',
            games: [
              {
                gamePk: 111111,
                gameDate: '2026-06-17T17:05:00Z',
                officialDate: '2026-06-17',
                venue: { id: 22, name: 'Dodger Stadium' },
                teams: {
                  away: { team: { id: 121 }, probablePitcher: { id: 1, fullName: 'A' } },
                  home: { team: { id: 113 }, probablePitcher: { id: 2, fullName: 'B' } }
                }
              }
            ]
          }
        ]
      });
      cp.execFile = (file, args, arg3, arg4) => {
        const cb = typeof arg3 === 'function' ? arg3 : arg4;
        const argStr = Array.isArray(args) ? args.join(' ') : '';
        if (argStr.includes('gamePk=111111')) return cb(null, scheduleBody, '');
        if (argStr.includes('/venues/22')) {
          return cb(
            null,
            JSON.stringify({
              venues: [
                {
                  id: 22,
                  name: 'Dodger Stadium',
                  location: { defaultCoordinates: { latitude: 34.07, longitude: -118.24 } }
                }
              ]
            }),
            ''
          );
        }
        if (argStr.includes('open-meteo.com')) {
          return cb(
            null,
            JSON.stringify({
              hourly: {
                time: ['2026-06-17T17:00'],
                wind_speed_10m: [5],
                wind_direction_10m: [200],
                temperature_2m: [22],
                precipitation_probability: [5]
              }
            }),
            ''
          );
        }
        if (argStr.includes('/game/111111/boxscore')) {
          return cb(null, JSON.stringify({ teams: { away: {}, home: {} } }), '');
        }
        cb(new Error('unmocked'));
      };

      const r1 = await getMlbGameContext({ gamePk: '111111' });
      const r2 = await getMlbGameContext({ gamePk: '111111' });
      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      assert.equal(r2.cached, true);
    });
  });

  describe('findMlbGamePk (validate_play integration helper)', () => {
    it('resolves a screen-format gameId to the real MLB gamePk', async () => {
      const { findMlbGamePk } = loadModule();
      const scheduleBody = JSON.stringify({
        dates: [
          {
            date: '2026-06-17',
            games: [
              {
                gamePk: 111111,
                teams: { away: { team: { name: 'Tampa Bay Rays' } }, home: { team: { name: 'Los Angeles Dodgers' } } }
              },
              {
                gamePk: 222222,
                teams: { away: { team: { name: 'New York Mets' } }, home: { team: { name: 'Cincinnati Reds' } } }
              }
            ]
          }
        ]
      });
      mockCurl([{ match: 'date=2026-06-17', body: scheduleBody }]);
      const result = await findMlbGamePk({
        isoDate: '2026-06-17',
        awayTeam: 'Tampa Bay Rays',
        homeTeam: 'Los Angeles Dodgers'
      });
      assert.equal(result, '111111');
    });

    it('returns null when no matching game is on the date', async () => {
      const { findMlbGamePk } = loadModule();
      const scheduleBody = JSON.stringify({ dates: [{ date: '2026-06-17', games: [] }] });
      mockCurl([{ match: 'date=2026-06-17', body: scheduleBody }]);
      const result = await findMlbGamePk({
        isoDate: '2026-06-17',
        awayTeam: 'Tampa Bay Rays',
        homeTeam: 'Los Angeles Dodgers'
      });
      assert.equal(result, null);
    });

    it('resolves the correct gamePk in a doubleheader using unix timestamp', async () => {
      const { findMlbGamePk } = loadModule();
      const scheduleBody = JSON.stringify({
        dates: [
          {
            date: '2026-06-17',
            games: [
              {
                gamePk: 111111,
                gameDate: '2026-06-17T17:10:00Z',
                teams: { away: { team: { name: 'Tampa Bay Rays' } }, home: { team: { name: 'Los Angeles Dodgers' } } }
              },
              {
                gamePk: 222222,
                gameDate: '2026-06-18T00:10:00Z',
                teams: { away: { team: { name: 'Tampa Bay Rays' } }, home: { team: { name: 'Los Angeles Dodgers' } } }
              }
            ]
          }
        ]
      });
      mockCurl([{ match: 'date=2026-06-17', body: scheduleBody }]);
      // Unix 1781716200 = 2026-06-17T17:10:00Z → should pick game 111111
      const result = await findMlbGamePk({
        isoDate: '2026-06-17',
        awayTeam: 'Tampa Bay Rays',
        homeTeam: 'Los Angeles Dodgers',
        unixStart: 1781716200
      });
      assert.equal(result, '111111');
    });

    it('picks first game when no unixStart provided even with multiple matches', async () => {
      const { findMlbGamePk } = loadModule();
      const scheduleBody = JSON.stringify({
        dates: [
          {
            date: '2026-06-17',
            games: [
              {
                gamePk: 111111,
                gameDate: '2026-06-17T17:10:00Z',
                teams: { away: { team: { name: 'Tampa Bay Rays' } }, home: { team: { name: 'Los Angeles Dodgers' } } }
              },
              {
                gamePk: 222222,
                gameDate: '2026-06-18T00:10:00Z',
                teams: { away: { team: { name: 'Tampa Bay Rays' } }, home: { team: { name: 'Los Angeles Dodgers' } } }
              }
            ]
          }
        ]
      });
      mockCurl([{ match: 'date=2026-06-17', body: scheduleBody }]);
      const result = await findMlbGamePk({
        isoDate: '2026-06-17',
        awayTeam: 'Tampa Bay Rays',
        homeTeam: 'Los Angeles Dodgers'
      });
      assert.equal(result, '111111');
    });

    it('matches team names case-insensitively with surrounding whitespace trimmed', async () => {
      const { findMlbGamePk } = loadModule();
      const scheduleBody = JSON.stringify({
        dates: [
          {
            date: '2026-06-17',
            games: [
              {
                gamePk: 333333,
                teams: { away: { team: { name: 'Tampa Bay Rays' } }, home: { team: { name: 'Los Angeles Dodgers' } } }
              }
            ]
          }
        ]
      });
      mockCurl([{ match: 'date=2026-06-17', body: scheduleBody }]);
      const result = await findMlbGamePk({
        isoDate: '2026-06-17',
        awayTeam: '  tampa bay rays ',
        homeTeam: 'los angeles dodgers  '
      });
      assert.equal(result, '333333');
    });

    it('rejects bad inputs gracefully', async () => {
      const { findMlbGamePk } = loadModule();
      const bad1 = await findMlbGamePk({ isoDate: '20260617', awayTeam: 'A', homeTeam: 'B' });
      assert.equal(bad1, null);
      const bad2 = await findMlbGamePk({ isoDate: '2026-06-17', awayTeam: '', homeTeam: 'B' });
      assert.equal(bad2, null);
      const bad3 = await findMlbGamePk({});
      assert.equal(bad3, null);
    });

    it('resolves gamePk when awayTeam/homeTeam are flipped (vs-format ambiguity)', async () => {
      const { findMlbGamePk } = loadModule();
      // Schedule has Phillies as home, Nationals as away.
      // Caller passes awayTeam="Philadelphia Phillies" (should be home)
      // and homeTeam="Washington Nationals" (should be away) — simulating
      // a "vs"-separated game string where ordering is unreliable.
      const scheduleBody = JSON.stringify({
        dates: [
          {
            date: '2026-06-25',
            games: [
              {
                gamePk: 745123,
                gameDate: '2026-06-25T22:45:00Z',
                teams: {
                  away: { team: { name: 'Washington Nationals' } },
                  home: { team: { name: 'Philadelphia Phillies' } }
                }
              }
            ]
          }
        ]
      });
      mockCurl([{ match: 'date=2026-06-25', body: scheduleBody }]);
      const result = await findMlbGamePk({
        isoDate: '2026-06-25',
        awayTeam: 'Philadelphia Phillies', // Actually home in the schedule
        homeTeam: 'Washington Nationals' // Actually away in the schedule
      });
      assert.equal(result, '745123');
    });
  });
});
