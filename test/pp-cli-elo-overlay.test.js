'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { enrichScanElo, americanToProb, resolvePoolKey, matchSelectionSide } = require('../lib/propprofessor-elo-overlay');

// ── fixtures ────────────────────────────────────────────────────

// Data-format snapshot (the shape loadSnapshot produces). ATP pool only —
// WTA empty, mirroring the real snapshot as of 2026-08-14.
const FIXTURE_SNAPSHOT = {
  schemaVersion: 1,
  modelVersion: 'tennis-elo-1.1.0',
  manifest: {
    asOf: '2026-08-14',
    importedAt: '2026-08-14T00:00:00Z',
    matchCount: 12,
    playerCount: 4,
    sourceUrl: null,
    license: 'fixture',
    sourcePath: 'fixture'
  },
  players: {
    ATP: {
      'CRISTINA BUCSA': {
        name: 'Cristina Bucsa',
        overall: 1750,
        surfaces: {
          hard: { rating: 1800, matches: 20 },
          clay: { rating: 1700, matches: 30 },
          grass: { rating: 1650, matches: 5 }
        },
        totalMatches: 60,
        lastMatchDate: '2026-08-10'
      },
      'MAJA CHWALINSKA': {
        name: 'Maja Chwalinska',
        overall: 1600,
        surfaces: {
          hard: { rating: 1500, matches: 8 },
          clay: { rating: 1700, matches: 40 },
          grass: { rating: 1550, matches: 4 }
        },
        totalMatches: 55,
        lastMatchDate: '2026-08-11'
      },
      'NOVAK DJOKOVIC': {
        name: 'Novak Djokovic',
        overall: 2295,
        surfaces: {
          hard: { rating: 2230, matches: 649 },
          clay: { rating: 2100, matches: 100 },
          grass: { rating: 2200, matches: 80 }
        },
        totalMatches: 700,
        lastMatchDate: '2026-07-12'
      },
      'THIAGO AGUSTIN TIRANTE': {
        name: 'Thiago Agustin Tirante',
        overall: 1958,
        surfaces: {
          hard: { rating: 1745, matches: 91 },
          clay: { rating: 2000, matches: 120 },
          grass: { rating: 1800, matches: 20 }
        },
        totalMatches: 150,
        lastMatchDate: '2026-08-13'
      },
      // Ambiguity fixtures: three Harrises, Lloyd clearly most active.
      'LLOYD HARRIS': { name: 'Lloyd Harris', overall: 1811, surfaces: { hard: { rating: 1781, matches: 323 }, clay: { rating: 1600, matches: 30 }, grass: { rating: 1700, matches: 40 } }, totalMatches: 400, lastMatchDate: '2026-08-14' },
      'ANDREW HARRIS': { name: 'Andrew Harris', overall: 1556, surfaces: { hard: { rating: 1556, matches: 118 }, clay: { rating: 1500, matches: 10 }, grass: { rating: 1500, matches: 5 } }, totalMatches: 130, lastMatchDate: '2026-06-01' },
      'RYAN HARRIS': { name: 'Ryan Harrison', overall: 1648, surfaces: { hard: { rating: 1608, matches: 398 }, clay: { rating: 1650, matches: 200 }, grass: { rating: 1600, matches: 60 } }, totalMatches: 660, lastMatchDate: '2026-05-01' }
    },
    WTA: {}
  },
  aliasIndex: { ATP: {}, WTA: {} },
  engine: { constants: { k: 32, surfaceWeight: 0.5, minSurfaceMatches: 5, allowRetirement: false } }
};

const fixtureLoader = () => ({ available: true, snapshot: FIXTURE_SNAPSHOT });

function makeBucket(plays, league = 'Tennis', market = 'All Markets') {
  return { league, market, plays };
}

function makePlay(overrides = {}) {
  return {
    selection: 'Bucsa',
    odds: -111,
    game: 'Chwalinska vs Bucsa',
    market: 'Moneyline',
    tier: 'TIER 1',
    ...overrides
  };
}

// ── unit: americanToProb ────────────────────────────────────────

