'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The live get_market_registry handler is registered by createContextPluginsHandlers,
// which createMcpHandlers() merges LAST (after createMetaHandlers). So the test must
// exercise the assembled handler set, not createMetaHandlers alone — otherwise it would
// pass against the dead duplicate in meta.js and miss the actual live seam.
const { createMcpHandlers } = require('../scripts/server/handlers');

// createMcpHandlers requires a client for the ctx, but get_market_registry ignores it.
// A harmless stub satisfies the construction path without any network calls.
const handlers = createMcpHandlers({ client: {} });

test('get_market_registry exposes player prop catalogs for MLB', async () => {
  const res = await handlers.get_market_registry({ sport: 'MLB' });

  assert.equal(res.ok, true);
  assert.equal(res.sport, 'MLB');

  // Main-line markets must remain unchanged.
  assert.ok(Array.isArray(res.markets));
  assert.ok(res.markets.length > 0, 'main markets must be preserved');

  // Player prop catalog must be present and include the synced MLB props.
  assert.ok(Array.isArray(res.propMarkets), 'response must include a propMarkets array');
  assert.ok(res.propMarkets.includes('Player Triples'), 'propMarkets must include Player Triples');
  assert.ok(res.propMarkets.includes('Pitcher Outs Recorded'), 'propMarkets must include Pitcher Outs Recorded');
});

test('get_market_registry returns empty propMarkets for unknown sport', async () => {
  const res = await handlers.get_market_registry({ sport: 'Curling' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.propMarkets, [], 'unknown sport must yield empty propMarkets');
});
