'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');

describe('today() — one-call slate + pending picks + stats', () => {
  function makeHandlers() {
    const handlers = createMcpHandlers({ client: {} });
    handlers.quick_screen = async () => ({
      ok: true,
      results: [
        {
          league: 'WNBA',
          market: 'Moneyline',
          candidates: [
            { game: 'G1', selection: 'A', odds: -110, confidenceTier: 'TIER 1', kaiCall: 'BET', consensusEdge: 1.2 }
          ]
        }
      ]
    });
    handlers.get_pick_history = async () => ({ ok: true, picks: [{ id: 'p1', status: 'pending', selection: 'X' }] });
    handlers.get_pick_stats = async () => ({ ok: true, stats: { winRate: '54%', profit: 120 } });
    return handlers;
  }

  it('returns slate + pending picks + stats in one call', async () => {
    const handlers = makeHandlers();
    const r = await handlers.today({ leagues: ['WNBA', 'NBA'], book: 'NoVigApp' });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.slate), 'slate should be an array');
    assert.equal(r.slate.length, 1, 'slate should have the quick_screen candidate');
    assert.ok(Array.isArray(r.pendingPicks), 'pendingPicks should be an array');
    assert.equal(r.pendingPicks.length, 1);
    assert.ok(r.stats, 'stats should be present');
    assert.equal(r.stats.winRate, '54%');
    assert.match(r.summary, /sharp plays/);
  });

  it('falls back gracefully when history/stats fail', async () => {
    const handlers = makeHandlers();
    handlers.get_pick_history = async () => {
      throw new Error('boom');
    };
    handlers.get_pick_stats = async () => {
      throw new Error('boom');
    };
    const r = await handlers.today({ leagues: ['WNBA'], book: 'NoVigApp' });
    assert.equal(r.ok, true);
    assert.equal(r.pendingPicks.length, 0);
    assert.equal(r.stats, null);
  });
});