describe('americanToProb', () => {
  it('converts negative (favorite) American odds', () => {
    assert.equal(americanToProb(-111), 111 / 211);
    assert.equal(americanToProb(-100), 0.5);
  });
  it('converts positive (dog) American odds', () => {
    assert.equal(americanToProb(120), 100 / 220);
  });
  it('returns null for non-finite or zero odds', () => {
    assert.equal(americanToProb(0), null);
    assert.equal(americanToProb(NaN), null);
    assert.equal(americanToProb('abc'), null);
  });
});

// ── unit: resolvePoolKey ────────────────────────────────────────

describe('resolvePoolKey', () => {
  const pool = FIXTURE_SNAPSHOT.players.ATP;

  it('resolves exact full names', () => {
    assert.equal(resolvePoolKey(pool, 'Cristina Bucsa'), 'CRISTINA BUCSA');
    assert.equal(resolvePoolKey(pool, 'Novak Djokovic'), 'NOVAK DJOKOVIC');
  });
  it('resolves unique single-token names', () => {
    assert.equal(resolvePoolKey(pool, 'Bucsa'), 'CRISTINA BUCSA');
    assert.equal(resolvePoolKey(pool, 'Chwalinska'), 'MAJA CHWALINSKA');
    assert.equal(resolvePoolKey(pool, 'Tirante'), 'THIAGO AGUSTIN TIRANTE');
  });
  it('resolves ambiguous names to the clearly-dominant player', () => {
    // All three pool names contain HARRIS; Lloyd (400) >= 3x runner-up (130).
    assert.equal(resolvePoolKey(pool, 'Harris'), 'LLOYD HARRIS');
  });
  it('returns null for unknown players', () => {
    assert.equal(resolvePoolKey(pool, 'Nobody'), null);
    assert.equal(resolvePoolKey(pool, ''), null);
  });
});

// ── unit: matchSelectionSide ────────────────────────────────────

describe('matchSelectionSide', () => {
  const pool = FIXTURE_SNAPSHOT.players.ATP;

  it('matches selection to the correct side display name', () => {
    assert.equal(
      matchSelectionSide('MAJA CHWALINSKA', 'CRISTINA BUCSA', pool, 'Bucsa'),
      'Cristina Bucsa'
    );
    assert.equal(
      matchSelectionSide('MAJA CHWALINSKA', 'CRISTINA BUCSA', pool, 'Chwalinska'),
      'Maja Chwalinska'
    );
  });
  it('returns null when selection matches neither side', () => {
    assert.equal(matchSelectionSide('MAJA CHWALINSKA', 'CRISTINA BUCSA', pool, 'Djokovic'), null);
    assert.equal(matchSelectionSide('MAJA CHWALINSKA', 'CRISTINA BUCSA', pool, ''), null);
    assert.equal(matchSelectionSide('MAJA CHWALINSKA', 'CRISTINA BUCSA', pool, null), null);
  });
});

// ── enrichScanElo ───────────────────────────────────────────────

