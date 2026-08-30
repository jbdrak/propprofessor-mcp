'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { recoverStandardTotals } = require('../scripts/server/handlers/totals-recovery');

describe('standard totals recovery', () => {
  it('recovers ranked rows with a bounded single-market request', async () => {
    let call;
    const rows = [
      { gameId: 'MLB:game', market: 'Total Runs', selection: 'Over 8.5' },
      { gameId: 'MLB:game', market: 'Total Runs', selection: 'Over 7.5', altLineFiltered: true }
    ];
    const result = await recoverStandardTotals({
      runLeagueScreen: async (args, league) => {
        call = { args, league };
        return { result: rows };
      },
      league: 'MLB',
      market: 'Total Runs',
      targetBooks: ['NoVigApp'],
      scanLimit: 25,
      lookbackHours: 6
    });
    assert.deepEqual(result, [rows[0]]);
    assert.deepEqual(call, {
      args: {
        books: ['NoVigApp'],
        market: 'Total Runs',
        scanLimit: 25,
        limit: 25,
        lookbackHours: 6,
        is_live: false,
        cardWindow: 'all',
        includeAll: true,
        includePasses: true,
        playableOnly: false,
        evFirst: false,
        compact: false,
        includeResearch: false
      },
      league: 'MLB'
    });
  });

  it('returns null when ranked recovery has no rows', async () => {
    const result = await recoverStandardTotals({
      runLeagueScreen: async () => ({ result: [] }),
      league: 'MLB',
      market: 'Total Runs',
      targetBooks: ['NoVigApp'],
      scanLimit: 25,
      lookbackHours: 6
    });
    assert.equal(result, null);
  });

  it('does not call a missing recovery function', async () => {
    assert.equal(await recoverStandardTotals({ league: 'MLB', market: 'Total Runs' }), null);
  });
});
