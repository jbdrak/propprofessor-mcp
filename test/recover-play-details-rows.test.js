'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { recoverPlayDetailsRows } = require('../scripts/server/handlers/recover-play-details-rows');

describe('recoverPlayDetailsRows', () => {
  it('relaxes a single unresolved game lookup and appends the matched row', async () => {
    const merged = [];
    const fallback = { gameId: 'new-game-id', selection: 'Away' };
    const queryCalls = [];

    const result = await recoverPlayDetailsRows({
      merged,
      relaxedGameIdMatch: false,
      args: { selection: 'Away', participants: ['Away', 'Home'] },
      gameIds: ['NBA:Away:Home:1700000000'],
      league: 'NBA',
      market: 'Moneyline',
      client: { name: 'fixture-client' },
      augmentedBooksExcluded: ['NoVigApp'],
      focusBook: 'NoVigApp',
      augmentedBooks: ['NoVigApp', 'Pinnacle'],
      queryPlayDetailsResponse: async (options) => {
        queryCalls.push(options);
        return { result: [{ gameId: 'new-game-id', homeTeam: 'Home', awayTeam: 'Away' }] };
      },
      resolveGameIdIdentity: () => ({ league: 'NBA' }),
      findBestMatchGameIdChanged: (rows, options) => {
        assert.equal(rows.length, 1);
        assert.equal(options.gameId, 'NBA:Away:Home:1700000000');
        return fallback;
      },
      lookupMatchTime: () => null
    });

    assert.deepEqual(result, [fallback]);
    assert.equal(queryCalls.length, 1);
    assert.equal(queryCalls[0].relaxedGameIdMatch, true);
    assert.deepEqual(queryCalls[0].relaxedParticipants, ['Away', 'Home']);
  });

  it('does nothing when there is already a match or more than one game ID', async () => {
    const existing = { gameId: 'existing' };
    const queryPlayDetailsResponse = async () => {
      throw new Error('should not query');
    };

    assert.deepEqual(
      await recoverPlayDetailsRows({
        merged: [existing],
        relaxedGameIdMatch: false,
        args: {},
        gameIds: ['one'],
        league: 'NBA',
        queryPlayDetailsResponse,
        resolveGameIdIdentity: () => ({})
      }),
      [existing]
    );
    assert.deepEqual(
      await recoverPlayDetailsRows({
        merged: [],
        relaxedGameIdMatch: false,
        args: {},
        gameIds: ['one', 'two'],
        league: 'NBA',
        queryPlayDetailsResponse,
        resolveGameIdIdentity: () => ({})
      }),
      []
    );
  });
});
