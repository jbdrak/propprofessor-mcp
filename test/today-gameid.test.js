'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/ssb-mcp-server');
const { createMockClient } = require('./fixtures/mock-client');

// Raw screen-API shape (game_data + selections), like the real backend.
// Models a WNBA total with strong consensus so it ranks TIER 1 + BET.
const NOW = Date.parse('2026-07-12T17:00:00.000Z');
// Keep the fixture on a fixed local calendar date and freeze the clock during
// the handler call. The card-window filter uses Date.now() and America/Chicago;
// a live clock makes this test fail after the fixture's local day rolls over.
const FUTURE_START = new Date(NOW + 60 * 60 * 1000);
const WNBA_TOTAL_PAYLOAD = {
  game_data: [
    {
      gameId: 'wnba-20260712-fever-aces',
      league: 'WNBA',
      market: 'Total Points',
      updatedAt: new Date(NOW - 30_000).toISOString(),
      homeTeam: 'Indiana Fever',
      awayTeam: 'Las Vegas Aces',
      // Use a dynamic future start time on today's local calendar date.
      start: FUTURE_START.toISOString(),
      selections: {
        tp: {
          selection1: 'Over 178.5',
          participant1: 'Over 178.5',
          selection1Id: 'Total:Over_178.5',
          selection2: 'Under 178.5',
          participant2: 'Under 178.5',
          selection2Id: 'Total:Under_178.5',
          line1: 178.5,
          line2: 178.5,
          odds: {
            NoVigApp: { odds1: -110, odds2: 117 },
            Pinnacle: { odds1: -112, odds2: 120 },
            Circa: { odds1: -108, odds2: 115 }
          }
        }
      }
    }
  ]
};

test('today() slate rows expose gameId for validate_play chaining', async () => {
  const { client } = createMockClient({
    screenPayloads: { 'WNBA:Total Points': WNBA_TOTAL_PAYLOAD }
  });
  const handlers = createMcpHandlers({ client });
  // Pass targetTiers that include what the mock data actually grades to (TIER 3+4).
  // The test is about gameId passthrough, not tier filtering.
  const realDateNow = Date.now;
  Date.now = () => NOW;
  let result;
  try {
    result = await handlers.today({
      leagues: ['WNBA'],
      book: 'NoVigApp',
      targetTiers: ['TIER 1', 'TIER 2', 'TIER 3', 'TIER 4']
    });
  } finally {
    Date.now = realDateNow;
  }
  assert.ok(result.ok, 'today() returns ok');
  assert.ok(Array.isArray(result.slate), 'slate is an array');
  assert.ok(result.slate.length > 0, 'slate has at least one row');
  const row = result.slate[0];
  assert.strictEqual(row.gameId, 'wnba-20260712-fever-aces', 'gameId passes through from candidate');
});
