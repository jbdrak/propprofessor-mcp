'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { createMockClient } = require('./fixtures/mock-client');

describe('excludeBooks (Task 2: mirror website account Settings)', () => {
  it('find_best_price strips excluded books from the backend query', async () => {
    const { client, calls } = createMockClient();
    const handlers = createMcpHandlers({ client });
    await handlers.find_best_price({
      league: 'NBA',
      market: 'Moneyline',
      game: 'Lakers vs Celtics',
      selection: 'Los Angeles Lakers',
      books: ['Pinnacle', 'Fliff', 'DraftKings'],
      excludeBooks: ['Fliff']
    });
    const lastCall = calls.queryScreenOddsBestComps.at(-1);
    assert.ok(lastCall, 'backend was queried');
    assert.deepEqual(lastCall.books.sort(), ['DraftKings', 'Pinnacle'], 'Fliff should be removed from the query books');
  });

  it('get_play_details strips excluded books from the backend query', async () => {
    const { client, calls } = createMockClient();
    const handlers = createMcpHandlers({ client });
    await handlers.get_play_details({
      league: 'NBA',
      game_ids: ['NBA:PREMATCH:Lakers:Celtics:1783807200'],
      market: 'Moneyline',
      books: ['Pinnacle', 'Fliff', 'Bovada'],
      excludeBooks: ['Fliff', 'Bovada']
    });
    const lastCall = calls.queryScreenOddsBestComps.at(-1);
    assert.ok(lastCall, 'backend was queried');
    // Excluded books must be gone, even after sharp-book auto-augmentation.
    assert.ok(!lastCall.books.some((b) => /fliff|bovada/i.test(b)), 'Fliff+Bovada should be removed');
    assert.ok(lastCall.books.includes('Pinnacle'), 'Pinnacle (requested) should remain');
  });

  it('excludeBooks is a no-op when omitted', async () => {
    const { client, calls } = createMockClient();
    const handlers = createMcpHandlers({ client });
    await handlers.find_best_price({
      league: 'NBA',
      market: 'Moneyline',
      game: 'Lakers vs Celtics',
      selection: 'Los Angeles Lakers',
      books: ['Pinnacle', 'Fliff']
    });
    const lastCall = calls.queryScreenOddsBestComps.at(-1);
    assert.deepEqual(lastCall.books.sort(), ['Fliff', 'Pinnacle']);
  });
});

describe('get_play_details: /screen grid filters (Task 5)', () => {
  it('passes participants + live through to the backend query', async () => {
    const { client, calls } = createMockClient();
    const handlers = createMcpHandlers({ client });
    await handlers.get_play_details({
      league: 'NBA',
      game_ids: ['NBA:PREMATCH:Lakers:Celtics:1783807200'],
      market: 'Moneyline',
      participants: ['Lakers', 'Celtics'],
      live: true
    });
    const lastCall = calls.queryScreenOddsBestComps.at(-1);
    assert.ok(lastCall, 'backend was queried');
    assert.deepEqual(lastCall.participants, ['Lakers', 'Celtics'], 'participants forwarded');
    assert.equal(lastCall.is_live, true, 'live toggled on');
  });

  it('defaults to pre-match (is_live false) when live omitted', async () => {
    const { client, calls } = createMockClient();
    const handlers = createMcpHandlers({ client });
    await handlers.get_play_details({
      league: 'NBA',
      game_ids: ['NBA:PREMATCH:Lakers:Celtics:1783807200'],
      market: 'Moneyline'
    });
    const lastCall = calls.queryScreenOddsBestComps.at(-1);
    assert.equal(lastCall.is_live, false, 'pre-match by default');
    assert.deepEqual(lastCall.participants, [], 'no participant filter by default');
  });
});
