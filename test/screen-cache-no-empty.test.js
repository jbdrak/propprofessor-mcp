'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { createPropProfessorClient } = require('../lib/propprofessor-api');

// Regression guard for the response-cache behavior on empty slates:
// the live backend intermittently returns 0 rows. The outer aggregate
// quick_screen cache and the per-league screen caches must not pin a
// transient empty/errored response — that would serve an empty slate for
// the full TTL on back-to-back calls.
//
// We mock at the CLIENT level with unique per-call IDs so we can count
// how many times the cache short-circuited versus re-fetched.
function makeClient() {
  let callCount = 0;
  const client = createPropProfessorClient();
  const emptyPayload = { game_data: [] };
  const realPayload = {
    game_data: [
      {
        homeTeam: 'A',
        awayTeam: 'B',
        selections: { ml: { odds: { NoVigApp: -110 }, consensus: {} } }
      }
    ]
  };
  client.queryScreenOddsBestComps = async ({ league = 'NBA', market = 'Moneyline' } = {}) => {
    callCount++;
    const key = `${league}:${market}:${callCount}`;
    if (callCount <= 3) return Promise.resolve({ ...emptyPayload, _key: key });
    return Promise.resolve({ ...(realPayload.payload?.[0] ?? realPayload), _key: key });
  };
  client.queryScreenOdds = client.queryScreenOddsBestComps;
  return { client, getCalls: () => callCount };
}

describe('screen cache does not pin empty responses', () => {
  it('re-fetches when the first call returns 0 rows (empty not cached)', async () => {
    const { client, getCalls } = makeClient();
    const handlers = createMcpHandlers({ client });
    const args = { leagues: ['WNBA'], book: 'NoVigApp', limit: 3, validate: false };

    const first = await handlers.quick_screen(args);
    await handlers.quick_screen(args);

    const firstCount = (first.results || []).reduce((s, l) => s + (l.count || (l.candidates || []).length || 0), 0);
    assert.ok(firstCount === 0, 'first call returned empty slate from WNBA fan-out');

    const callsAfterTwo = getCalls();
    assert.ok(callsAfterTwo > 3, 'second invocation must re-fetch instead of serving pinned empty cache');
  });
});
