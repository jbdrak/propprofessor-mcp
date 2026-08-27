'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createStateHandlers } = require('../scripts/server/handlers/state');

function makeClient(overrides = {}) {
  return {
    getHiddenBets: async () => [],
    hideBet: async () => {},
    unhideBet: async () => {},
    clearHiddenBets: async () => {},
    ...overrides
  };
}

describe('state handlers', () => {
  it('rejects an unknown action without calling the client', async () => {
    let calls = 0;
    const handlers = createStateHandlers(
      makeClient({
        getHiddenBets: async () => {
          calls += 1;
          return [];
        }
      })
    );

    const result = await handlers.manage_hidden_bets({ action: 'archive' });

    assert.deepEqual(result, {
      ok: false,
      error: { code: 'INVALID_PARAMS', message: 'action must be list, hide, unhide, or clear' }
    });
    assert.equal(calls, 0);
  });

  it('lists hidden bets through the client', async () => {
    const hidden = [{ gameId: 'game-1', selection: 'Team A' }];
    const handlers = createStateHandlers(makeClient({ getHiddenBets: async () => hidden }));

    assert.deepEqual(await handlers.manage_hidden_bets({ action: 'list' }), { ok: true, result: hidden });
  });

  it('requires gameId for hide and unhide', async () => {
    const handlers = createStateHandlers(makeClient());

    for (const action of ['hide', 'unhide']) {
      assert.deepEqual(await handlers.manage_hidden_bets({ action }), {
        ok: false,
        error: { code: 'MISSING_PARAMS', message: 'gameId is required' }
      });
    }
  });

  it('forwards hide and unhide arguments and clears all hidden bets', async () => {
    const calls = [];
    const handlers = createStateHandlers(
      makeClient({
        hideBet: async (...args) => calls.push(['hide', ...args]),
        unhideBet: async (...args) => calls.push(['unhide', ...args]),
        clearHiddenBets: async () => calls.push(['clear'])
      })
    );

    assert.equal(
      (
        await handlers.manage_hidden_bets({
          action: 'hide',
          gameId: 'game-1',
          selection: 'Team A',
          market: 'Moneyline'
        })
      ).ok,
      true
    );
    assert.equal((await handlers.manage_hidden_bets({ action: 'unhide', gameId: 'game-1' })).ok, true);
    assert.equal((await handlers.manage_hidden_bets({ action: 'clear' })).ok, true);
    assert.deepEqual(calls, [['hide', 'game-1', 'Team A', 'Moneyline'], ['unhide', 'game-1', null, null], ['clear']]);
  });

  it('returns a clean backend error when the client throws null', async () => {
    const handlers = createStateHandlers(
      makeClient({
        clearHiddenBets: async () => {
          throw null;
        }
      })
    );

    assert.deepEqual(await handlers.manage_hidden_bets({ action: 'clear' }), {
      ok: false,
      error: { code: 'BACKEND_ERROR', message: 'null' }
    });
  });

  it('clears the score timeline and returns confirmation', async () => {
    const handlers = createStateHandlers(makeClient());

    assert.deepEqual(await handlers.clear_score_timeline(), {
      ok: true,
      message: 'Score timeline cache cleared. Tier trajectory data reset.'
    });
  });
});
