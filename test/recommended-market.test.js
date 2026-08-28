'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runRecommendedMarket } = require('../scripts/server/handlers/recommended-market');

describe('recommended market runner', () => {
  it('forwards screen arguments and tags returned rows with the market', async () => {
    const calls = [];
    const handlers = {
      screen_ranked: async (args) => {
        calls.push(args);
        return { ok: true, result: [{ gameId: 'game-1', selection: 'Team A' }] };
      }
    };

    const rows = await runRecommendedMarket({
      handlers,
      league: 'MLB',
      market: 'Player Triples',
      books: ['NoVigApp'],
      limit: 4,
      compact: true,
      fields: ['gameId'],
      include: ['market'],
      skipHistory: true,
      screenTimeoutMs: 100
    });

    assert.deepEqual(calls, [
      {
        league: 'MLB',
        market: 'Player Triples',
        books: ['NoVigApp'],
        limit: 4,
        is_live: false,
        includeAll: false,
        debug: false,
        compact: true,
        fields: ['gameId'],
        include: ['market'],
        skipHistory: true
      }
    ]);
    assert.deepEqual(rows, [{ gameId: 'game-1', selection: 'Team A', _market: 'Player Triples' }]);
  });

  it('returns no rows when screen_ranked exceeds the timeout', async () => {
    const handlers = { screen_ranked: () => new Promise(() => {}) };
    const rows = await runRecommendedMarket({
      handlers,
      league: 'NBA',
      market: 'Moneyline',
      screenTimeoutMs: 5
    });

    assert.deepEqual(rows, []);
  });
});
