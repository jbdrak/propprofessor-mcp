'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTennisMarketQuery, rankTennisScreenRows } = require('../lib/screen-tennis');

describe('normalizeTennisMarketQuery', () => {
  it('keeps Set Handicap distinct from Game Handicap', () => {
    assert.deepEqual(normalizeTennisMarketQuery('Set Handicap'), ['Set Handicap']);
    assert.deepEqual(normalizeTennisMarketQuery('set_handicap'), ['Set Handicap']);
    assert.deepEqual(normalizeTennisMarketQuery('handicap'), ['Game Handicap']);
  });
});

// Helper to build a tennis moneyline row for a given book, matchup, side, and odds.
// Shape mirrors what the upstream /screen endpoint produces: allBookOdds is
// a per-book odds map, row.book is the source book, and rankScreenRows will
// resolve the preferred side via row.selectionId.
function buildTennisRow({ book, homeTeam, awayTeam, pick, targetBookOdds, gameId, id }) {
  const side = pick === homeTeam ? 1 : 2;
  return {
    book,
    league: 'Tennis',
    homeTeam,
    awayTeam,
    participant: pick,
    selection: pick,
    market: 'Moneyline',
    selection1: homeTeam,
    participant1: homeTeam,
    selection1Id: `Moneyline:${homeTeam}`,
    selection2: awayTeam,
    participant2: awayTeam,
    selection2Id: `Moneyline:${awayTeam}`,
    gameId: gameId || `${homeTeam}-${awayTeam}`,
    id: id || `${homeTeam}-${awayTeam}`,
    lineHistory: [],
    allBookOdds: {
      [book]: { book, [`odds${side}`]: targetBookOdds, [`odds${side === 1 ? 2 : 1}`]: 200 }
    }
  };
}

describe('rankTennisScreenRows — dedup (2026-06-17)', () => {
  it('keeps only the highest-scored row per (gameId, selection) when dedup=true', () => {
    // Ferro is posted by 11 different books; the ranker should keep only one
    // row per matchup+side. The focus book here is Pinnacle (so the rows
    // are not fallbacks) — they all have Pinnacle in the book column and
    // the ranker can sort them on Pinnacle.
    const rows = [
      buildTennisRow({
        book: 'Pinnacle',
        homeTeam: 'Ferro',
        awayTeam: 'Gorgodze',
        pick: 'Ferro',
        targetBookOdds: -700,
        id: 'ferro-gorgodze',
        gameId: 'ferro-gorgodze'
      }),
      buildTennisRow({
        book: 'Kalshi',
        homeTeam: 'Ferro',
        awayTeam: 'Gorgodze',
        pick: 'Ferro',
        targetBookOdds: -489,
        id: 'ferro-gorgodze',
        gameId: 'ferro-gorgodze'
      }),
      buildTennisRow({
        book: 'Pinnacle',
        homeTeam: 'Ferro',
        awayTeam: 'Gorgodze',
        pick: 'Ferro',
        targetBookOdds: -541,
        id: 'ferro-gorgodze',
        gameId: 'ferro-gorgodze'
      }),
      buildTennisRow({
        book: 'theScore',
        homeTeam: 'Ferro',
        awayTeam: 'Gorgodze',
        pick: 'Ferro',
        targetBookOdds: -575,
        id: 'ferro-gorgodze',
        gameId: 'ferro-gorgodze'
      }),
      buildTennisRow({
        book: 'Fanatics',
        homeTeam: 'Ferro',
        awayTeam: 'Gorgodze',
        pick: 'Ferro',
        targetBookOdds: -600,
        id: 'ferro-gorgodze',
        gameId: 'ferro-gorgodze'
      })
    ];
    const ranked = rankTennisScreenRows(rows, { preferredBook: 'Pinnacle', limit: 50, includeAll: true });
    const ferroRows = ranked.filter((r) => r.homeTeam === 'Ferro' && r.pick === 'Ferro');
    assert.equal(ferroRows.length, 1, 'should dedupe to one Ferro row');
  });

  it('keeps separate rows for the two sides of the same matchup', () => {
    // Ferro on Gorgodze vs Ferro and Gorgodze on Gorgodze vs Ferro are
    // different selections (different gameId+selection). Both should survive.
    const rows = [
      buildTennisRow({
        book: 'Pinnacle',
        homeTeam: 'Ferro',
        awayTeam: 'Gorgodze',
        pick: 'Ferro',
        targetBookOdds: -489
      }),
      buildTennisRow({
        book: 'Pinnacle',
        homeTeam: 'Ferro',
        awayTeam: 'Gorgodze',
        pick: 'Gorgodze',
        targetBookOdds: 380
      })
    ];
    const ranked = rankTennisScreenRows(rows, { preferredBook: 'Pinnacle', limit: 50, includeAll: true });
    assert.equal(ranked.length, 2, 'opposite sides of the same match should both be kept');
  });

  it('does NOT dedupe when dedup=false (legacy behavior)', () => {
    // All three rows on the focus book (Pinnacle) so they stay in the main
    // array even when dedup=false. (Rows on other books would land in
    // focusBookMissingRows, not the main array — see the structural test
    // in test/screen-ranker.test.js.)
    const rows = [
      buildTennisRow({
        book: 'Pinnacle',
        homeTeam: 'Ferro',
        awayTeam: 'Gorgodze',
        pick: 'Ferro',
        targetBookOdds: -700
      }),
      buildTennisRow({
        book: 'Pinnacle',
        homeTeam: 'Ferro',
        awayTeam: 'Gorgodze',
        pick: 'Ferro',
        targetBookOdds: -489
      }),
      buildTennisRow({ book: 'Pinnacle', homeTeam: 'Ferro', awayTeam: 'Gorgodze', pick: 'Ferro', targetBookOdds: -541 })
    ];
    const ranked = rankTennisScreenRows(rows, {
      preferredBook: 'Pinnacle',
      limit: 50,
      includeAll: true,
      dedup: false
    });
    assert.equal(ranked.length, 3, 'dedup=false should preserve every book on the focus book');
  });
});

// ── Phase 1 Task 2: screen-tennis routes single-book CLV through the canonical
// computeMovementDisposition producer (no competing inline threshold rule). ──
describe('tennisMovementDisposition routes through canonical computeMovementDisposition', () => {
  const { computeMovementDisposition } = require('../lib/propprofessor-movement-disposition');
  const { tennisMovementDisposition } = require('../lib/screen-tennis');

  it('positive clv => supportive_bouncy (matches canonical translation)', () => {
    const fromHelper = tennisMovementDisposition(1.2);
    const fromCanonical = computeMovementDisposition({
      movementGrade: 'yellow',
      movementLabel: 'supportive',
      recentSharpMoveDirection: 'supportive',
      fullWindowSharpMoveDirection: 'supportive',
      clvProxyPct: 1.2
    });
    assert.equal(fromHelper, fromCanonical);
    assert.equal(fromHelper, 'supportive_bouncy');
  });

  it('negative clv => adverse_full (matches canonical translation)', () => {
    assert.equal(tennisMovementDisposition(-1.2), 'adverse_full');
  });

  it('flat clv => insufficient', () => {
    assert.equal(tennisMovementDisposition(0.2), 'insufficient');
  });

  it('non-finite clv => insufficient', () => {
    assert.equal(tennisMovementDisposition(null), 'insufficient');
    assert.equal(tennisMovementDisposition(undefined), 'insufficient');
  });
});
