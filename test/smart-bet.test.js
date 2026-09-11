'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/ssb-mcp-server');
const { createMockClient } = require('./fixtures/mock-client');

describe('smart_bet', () => {
  it('throws when selection is missing', async () => {
    const { client } = createMockClient();
    const handlers = createMcpHandlers({ client });
    await assert.rejects(
      () => handlers.smart_bet({ book: 'NoVigApp' }),
      (err) => err.code === 'MISSING_PARAMS'
    );
  });

  it('throws when book is missing', async () => {
    const { client } = createMockClient();
    const handlers = createMcpHandlers({ client });
    await assert.rejects(
      () => handlers.smart_bet({ selection: 'Lakers' }),
      (err) => err.code === 'MISSING_PARAMS'
    );
  });

  it('returns found: false with activeSlate when no match', async () => {
    const { client } = createMockClient();
    const handlers = createMcpHandlers({ client });
    const result = await handlers.smart_bet({
      selection: 'XYZNonExistentPlayer',
      book: 'Fliff'
    });
    assert.equal(result.ok, true);
    assert.equal(result.found, false);
    assert.ok(result.message.includes('XYZNonExistentPlayer'));
    assert.ok(Array.isArray(result.activeSlate));
  });

  it('returns play + verdict + bestPrice + staking for a match', async () => {
    const { client } = createMockClient();
    const handlers = createMcpHandlers({ client });

    // Use a selection that exists in the fixture data (NBA Moneyline has Lakers,
    // Warriors, Bucks) with a known book. smart_bet composes quick_screen +
    // validate_play + find_best_price + staking_plan internally.
    const result = await handlers.smart_bet({
      selection: 'Lakers',
      book: 'NoVigApp',
      league: 'NBA',
      market: 'Moneyline',
      bankroll: 1000
    });

    assert.equal(result.ok, true);
    assert.equal(result.found, true);

    // Play metadata
    assert.ok(result.play);
    assert.ok(result.play.selection.toLowerCase().includes('lakers'));
    assert.ok(result.play.game);
    assert.equal(result.play.league, 'NBA');
    assert.equal(result.play.market, 'Moneyline');
    assert.ok(typeof result.play.odds === 'number');
    assert.ok(result.play.movementDisposition);
    assert.ok(result.play.displayTier);

    // Verdict bundle
    assert.ok(result.verdict);
    assert.ok(['BET', 'CONSIDER', 'PASS'].includes(result.verdict.verdict));
    assert.ok(result.verdict.actionableSummary);
    assert.ok(Array.isArray(result.verdict.riskFlags));
    assert.ok(result.verdict.movementDisposition);

    // Best price line shop
    if (result.bestPrice) {
      assert.ok(result.bestPrice.book);
      assert.ok(typeof result.bestPrice.odds === 'number');
    }

    // Staking (only if verdict is BET or CONSIDER)
    if (result.staking) {
      assert.ok(typeof result.staking.stake === 'number');
      assert.ok(typeof result.staking.stakePct === 'number');
    }
  });
});
