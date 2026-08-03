'use strict';

/**
 * Regression tests for tennis time-source trust semantics.
 *
 * Rules under test (plan Task 2):
 *  - A fresh, valid Flashscore cache is authoritative: found scheduled
 *    matches stay labeled `flashscore` / `flashscore-verified`.
 *  - A fresh, valid Flashscore cache that omits a PP match must NOT let the
 *    ESPN fallback upgrade the row to `espn` / `espn-verified`; the row stays
 *    unresolved (`pp-mcp (unverified)`).
 *  - When the Flashscore cache is missing, malformed, or stale, the ESPN
 *    fallback may populate a time but must be clearly labeled
 *    fallback/unverified.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT = path.resolve(__dirname, '..');
const CACHE_PATH = path.join(PROJECT, 'lib', 'tennis-schedule-data', 'flashscore-cache.json');
const BACKUP_PATH = CACHE_PATH + '.test-backup';
const FS_MODULE = path.join(PROJECT, 'lib', 'flashscore-times.js');
const TENNIS_MODULE = path.join(PROJECT, 'lib', 'propprofessor-tennis.js');

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

// ── fixtures ────────────────────────────────────────────────────────

function cacheFile(scrapedAtIso, matches) {
  return {
    date: '2026-07-30',
    scrapedAt: scrapedAtIso,
    source: 'flashscore',
    timezone: 'America/Chicago',
    totalMatches: matches.length,
    scheduled: matches.filter((m) => m.status === 'scheduled').length,
    matches
  };
}

const FRESH_SCHEDULED_MATCH = {
  id: 'fs-1',
  time: '22:10',
  status: 'scheduled',
  home: 'Shapovalov D.',
  away: 'Pacheco Mendez R.',
  tournament: 'Los Cabos',
  category: 'ATP - SINGLES',
  surface: 'hard'
};

// PP row whose match is NOT in the fresh cache fixture (omission case).
function omittedRow() {
  return {
    homeTeam: 'Djokovic',
    awayTeam: 'Alcaraz',
    game: 'Djokovic vs Alcaraz',
    start: '2026-07-30T17:00:00.000Z',
    league: 'Tennis',
    market: 'Moneyline'
  };
}

function espnScoreboard(matches) {
  return {
    events: (matches || []).map((m) => ({
      groupings: [
        {
          competitions: [
            {
              competitors: [{ athlete: { displayName: m.player1 } }, { athlete: { displayName: m.player2 } }],
              date: m.start,
              status: { type: { description: m.status || 'Scheduled' } },
              venue: { fullName: m.venue || 'Stadium' }
            }
          ]
        }
      ]
    }))
  };
}

// ESPN knows this match at a DIFFERENT time than the PP row — a real
// "upgrade" candidate if the fallback ran.
const ESPN_DJOKOVIC_ALCARAZ = {
  player1: 'Novak Djokovic',
  player2: 'Carlos Alcaraz',
  start: '2026-07-30T19:00:00.000Z',
  status: 'Scheduled'
};

// ── harness ─────────────────────────────────────────────────────────

const ORIGINAL_FETCH = globalThis.fetch;

function stubEspn(atpMatches) {
  globalThis.fetch = async (url) => {
    const circuit = String(url).includes('/wta/') ? 'wta' : 'atp';
    return {
      ok: true,
      json: async () => (circuit === 'wta' ? espnScoreboard([]) : espnScoreboard(atpMatches))
    };
  };
}

function restoreFetch() {
  globalThis.fetch = ORIGINAL_FETCH;
}

function reloadModules() {
  delete require.cache[require.resolve(FS_MODULE)];
  delete require.cache[require.resolve(TENNIS_MODULE)];
  return require(TENNIS_MODULE);
}

function writeCache(data) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data));
}

async function correct(rows, espnMatches) {
  stubEspn(espnMatches);
  const tennis = reloadModules();
  return tennis.correctTennisTimes(rows);
}

// ── tests ───────────────────────────────────────────────────────────

describe('tennis time-source trust', () => {
  before(() => {
    if (fs.existsSync(CACHE_PATH)) {
      fs.copyFileSync(CACHE_PATH, BACKUP_PATH);
    }
    if (!fs.existsSync(path.dirname(CACHE_PATH))) {
      fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    }
  });

  beforeEach(restoreFetch);

  after(() => {
    restoreFetch();
    if (fs.existsSync(BACKUP_PATH)) {
      fs.copyFileSync(BACKUP_PATH, CACHE_PATH);
      fs.unlinkSync(BACKUP_PATH);
    } else if (fs.existsSync(CACHE_PATH)) {
      fs.unlinkSync(CACHE_PATH);
    }
  });

  describe('fresh valid Flashscore cache', () => {
    const fresh = cacheFile(new Date(NOW - 60_000).toISOString(), [FRESH_SCHEDULED_MATCH]);

    it('keeps Flashscore correction authoritative when the match is found', async () => {
      writeCache(fresh);
      const rows = [
        {
          homeTeam: 'Shapovalov',
          awayTeam: 'Pacheco Mendez',
          game: 'Shapovalov vs Pacheco Mendez',
          start: '2026-07-30T18:00:00.000Z',
          league: 'Tennis',
          market: 'Moneyline'
        }
      ];
      await correct(rows, []);
      assert.equal(rows[0].startSource, 'flashscore');
      assert.equal(rows[0].start, '2026-07-31T03:10:00.000Z'); // 22:10 CDT
      assert.equal(rows[0].startCorrected, true);
    });

    it('keeps flashscore-verified when the existing time already matches', async () => {
      writeCache(fresh);
      const rows = [
        {
          homeTeam: 'Shapovalov',
          awayTeam: 'Pacheco Mendez',
          game: 'Shapovalov vs Pacheco Mendez',
          start: '2026-07-31T03:10:00.000Z', // already equals 22:10 CDT
          league: 'Tennis',
          market: 'Moneyline'
        }
      ];
      await correct(rows, []);
      assert.equal(rows[0].startSource, 'flashscore-verified');
      assert.equal(rows[0].start, '2026-07-31T03:10:00.000Z');
    });

    it('does not let ESPN upgrade a row omitted from the fresh cache', async () => {
      writeCache(fresh);
      const rows = [omittedRow()];
      await correct(rows, [ESPN_DJOKOVIC_ALCARAZ]);
      assert.equal(rows[0].startSource, 'pp-mcp (unverified)');
      assert.notEqual(rows[0].startSource, 'espn');
      assert.notEqual(rows[0].startSource, 'espn-verified');
      assert.equal(rows[0].start, '2026-07-30T17:00:00.000Z');
      assert.equal(rows[0].startCorrected, undefined);
    });

    it('does not let ESPN upgrade when Flashscore has the match but its time is unparsable', async () => {
      writeCache(
        cacheFile(new Date(NOW - 60_000).toISOString(), [
          {
            id: 'fs-2',
            time: 'TBD',
            status: 'scheduled',
            home: 'Djokovic N.',
            away: 'Alcaraz C.',
            tournament: 'Washington',
            category: 'ATP - SINGLES',
            surface: 'hard'
          }
        ])
      );
      const rows = [omittedRow()];
      await correct(rows, [ESPN_DJOKOVIC_ALCARAZ]);
      assert.equal(rows[0].startSource, 'flashscore (time unparsed)');
      assert.equal(rows[0].start, '2026-07-30T17:00:00.000Z');
      assert.equal(rows[0].startCorrected, undefined);
    });
  });

  describe('ESPN fallback when Flashscore cache is unavailable or stale', () => {
    it('labels ESPN fallback clearly when the cache file is missing', async () => {
      fs.rmSync(CACHE_PATH, { force: true });
      const rows = [omittedRow()];
      await correct(rows, [ESPN_DJOKOVIC_ALCARAZ]);
      assert.equal(rows[0].startSource, 'espn (fallback, unverified)');
      assert.equal(rows[0].start, '2026-07-30T19:00:00.000Z');
      assert.equal(rows[0].startCorrected, true);
    });

    it('labels ESPN fallback clearly when the cache file is malformed', async () => {
      fs.writeFileSync(CACHE_PATH, '{"matches": [truncated');
      const rows = [omittedRow()];
      await correct(rows, [ESPN_DJOKOVIC_ALCARAZ]);
      assert.equal(rows[0].startSource, 'espn (fallback, unverified)');
      assert.equal(rows[0].start, '2026-07-30T19:00:00.000Z');
      assert.equal(rows[0].startCorrected, true);
    });

    it('labels ESPN fallback clearly when the cache is stale', async () => {
      writeCache(cacheFile(new Date(NOW - 7 * HOUR).toISOString(), [FRESH_SCHEDULED_MATCH]));
      const rows = [omittedRow()];
      await correct(rows, [ESPN_DJOKOVIC_ALCARAZ]);
      assert.equal(rows[0].startSource, 'espn (fallback, unverified)');
      assert.equal(rows[0].start, '2026-07-30T19:00:00.000Z');
      assert.equal(rows[0].startCorrected, true);
    });

    it('labels an already-matching ESPN time as fallback/unverified when the cache is stale', async () => {
      writeCache(cacheFile(new Date(NOW - 7 * HOUR).toISOString(), [FRESH_SCHEDULED_MATCH]));
      const rows = [
        {
          homeTeam: 'Djokovic',
          awayTeam: 'Alcaraz',
          game: 'Djokovic vs Alcaraz',
          start: '2026-07-30T19:00:00.000Z', // already equals the ESPN time
          league: 'Tennis',
          market: 'Moneyline'
        }
      ];
      await correct(rows, [ESPN_DJOKOVIC_ALCARAZ]);
      assert.equal(rows[0].startSource, 'espn-verified (fallback, unverified)');
      assert.equal(rows[0].start, '2026-07-30T19:00:00.000Z');
    });
  });
});
