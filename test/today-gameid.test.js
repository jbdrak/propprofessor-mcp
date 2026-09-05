'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { createMockClient } = require('./fixtures/mock-client');

// Raw screen-API shape (game_data + selections), like the real backend.
// Models a WNBA total with strong consensus so it ranks TIER 1 + BET.
const NOW = Date.now();
// Use a start time that resolves to today in America/Chicago timezone.
// Must be within cardWindow='today' to pass the date filter.
const TODAY_7PM_CT = new Date();
TODAY_7PM_CT.setHours(19, 0, 0, 0); // 7:00 PM CT today
const WNBA_TOTAL_PAYLOAD = {
  game_data: [
    {
      gameId: 'wnba-20260712-fever-aces',
      league: 'WNBA',
      market: 'Total Points',
      updatedAt: new Date(NOW - 30_000).toISOString(),
      homeTeam: 'Indiana Fever',
      awayTeam: 'Las Vegas Aces',
      // Use a dynamic start time that's today at 7pm CT.
      start: TODAY_7PM_CT.toISOString(),
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
  const result = await handlers.today({
    leagues: ['WNBA'],
    book: 'NoVigApp',
    targetTiers: ['TIER 1', 'TIER 2', 'TIER 3', 'TIER 4']
  });
  assert.ok(result.ok, 'today() returns ok');
  assert.ok(Array.isArray(result.slate), 'slate is an array');
  assert.ok(result.slate.length > 0, 'slate has at least one row');
  const row = result.slate[0];
  assert.strictEqual(row.gameId, 'wnba-20260712-fever-aces', 'gameId passes through from candidate');
});