describe('enrichScanElo', () => {
  it('attaches full elo context to a resolvable Tennis Moneyline play', () => {
    const play = makePlay();
    const results = [makeBucket([play])];
    enrichScanElo(results, { loadSnapshot: fixtureLoader });

    assert.ok(play.elo, 'elo should be attached');
    assert.equal(play.elo.available, true);
    assert.equal(play.elo.coverage, 'full');
    assert.equal(play.elo.tour, 'atp');
    // game string "Chwalinska vs Bucsa" -> player1 Chwalinska, player2 Bucsa
    assert.equal(play.elo.player1.name, 'Maja Chwalinska');
    assert.equal(play.elo.player2.name, 'Cristina Bucsa');
    // selection "Bucsa" resolved to the Bucsa side -> her probability
    assert.equal(play.elo.selectedProbability, play.elo.probabilities.player2);
    // market fair prob from -111 odds, disagreement populated
    assert.ok(Math.abs(play.elo.marketFairProbability - 111 / 211) < 1e-9);
    assert.equal(typeof play.elo.selectedProbability, 'number');
    assert.equal(typeof play.elo.disagreement, 'number');
    // elo 1750 vs 1600 overall -> Bucsa strongly favored
    assert.ok(play.elo.selectedProbability > 0.6);
  });

  it('skips non-Moneyline plays (no elo attached)', () => {
    const play = makePlay({ market: 'Total Games', selection: 'Over 23.5' });
    const results = [makeBucket([play])];
    enrichScanElo(results, { loadSnapshot: fixtureLoader });
    assert.equal(play.elo, undefined);
  });

  it('skips non-Tennis leagues', () => {
    const play = makePlay();
    const results = [makeBucket([play], 'MLB', 'Moneyline')];
    enrichScanElo(results, { loadSnapshot: fixtureLoader });
    assert.equal(play.elo, undefined);
  });

  it('reports player_unresolved for WTA plays (empty WTA pool)', () => {
    const play = makePlay({ game: 'Ruse vs Eala', selection: 'Eala' });
    const results = [makeBucket([play])];
    enrichScanElo(results, { loadSnapshot: fixtureLoader });
    assert.equal(play.elo.available, false);
    assert.equal(play.elo.coverage, 'player_unresolved');
  });

  it('reports player_unresolved when a name resolves to nothing', () => {
    const play = makePlay({ game: 'Nobody vs Bucsa', selection: 'Bucsa' });
    const results = [makeBucket([play])];
    enrichScanElo(results, { loadSnapshot: fixtureLoader });
    assert.equal(play.elo.available, false);
    assert.equal(play.elo.coverage, 'player_unresolved');
  });

  it('reports snapshot_unavailable without throwing when loader returns unavailable', () => {
    const play = makePlay();
    const results = [makeBucket([play])];
    enrichScanElo(results, { loadSnapshot: () => ({ available: false, reason: 'not_found' }) });
    assert.equal(play.elo.available, false);
    assert.equal(play.elo.coverage, 'snapshot_unavailable');
    assert.equal(play.elo.reason, 'not_found');
  });

  it('never throws when the loader itself throws', () => {
    const play = makePlay();
    const results = [makeBucket([play])];
    assert.doesNotThrow(() => enrichScanElo(results, { loadSnapshot: () => { throw new Error('boom'); } }));
    assert.equal(play.elo.available, false);
    assert.equal(play.elo.coverage, 'overlay_error');
  });

  it('handles unparsable matchup strings without throwing', () => {
    const play = makePlay({ game: '', selection: 'Bucsa' });
    const results = [makeBucket([play])];
    assert.doesNotThrow(() => enrichScanElo(results, { loadSnapshot: fixtureLoader }));
    assert.equal(play.elo.available, false);
    assert.equal(play.elo.coverage, 'matchup_unparsed');
  });

  it('reports player_unresolved for an ambiguous name with no dominant player', () => {
    // Two players named identically in the token sense, neither dominant:
    // force ambiguity by matching against a pool where two keys tie closely.
    const play = makePlay({ game: 'Smith vs Jones', selection: 'Smith' });
    const results = [makeBucket([play])];
    const snapshot = JSON.parse(JSON.stringify(FIXTURE_SNAPSHOT));
    snapshot.players.ATP['ALEX SMITH'] = { name: 'Alex Smith', overall: 1600, surfaces: { hard: { rating: 1600, matches: 100 }, clay: { rating: 1600, matches: 100 }, grass: { rating: 1600, matches: 100 } }, totalMatches: 200, lastMatchDate: '2026-08-01' };
    snapshot.players.ATP['BOB SMITH'] = { name: 'Bob Smith', overall: 1610, surfaces: { hard: { rating: 1610, matches: 100 }, clay: { rating: 1610, matches: 100 }, grass: { rating: 1610, matches: 100 } }, totalMatches: 205, lastMatchDate: '2026-08-01' };
    enrichScanElo(results, { loadSnapshot: () => ({ available: true, snapshot }) });
    assert.equal(play.elo.available, false);
    assert.equal(play.elo.coverage, 'player_unresolved');
  });
});
