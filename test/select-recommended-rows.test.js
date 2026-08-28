'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { selectRecommendedRows } = require('../scripts/server/handlers/select-recommended-rows');

describe('selectRecommendedRows', () => {
  it('deduplicates by game and selection, keeping the higher screen score', () => {
    const lower = { gameId: 'game-1', selection: 'Over 1.5', screenScore: 4 };
    const higher = { gameId: 'game-1', selection: 'Over 1.5', screenScore: 8 };

    const result = selectRecommendedRows([lower, higher], ['TIER 1'], 10, {
      getStableTier: () => 'TIER 1'
    });

    assert.deepEqual(result, [higher]);
  });

  it('uses live tiers when present, then sorts by tier and screen score', () => {
    const rows = [
      { gameId: 'game-1', selection: 'A', confidenceTierLive: 'TIER 2', screenScore: 99 },
      { gameId: 'game-2', selection: 'B', confidenceTier: 'TIER 1', screenScore: 2 },
      { gameId: 'game-3', selection: 'C', confidenceTierLive: 'TIER 1', screenScore: 7 },
      { gameId: 'game-4', selection: 'D', confidenceTier: 'TIER 3', screenScore: 100 }
    ];

    const result = selectRecommendedRows(rows, ['TIER 1', 'TIER 2'], 3, {
      getStableTier: () => 'TIER 4'
    });

    assert.deepEqual(
      result.map((row) => row.selection),
      ['B', 'A', 'C']
    );
  });

  it('falls back to the stable tier and does not mutate source ordering', () => {
    const rows = [
      { gameId: 'game-1', selection: 'A', screenScore: 5 },
      { gameId: 'game-2', selection: 'B', screenScore: 6 }
    ];
    const originalOrder = rows.slice();

    const result = selectRecommendedRows(rows, ['TIER 1'], 10, {
      getStableTier: (row) => (row.selection === 'A' ? 'TIER 1' : 'TIER 2')
    });

    assert.deepEqual(result, [rows[0]]);
    assert.deepEqual(rows, originalOrder);
  });
});
