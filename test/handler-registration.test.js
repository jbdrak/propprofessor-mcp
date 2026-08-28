'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeHandlerModule } = require('../scripts/server/handlers/handler-utils');
const { createMcpHandlers } = require('../scripts/server/handlers');

describe('handler module registration', () => {
  it('rejects an undocumented handler collision before overwriting', () => {
    const original = () => 'original';
    const replacement = () => 'replacement';
    const handlers = { example: original };
    const owners = new Map([['example', 'inline']]);

    assert.throws(
      () => mergeHandlerModule(handlers, owners, 'new-module', { example: replacement }),
      /Duplicate MCP handler "example" from new-module; already registered by inline/
    );
    assert.equal(handlers.example, original);
    assert.equal(owners.get('example'), 'inline');
  });

  it('allows only the documented state-to-context override', () => {
    const stateHandler = () => 'state';
    const contextHandler = () => 'context';
    const handlers = {};
    const owners = new Map();

    mergeHandlerModule(handlers, owners, 'state', { clear_score_timeline: stateHandler });
    mergeHandlerModule(handlers, owners, 'context-plugins', { clear_score_timeline: contextHandler });

    assert.equal(handlers.clear_score_timeline, contextHandler);
    assert.equal(owners.get('clear_score_timeline'), 'context-plugins');
  });

  it('uses the live context-plugin contract for hidden bets', async () => {
    const calls = [];
    const client = {
      getHiddenBets: async () => [{ id: 'hidden-1' }],
      hideBet: async (bet) => calls.push(['hide', bet]),
      unhideBet: async (id) => calls.push(['unhide', id]),
      clearHiddenBets: async () => calls.push(['clear'])
    };
    const handlers = createMcpHandlers({ client });
    const bet = { betId: 'bet-1', matchId: 'match-1', market: 'Moneyline', selection: 'Team A' };

    assert.deepEqual(await handlers.manage_hidden_bets({ action: 'hide', bet }), {
      ok: true,
      action: 'hide',
      result: 1
    });
    assert.deepEqual(await handlers.manage_hidden_bets({ action: 'unhide', id: 'hidden-1' }), {
      ok: true,
      action: 'unhide',
      result: 2
    });
    assert.deepEqual(await handlers.manage_hidden_bets({ action: 'list' }), {
      ok: true,
      action: 'list',
      result: [{ id: 'hidden-1' }]
    });
    assert.deepEqual(calls, [
      ['hide', bet],
      ['unhide', 'hidden-1']
    ]);
  });
});
