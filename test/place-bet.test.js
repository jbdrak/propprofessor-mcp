'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/ssb-mcp-server');

describe('place_bet workflow (validate + log in one call)', () => {
  function makeHandlers({ validateVerdict = 'BET' } = {}) {
    const handlers = createMcpHandlers({ client: {} });
    handlers.validate_play = async () => ({
      ok: true,
      verdict: validateVerdict,
      tier: 'TIER 1',
      reasons: validateVerdict === 'PASS' ? ['movement adverse', 'thin consensus'] : ['sharp agreement'],
      play: { game: 'Lakers vs Celtics', odds: -110 }
    });
    let logged = null;
    handlers.log_pick = async (args) => {
      logged = { ...args, id: 'pick-abc-123' };
      return { ok: true, pick: logged };
    };
    return { handlers, getLogged: () => logged };
  }

  it('validates and logs in one call, returns pickId', async () => {
    const { handlers, getLogged } = makeHandlers();
    const r = await handlers.place_bet({
      league: 'NBA',
      gameId: 'NBA:PREMATCH:LAL:BOS:123',
      selection: 'Lakers -3.5',
      market: 'Spread',
      book: 'NoVigApp',
      stake: 50
    });
    assert.equal(r.ok, true);
    assert.equal(r.verdict, 'BET');
    assert.equal(r.tier, 'TIER 1');
    assert.equal(r.pickId, 'pick-abc-123');
    assert.ok(r.workflow.includes('logged'), 'workflow should describe what was done');
    const logged = getLogged();
    assert.equal(logged.selection, 'Lakers -3.5');
    assert.equal(logged.confidenceTier, 'TIER 1');
    assert.equal(logged.kaiCall, 'BET');
    assert.equal(logged.odds, -110);
  });

  it('returns a clear error when validate_play says PASS', async () => {
    const { handlers } = makeHandlers({ validateVerdict: 'PASS' });
    const r = await handlers.place_bet({
      league: 'NBA',
      gameId: 'NBA:PREMATCH:LAL:BOS:123',
      selection: 'Lakers -3.5',
      market: 'Spread',
      book: 'NoVigApp',
      stake: 50
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BET_REJECTED');
    assert.match(r.error.message, /PASS/);
  });

  it('returns error when validation fails (no verdict)', async () => {
    const handlers = createMcpHandlers({ client: {} });
    handlers.validate_play = async () => ({ ok: false, error: { message: 'lookup failed' } });
    const r = await handlers.place_bet({
      league: 'NBA',
      selection: 'X',
      market: 'Spread',
      book: 'NoVigApp',
      stake: 50
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'VALIDATION_FAILED');
  });
});
