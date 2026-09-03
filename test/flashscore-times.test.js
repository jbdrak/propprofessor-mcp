'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Write a test cache before tests, clean up after
const CACHE_DIR = path.join(__dirname, '..', 'lib', 'tennis-schedule-data');
const CACHE_PATH = path.join(CACHE_DIR, 'flashscore-cache.json');
const BACKUP_PATH = CACHE_PATH + '.test-backup';

const TEST_CACHE = {
  date: '2026-07-29',
  scrapedAt: '2026-07-29T20:00:00Z',
  source: 'flashscore',
  timezone: 'America/Chicago',
  totalMatches: 10,
  scheduled: 8,
  matches: [
    {
      id: 'abc123',
      time: '22:10',
      foundOn: '2026-07-30',
      status: 'scheduled',
      home: 'Shapovalov D.',
      away: 'Pacheco Mendez R.',
      tournament: 'Los Cabos',
      category: 'ATP - SINGLES',
      surface: 'hard'
    },
    {
      id: 'def456',
      time: '23:15',
      status: 'scheduled',
      home: 'Tomic B.',
      away: 'Khachanov K.',
      tournament: 'Los Cabos',
      category: 'ATP - SINGLES',
      surface: 'hard'
    },
    {
      id: 'ghi789',
      time: '22:05',
      status: 'scheduled',
      home: 'Dart H.',
      away: 'Dong E.',
      tournament: 'Vancouver',
      category: 'CHALLENGER WOMEN - SINGLES',
      surface: 'hard'
    },
    {
      id: 'multi001',
      time: '22:00',
      foundOn: '2026-07-30',
      status: 'scheduled',
      home: 'Leong M. W. K.',
      away: 'Palan D.',
      tournament: 'Test Open',
      category: 'WTA - SINGLES',
      surface: 'hard'
    },
    {
      id: 'multi002',
      time: '15:00',
      foundOn: '2026-07-31',
      status: 'scheduled',
      home: 'Halys Q.',
      away: 'Diaz Acosta F.',
      tournament: 'Test Open',
      category: 'ATP - SINGLES',
      surface: 'hard'
    },
    {
      id: 'multi003',
      time: '18:00',
      foundOn: '2026-07-31',
      status: 'scheduled',
      home: 'Swiatek I.',
      away: 'Wang Xiy.',
      tournament: 'Test Open',
      category: 'WTA - SINGLES',
      surface: 'clay'
    },
    {
      id: 'multi004',
      time: '22:00',
      foundOn: '2026-07-30',
      status: 'scheduled',
      home: 'Moriya H.',
      away: 'Dev S D P.',
      tournament: 'Test Open',
      category: 'WTA - SINGLES',
      surface: 'hard'
    },
    {
      id: 'multi005',
      time: '08:30',
      foundOn: '2026-07-31',
      status: 'scheduled',
      home: 'Bueno G.',
      away: 'Reis Da Silva J.',
      tournament: 'Test Open',
      category: 'WTA - SINGLES',
      surface: 'hard'
    },
    {
      id: 'jkl012',
      time: null,
      status: 'live',
      home: 'Cerundolo F.',
      away: 'Boyer T.',
      tournament: 'Los Cabos',
      category: 'ATP - SINGLES',
      surface: 'hard'
    },
    {
      id: 'mno345',
      time: null,
      status: 'finished',
      home: 'Svrcina D.',
      away: 'Walton A.',
      tournament: 'Los Cabos',
      category: 'ATP - SINGLES',
      surface: 'hard'
    }
  ]
};

