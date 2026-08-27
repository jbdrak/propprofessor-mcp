'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildFinalResearchBatch } = require('../lib/propprofessor-quick-screen-research');

function candidate({ score = 10, selection = 'Player', ...overrides } = {}) {
  return { screenScore: score, selection, ...overrides };
}

describe('buildFinalResearchBatch', () => {
  it('returns an empty batch for null/empty input', () => {
    assert.deepEqual(buildFinalResearchBatch(null), []);
    assert.deepEqual(buildFinalResearchBatch([]), []);
    assert.deepEqual(buildFinalResearchBatch(undefined), []);
  });

  it('skips entries with no candidates', () => {
    const out = buildFinalResearchBatch([
      { league: 'NBA', candidates: [] },
      { league: 'MLB', candidates: null }
    ]);
    assert.deepEqual(out, []);
  });

  it('builds one row per candidate with league/market from entry', () => {
    const out = buildFinalResearchBatch([
      {
        league: 'NBA',
        market: 'Points',
        candidates: [candidate({ selection: 'LeBron', score: 50 })]
      }
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].player, 'LeBron');
    assert.equal(out[0].league, 'NBA');
    assert.equal(out[0].market, 'Points');
  });

  it('falls back to row.league when entry.league is missing', () => {
    const out = buildFinalResearchBatch([{ candidates: [candidate({ selection: 'X', league: 'NFL', score: 5 })] }]);
    assert.equal(out[0].league, 'NFL');
  });

  it('falls back to row.market when entry.market is missing', () => {
    const out = buildFinalResearchBatch([
      { candidates: [candidate({ selection: 'X', market: 'Rebounds', score: 5 })] }
    ]);
    assert.equal(out[0].market, 'Rebounds');
  });

  it('skips candidates with no selection/participant/pick', () => {
    const out = buildFinalResearchBatch([{ candidates: [{ screenScore: 5 }] }]);
    assert.deepEqual(out, []);
  });

  it('sorts by screenScore descending and respects limit', () => {
    const out = buildFinalResearchBatch(
      [
        { candidates: [candidate({ selection: 'Low', score: 5 })] },
        { candidates: [candidate({ selection: 'High', score: 99 })] },
        { candidates: [candidate({ selection: 'Mid', score: 50 })] }
      ],
      2
    );
    assert.deepEqual(
      out.map((r) => r.player),
      ['High', 'Mid']
    );
  });

  it('treats negative limit as zero rows', () => {
    const out = buildFinalResearchBatch([{ candidates: [candidate({ selection: 'X', score: 5 })] }], -1);
    assert.deepEqual(out, []);
  });

  it('de-dupes by gameId:player (case-insensitive) across totals variants', () => {
    const out = buildFinalResearchBatch([
      {
        candidates: [
          candidate({ selection: 'LeBron', score: 30, gameId: 'g1', market: 'Points O 25.5' }),
          candidate({ selection: 'LeBron', score: 29, gameId: 'g1', market: 'Points O 24.5' }),
          candidate({ selection: 'AD', score: 28, gameId: 'g1', market: 'Points O 20.5' })
        ]
      }
    ]);
    // LeBron appears twice (same gameId:player) → only first (higher score) kept.
    const lebron = out.filter((r) => r.player === 'LeBron');
    assert.equal(lebron.length, 1);
    assert.equal(out.length, 2);
  });

  it('keeps separate rows when player differs', () => {
    const out = buildFinalResearchBatch([
      {
        candidates: [
          candidate({ selection: 'LeBron', score: 30, gameId: 'g1' }),
          candidate({ selection: 'AD', score: 28, gameId: 'g1' })
        ]
      }
    ]);
    assert.equal(out.length, 2);
  });

  it('uses row.game when present, else builds away @ home', () => {
    const withGame = buildFinalResearchBatch([
      { candidates: [candidate({ selection: 'X', score: 5, game: 'LAL vs BOS' })] }
    ]);
    assert.equal(withGame[0].game, 'LAL vs BOS');
    const built = buildFinalResearchBatch([
      { candidates: [candidate({ selection: 'X', score: 5, awayTeam: 'BOS', homeTeam: 'LAL' })] }
    ]);
    assert.equal(built[0].game, 'BOS @ LAL');
  });

  it('captures start from row.start or row.eventStart', () => {
    const a = buildFinalResearchBatch([
      { candidates: [candidate({ selection: 'X', score: 5, start: '2026-08-26T20:00Z' })] }
    ]);
    assert.equal(a[0].start, '2026-08-26T20:00Z');
    const b = buildFinalResearchBatch([
      { candidates: [candidate({ selection: 'X', score: 5, eventStart: '2026-08-27T20:00Z' })] }
    ]);
    assert.equal(b[0].start, '2026-08-27T20:00Z');
    const c = buildFinalResearchBatch([{ candidates: [candidate({ selection: 'X', score: 5 })] }]);
    assert.equal(c[0].start, null);
  });
});
