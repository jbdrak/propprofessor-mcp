'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runEvFirst } = require('../scripts/server/handlers/screen-leagues');

describe('EV-first league screen', () => {
  it('uses the all-value sportsbook feed so negative-EV rows reach history validation', async () => {
    let positiveEvCalls = 0;
    let sportsbookRequest = null;
    const result = await runEvFirst(
      {
        queryPositiveEV: async () => {
          positiveEvCalls += 1;
          return { rows: [{ selection: 'positive-only' }] };
        },
        querySportsbook: async (request) => {
          sportsbookRequest = request;
          return {
            rows: [
              {
                league: 'MLB',
                market: 'Total Runs',
                book: 'NoVigApp',
                participant: 'Under 7.5',
                selection: 'Under 7.5',
                game: 'Athletics vs Mariners',
                odds: -120,
                value: -0.6
              }
            ]
          };
        },
        queryOddsHistory: async () => []
      },
      { books: ['NoVigApp'], limit: 5 },
      'MLB',
      'Total Runs',
      ['NoVigApp']
    );

    assert.equal(positiveEvCalls, 0);
    assert.equal(sportsbookRequest.minValue, -9999);
    assert.ok(result);
    assert.equal(result.result[0].selection, 'Under 7.5');
  });

  it('uses validated EV rows before the screen fallback', async () => {
    let screenCalls = 0;
    const result = await runEvFirst(
      {
        querySportsbook: async () => [
          {
            league: 'NBA',
            market: 'Moneyline',
            book: 'NoVigApp',
            participant: 'Lakers',
            selection: 'Lakers',
            game: 'Lakers vs Celtics',
            odds: -110
          }
        ],
        queryOddsHistory: async () => ({})
      },
      { books: ['NoVigApp'], limit: 5 },
      'NBA',
      'Moneyline',
      ['NoVigApp']
    );
    assert.ok(result);
    assert.equal(result.resultMeta.source, 'ev_first');
    assert.equal(result.result[0].discoverySource, 'ev_board');
    assert.equal(screenCalls, 0);
  });

  it('does not run EV recovery for no-history probes', async () => {
    let called = false;
    const result = await runEvFirst(
      {
        querySportsbook: async () => {
          called = true;
          return [];
        }
      },
      { skipHistory: true },
      'NBA',
      'Moneyline',
      []
    );
    assert.equal(result, null);
    assert.equal(called, false);
  });
});