describe('flashscore-times', () => {
  let mod;

  before(() => {
    // Backup existing cache
    if (fs.existsSync(CACHE_PATH)) {
      fs.copyFileSync(CACHE_PATH, BACKUP_PATH);
    }
    // Write test cache
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(TEST_CACHE));
    // Clear module cache to force reload
    delete require.cache[require.resolve('../lib/flashscore-times')];
    mod = require('../lib/flashscore-times');
  });

  after(() => {
    // Restore original cache
    if (fs.existsSync(BACKUP_PATH)) {
      fs.copyFileSync(BACKUP_PATH, CACHE_PATH);
      fs.unlinkSync(BACKUP_PATH);
    } else if (fs.existsSync(CACHE_PATH)) {
      fs.unlinkSync(CACHE_PATH);
    }
  });

  describe('normalizePlayer', () => {
    it('strips single initial', () => {
      assert.equal(mod.normalizePlayer('Shapovalov D.'), 'shapovalov');
    });

    it('strips multi-part initial', () => {
      assert.equal(mod.normalizePlayer('Alvarez Valdes L. C.'), 'alvarez valdes');
    });

    it('handles names without initials', () => {
      assert.equal(mod.normalizePlayer('Shapovalov'), 'shapovalov');
    });

    it('handles De Minaur prefix', () => {
      assert.equal(mod.normalizePlayer('De Minaur A.'), 'de minaur');
    });

    it('strips all trailing initials and normalizes hyphens', () => {
      assert.equal(mod.normalizePlayer('Leong M. W. K.'), 'leong');
      assert.equal(mod.normalizePlayer('Dev S D P.'), 'dev');
      assert.equal(mod.normalizePlayer('Diaz Acosta F.'), 'diaz acosta');
      assert.equal(mod.normalizePlayer('Auger-Aliassime F.'), 'auger aliassime');
      assert.equal(mod.normalizePlayer('Wang Xiy.'), 'wang');
    });

    it('returns empty for empty input', () => {
      assert.equal(mod.normalizePlayer(''), '');
      assert.equal(mod.normalizePlayer(null), '');
    });
  });

  describe('parsePPGame', () => {
    it('splits "Player1 vs Player2"', () => {
      assert.deepEqual(mod.parsePPGame('Shapovalov vs Pacheco Mendez'), ['Shapovalov', 'Pacheco Mendez']);
    });

    it('returns empty for non-vs string', () => {
      assert.deepEqual(mod.parsePPGame('Single Player'), []);
    });

    it('returns empty for null', () => {
      assert.deepEqual(mod.parsePPGame(null), []);
    });
  });

  describe('lookupMatchTime', () => {
    it('uses the match foundOn date when the cache spans multiple days', () => {
      const m = mod.lookupMatchTime('Shapovalov', 'Pacheco Mendez');
      assert.equal(m.date, '2026-07-30');
    });

    it('finds match by player names', () => {
      const m = mod.lookupMatchTime('Shapovalov', 'Pacheco Mendez');
      assert.ok(m, 'should find match');
      assert.equal(m.time, '22:10');
      assert.equal(m.tournament, 'Los Cabos');
      assert.equal(m.category, 'ATP - SINGLES');
    });

    it('finds match regardless of player order', () => {
      const m = mod.lookupMatchTime('Pacheco Mendez', 'Shapovalov');
      assert.ok(m, 'should find match regardless of order');
      assert.equal(m.time, '22:10');
    });

    it('matches abbreviated and hyphenated PP names', () => {
      assert.equal(mod.lookupMatchTime('Leong', 'Palan').time, '22:00');
      assert.equal(mod.lookupMatchTime('Halys', 'Diaz-Acosta').time, '15:00');
      assert.equal(mod.lookupMatchTime('Swiatek', 'Wang').time, '18:00');
      assert.equal(mod.lookupMatchTime('Moriya', 'Dev').time, '22:00');
      assert.equal(mod.lookupMatchTime('Bueno', 'Reis-Da-Silva').time, '08:30');
      assert.equal(mod.lookupMatchTime('Bueno', 'Reis Da Silva').time, '08:30');
    });

    it('handles initials in PP names', () => {
      const m = mod.lookupMatchTime('Dart H.', 'Dong E.');
      assert.ok(m, 'should find match with initials');
      assert.equal(m.time, '22:05');
    });

    it('returns null for unknown match', () => {
      const m = mod.lookupMatchTime('Djokovic', 'Alcaraz');
      assert.equal(m, null);
    });
  });

  describe('lookupFromPPRow', () => {
    it('uses homeTeam/awayTeam fields', () => {
      const row = { homeTeam: 'Shapovalov', awayTeam: 'Pacheco Mendez' };
      const m = mod.lookupFromPPRow(row);
      assert.ok(m);
      assert.equal(m.time, '22:10');
    });

    it('parses from game field when home/away are empty', () => {
      const row = { game: 'Tomic vs Khachanov', homeTeam: null, awayTeam: null };
      const m = mod.lookupFromPPRow(row);
      assert.ok(m);
      assert.equal(m.time, '23:15');
      assert.equal(m.tournament, 'Los Cabos');
    });

    it('tries the display matchup when PP team fields are stale', () => {
      const row = {
        homeTeam: 'Stale Home',
        awayTeam: 'Stale Away',
        game: 'Tomic vs Khachanov'
      };
      const m = mod.lookupFromPPRow(row);
      assert.ok(m);
      assert.equal(m.time, '23:15');
    });

    it('returns null for incomplete row', () => {
      assert.equal(mod.lookupFromPPRow({ homeTeam: '' }), null);
      assert.equal(mod.lookupFromPPRow(null), null);
    });
  });

  describe('getCacheInfo', () => {
    it('returns cache metadata', () => {
      const info = mod.getCacheInfo();
      assert.ok(info);
      assert.equal(info.date, '2026-07-29');
      assert.equal(info.totalMatches, 10);
      assert.equal(info.scheduled, 8);
      assert.equal(info.source, 'flashscore');
      assert.equal(info.timezone, 'America/Chicago');
    });
  });
});

describe('flashscoreTimeToISO', () => {
  // Import from propprofessor-tennis
  delete require.cache[require.resolve('../lib/propprofessor-tennis')];
  const { flashscoreTimeToISO } = require('../lib/propprofessor-tennis');

  it('converts "22:10" CDT to ISO', () => {
    const iso = flashscoreTimeToISO('22:10', '2026-07-29');
    assert.ok(iso);
    // 22:10 CDT (UTC-5) = 03:10 UTC next day
    assert.ok(iso.includes('T03:10'), `expected time in ISO: ${iso}`);
    assert.ok(iso.startsWith('2026-07-30'), `expected July 30 UTC: ${iso}`);
  });

  it('strips "FRO" suffix from time', () => {
    const iso = flashscoreTimeToISO('23:00FRO', '2026-07-29');
    assert.ok(iso);
    assert.ok(iso.includes('T04:00'), `expected 23:00 CDT -> 04:00 UTC: ${iso}`);
  });

  it('uses CST for winter dates', () => {
    const iso = flashscoreTimeToISO('10:00', '2026-01-15');
    assert.equal(iso, '2026-01-15T16:00:00.000Z');
  });

  it('returns null for invalid time', () => {
    assert.equal(flashscoreTimeToISO(null, '2026-07-29'), null);
    assert.equal(flashscoreTimeToISO('22:10', null), null);
    assert.equal(flashscoreTimeToISO('not-a-time', '2026-07-29'), null);
  });
});
