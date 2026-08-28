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

    await assert.rejects(
      () => handlers.manage_hidden_bets({ action: 'archive' }),
      (error) => {
        assert.equal(error.code, 'INVALID_ACTION');
        assert.match(error.message, /Must be one of: list, hide, unhide, clear/);
        return true;
      }
    );
    assert.equal(calls, 0);
  });

  it('lists hidden bets through the client', async () => {
    const hidden = [{ gameId: 'game-1', selection: 'Team A' }];
    const handlers = createStateHandlers(makeClient({ getHiddenBets: async () => hidden }));

    assert.deepEqual(await handlers.manage_hidden_bets({ action: 'list' }), {
      ok: true,
      action: 'list',
      result: hidden
    });
  });

  it('requires bet and id for hide and unhide', async () => {
    const handlers = createStateHandlers(makeClient());

    await assert.rejects(
      () => handlers.manage_hidden_bets({ action: 'hide' }),
      (error) => {
        assert.equal(error.code, 'MISSING_BET');
        return true;
      }
    );
    await assert.rejects(
      () => handlers.manage_hidden_bets({ action: 'unhide' }),
      (error) => {
        assert.equal(error.code, 'MISSING_ID');
        return true;
      }
    );
  });

  it('forwards hide and unhide arguments and clears all hidden bets', async () => {
    const calls = [];
    const handlers = createStateHandlers(
      makeClient({
        hideBet: async (...args) => {
          calls.push(['hide', ...args]);
          return 'hidden';
        },
        unhideBet: async (...args) => {
          calls.push(['unhide', ...args]);
          return 'unhidden';
        },
        clearHiddenBets: async () => {
          calls.push(['clear']);
          return 'cleared';
        }
      })
    );

    const bet = { betId: 'bet-1', matchId: 'game-1', market: 'Moneyline', selection: 'Team A' };
    assert.deepEqual(await handlers.manage_hidden_bets({ action: 'hide', bet }), {
      ok: true,
      action: 'hide',
      result: 'hidden'
    });
    assert.deepEqual(await handlers.manage_hidden_bets({ action: 'unhide', id: 'hidden-1' }), {
      ok: true,
      action: 'unhide',
      result: 'unhidden'
    });
    assert.deepEqual(await handlers.manage_hidden_bets({ action: 'clear' }), {
      ok: true,
      action: 'clear',
      result: 'cleared'
    });
    assert.deepEqual(calls, [['hide', bet], ['unhide', 'hidden-1'], ['clear']]);
  });

  it('returns a clean backend error when the client throws null', async () => {
    const handlers = createStateHandlers(
      makeClient({
        clearHiddenBets: async () => {
          throw null;
        }
      })
    );

    await assert.rejects(
      () => handlers.manage_hidden_bets({ action: 'clear' }),
      (error) => {
        assert.equal(error, null);
        return true;
      }
    );
  });

  it('clears the score timeline and returns confirmation', async () => {
    const handlers = createStateHandlers(makeClient());

    assert.deepEqual(await handlers.clear_score_timeline(), {
      ok: true,
      message: 'Score timeline cache cleared. Tier trajectory data reset.'
    });
  });
});
