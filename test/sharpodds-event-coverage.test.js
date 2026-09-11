'use strict';

// Task 5: SharpOdds event-coverage diagnostics with native PP fallback preserved.
// No live network calls — provider/client fixtures only.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createSharpOddsHistoryProvider } = require('../lib/sharpodds-history-provider');

const TZ = '-0400';
// Jones-Dencheva shape: WTA 125 Total Games, corrected start.
const START = '2026-09-10T09:00:00.000Z';

function tennisRow(overrides = {}) {
  return {
    gameId: 'pp-tennis-1',
    market: 'Total Games',
    pick: 'Over 20.5',
    selection: 'Over 20.5',
    selectionId: 'Total_Games:Over_20.5',
    homeTeam: 'Dencheva',
    awayTeam: 'Jones',
    league: 'Tennis',
    start: START,
    odds: -111,
    liquidityUsd: 500,
    ...overrides
  };
}

function boardClient(board, { onHistory } = {}) {
  return {
    fetchBoard: async () => ({ data: board }),
    fetchHistory: async (params) => {
      if (onHistory) onHistory(params);
      throw new Error('history must not be fetched without a matched event');
    }
  };
}

describe('sharpodds event coverage diagnostics', () => {
  it('returns event_not_covered when the WTA 125 event is absent from the board', async () => {
    let historyCalls = 0;
    const board = [
      {
        id: '111',
        homeTeam: 'Los Angeles Dodgers',
        awayTeam: 'New York Yankees',
        league: 'MLB',
        startTime: '2026-09-01T19:05:00Z',
        books: [{ id: 7, name: 'Pinnacle' }]
      },
      {
        id: '222',
        homeTeam: 'Iga Swiatek',
        awayTeam: 'Aryna Sabalenka',
        league: 'WTA',
        startTime: START,
        books: [{ id: 7, name: 'Pinnacle' }]
      }
    ];
    const provider = createSharpOddsHistoryProvider({
      client: boardClient(board, {
        onHistory: () => {
          historyCalls += 1;
        }
      }),
      timezone: TZ
    });
    const result = await provider.resolve(tennisRow());
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyProvider, 'sharpodds');
    assert.equal(result.historyReason, 'event_not_covered');
    assert.ok(result.historyWarning);
    assert.equal(historyCalls, 0);
  });

  it('keeps event_mismatch for a genuine same-teams time conflict', async () => {
    let historyCalls = 0;
    const board = [
      {
        id: '333',
        homeTeam: 'Dencheva',
        awayTeam: 'Jones',
        league: 'Tennis',
        startTime: '2026-09-01T09:00:00.000Z',
        books: [{ id: 7, name: 'Pinnacle' }]
      }
    ];
    const provider = createSharpOddsHistoryProvider({
      client: boardClient(board, {
        onHistory: () => {
          historyCalls += 1;
        }
      }),
      timezone: TZ
    });
    const result = await provider.resolve(tennisRow());
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyReason, 'event_mismatch');
    assert.equal(historyCalls, 0);
  });
});
