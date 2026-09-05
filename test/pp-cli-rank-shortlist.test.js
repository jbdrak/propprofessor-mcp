'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cmdRank } = require('../bin/pp-cli');

describe('pp rank history hydration', () => {
  it('enables bounded pre-history shortlisting for broad player-prop ranks', async () => {
    const calls = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      await cmdRank(
        {
          screen_ranked: async (args) => {
            calls.push(args);
            return {
              result: [
                {
                  gameId: 'NCAAF:GAME:A:B:1',
                  awayTeam: 'B',
                  homeTeam: 'A',
                  market: 'Player Touchdowns',
                  selection: 'Player Over 0.5',
                  odds: 120,
                  confidenceTier: 'TIER 1',
                  movementDisposition: 'supportive_clean'
                }
              ]
            };
          }
        },
        ['rank', 'NCAAF'],
        { market: 'Player Touchdowns', book: 'NoVigApp', json: true, limit: '10' }
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].league, 'NCAAF');
    assert.equal(calls[0].market, 'Player Touchdowns');
    assert.equal(calls[0].evFirst, false);
    assert.equal(calls[0].preHistoryShortlist, true);
    assert.equal(calls[0].preHistoryGameBudget, 6);
    assert.equal(calls[0].preHistoryRowBudget, 60);
  });
});
