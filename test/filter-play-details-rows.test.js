'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { filterPlayDetailsRows } = require('../scripts/server/handlers/filter-play-details-rows');

describe('filterPlayDetailsRows', () => {
  it('keeps exact and timestamp-less identity matches and marks focus-book fallbacks', () => {
    const gameId = 'NBA:Away:Home:1700000000';
    const exact = { gameId, selection: 'Away' };
    const timestampLess = { gameId: 'NBA:Away:Home', selection: 'Home' };
    const other = { gameId: 'NBA:Other:Game:1700000000', selection: 'Other' };
    const fallback = { gameId, selection: 'Away', odds: -105 };

    const result = filterPlayDetailsRows({
      response: { result: [exact, timestampLess, other], focusBookMissingRows: [fallback] },
      args: {},
      gameIds: [gameId],
      league: 'NBA',
      relaxedGameIdMatch: false
    });

    assert.deepEqual(result, [exact, timestampLess, { ...fallback, __focusBookMissing: true }]);
  });

  it('returns all result and fallback rows in relaxed game-id mode', () => {
    const rows = [{ gameId: 'one' }, { gameId: 'two' }];
    const fallback = { gameId: 'fallback' };

    const result = filterPlayDetailsRows({
      response: { result: rows, focusBookMissingRows: [fallback] },
      args: {},
      gameIds: ['requested'],
      league: 'MLB',
      relaxedGameIdMatch: true
    });

    assert.deepEqual(result, [...rows, { ...fallback, __focusBookMissing: true }]);
  });
});
