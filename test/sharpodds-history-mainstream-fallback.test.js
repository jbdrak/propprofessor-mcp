'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createSharpOddsHistoryProvider,
  DEFAULT_SHARP_BOOKS,
  DEFAULT_MAINSTREAM_FALLBACK_BOOKS
} = require('../lib/sharpodds-history-provider');

const START = '2026-09-01T19:05:00Z';
const TZ = '-0400';

function boardEvent(overrides = {}) {
  return {
    id: '98765',
    homeTeam: 'Los Angeles Dodgers',
    awayTeam: 'New York Yankees',
    league: 'MLB',
    startTime: START,
    books: [{ id: 7, name: 'Pinnacle' }],
    ...overrides
  };
}

function historyPayload(book) {
  return {
    meta: {
      sportsbook: book,
      period: 'Game',
      away_team: 'New York Yankees',
      home_team: 'Los Angeles Dodgers',
      date: '2026-09-01',
      updated: '2026-09-01T12:00:00Z'
    },
    markets: {
      SPREADS: [],
      TOTALS: [
        { date: '09/01', time: '9:00 AM', away: 'o8.5 -110', home: 'u8.5 -110', pub: null },
        { date: '09/01', time: '12:00 PM', away: 'o8.5 -115', home: 'u8.5 -105', pub: null }
      ],
      MONEYLINES: []
    }
  };
}

const EMPTY_HISTORY = { meta: { date: '2026-09-01' }, markets: { SPREADS: [], TOTALS: [], MONEYLINES: [] } };

function totalRow(overrides = {}) {
  return {
    gameId: 'pp-1',
    market: 'Total Runs',
    pick: 'Over 8.5',
    selection: 'Over 8.5',
    homeTeam: 'Los Angeles Dodgers',
    awayTeam: 'New York Yankees',
    league: 'MLB',
    start: START,
    odds: -110,
    liquidityUsd: 500,
    ...overrides
  };
}

describe('sharpodds mainstream fallback book list', () => {
  it('keeps Pinnacle/Circa/BetOnline as the sharp defaults', () => {
    assert.deepEqual([...DEFAULT_SHARP_BOOKS], ['Pinnacle', 'Circa', 'BetOnline']);
  });

  it('exposes the mainstream fallback list using screen names', () => {
    assert.deepEqual(
      [...DEFAULT_MAINSTREAM_FALLBACK_BOOKS],
      ['FanDuel', 'Bovada', 'BetRivers', 'BallyBet', 'theScore', 'DraftKings', 'BetMGM', 'Fanatics']
    );
  });
});

describe('sharpodds-history-provider mainstream fallback', () => {
  it('short-circuits on usable sharp history without touching fallback books', async () => {
    const calls = [];
    const provider = createSharpOddsHistoryProvider({
      client: {
        fetchBoard: async () => ({
          data: [
            boardEvent({
              books: [
                { id: 7, name: 'Pinnacle' },
                { id: 99, name: 'FanDuel' }
              ]
            })
          ]
        }),
        fetchHistory: async (params) => {
          calls.push(params.bookName);
          return { data: historyPayload(params.bookName) };
        }
      },
      timezone: TZ
    });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, true);
    assert.deepEqual(calls, ['Pinnacle']);
    assert.equal(result.movementSourceBook, 'Pinnacle');
    assert.equal(result.movementMode, 'same_book');
    assert.ok(!('historyBookTier' in result) || result.historyBookTier !== 'mainstream_fallback');
  });

  it('falls back to a mainstream book when no sharp book has usable history', async () => {
    const calls = [];
    const provider = createSharpOddsHistoryProvider({
      client: {
        fetchBoard: async () => ({
          data: [
            boardEvent({
              books: [
                { id: 7, name: 'Pinnacle' },
                { id: 99, name: 'FanDuel' }
              ]
            })
          ]
        }),
        fetchHistory: async (params) => {
          calls.push(params.bookName);
          if (params.bookName === 'Pinnacle') return { data: EMPTY_HISTORY };
          return { data: historyPayload(params.bookName) };
        }
      },
      timezone: TZ
    });
    const result = await provider.resolve(totalRow());
    assert.deepEqual(calls, ['Pinnacle', 'FanDuel']);
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.movementSourceBook, 'FanDuel');
  });

  it('labels fallback history as comparison_book with mainstream provenance', async () => {
    const provider = createSharpOddsHistoryProvider({
      client: {
        fetchBoard: async () => ({
          data: [
            boardEvent({
              books: [
                { id: 7, name: 'Pinnacle' },
                { id: 99, name: 'FanDuel' }
              ]
            })
          ]
        }),
        fetchHistory: async (params) => {
          if (params.bookName === 'Pinnacle') return { data: EMPTY_HISTORY };
          return { data: historyPayload(params.bookName) };
        }
      },
      timezone: TZ
    });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.movementMode, 'comparison_book');
    assert.notEqual(result.movementMode, 'same_book');
    assert.equal(result.historyBookTier, 'mainstream_fallback');
    assert.equal(result.lineHistory.length, 2);
    assert.equal(result.lineHistory[0].line, 8.5);
  });

  it('attempts no history fetch when the board event is event_not_covered', async () => {
    let historyCalls = 0;
    const provider = createSharpOddsHistoryProvider({
      client: {
        fetchBoard: async () => ({
          data: [boardEvent({ coverage: 'event_not_covered', books: [{ id: 99, name: 'FanDuel' }] })]
        }),
        fetchHistory: async () => {
          historyCalls += 1;
          return { data: historyPayload('FanDuel') };
        }
      },
      timezone: TZ
    });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyReason, 'event_not_covered');
    assert.equal(historyCalls, 0);
  });

  it('returns event_not_covered with zero fetches when no board teams overlap', async () => {
    let historyCalls = 0;
    const provider = createSharpOddsHistoryProvider({
      client: {
        fetchBoard: async () => ({ data: [boardEvent()] }),
        fetchHistory: async () => {
          historyCalls += 1;
          return { data: historyPayload('FanDuel') };
        }
      },
      timezone: TZ
    });
    const result = await provider.resolve(totalRow({ homeTeam: 'Boston Red Sox', awayTeam: 'Chicago Cubs' }));
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyReason, 'event_not_covered');
    assert.equal(historyCalls, 0);
  });

  it('returns event_mismatch with zero fetches when teams agree but start time is far away', async () => {
    let historyCalls = 0;
    const provider = createSharpOddsHistoryProvider({
      client: {
        fetchBoard: async () => ({ data: [boardEvent()] }),
        fetchHistory: async () => {
          historyCalls += 1;
          return { data: historyPayload('FanDuel') };
        }
      },
      timezone: TZ
    });
    const result = await provider.resolve(totalRow({ start: '2026-09-10T19:05:00Z' }));
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyReason, 'event_mismatch');
    assert.equal(historyCalls, 0);
  });

  it('fails closed when every sharp and fallback book is unusable', async () => {
    const calls = [];
    const provider = createSharpOddsHistoryProvider({
      client: {
        fetchBoard: async () => ({
          data: [
            boardEvent({
              books: [
                { id: 7, name: 'Pinnacle' },
                { id: 99, name: 'FanDuel' },
                { id: 101, name: 'DraftKings' }
              ]
            })
          ]
        }),
        fetchHistory: async (params) => {
          calls.push(params.bookName);
          return { data: EMPTY_HISTORY };
        }
      },
      timezone: TZ
    });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyReason, 'history_unusable');
    assert.ok(calls.includes('Pinnacle'), 'sharp tier attempted');
    assert.ok(calls.includes('FanDuel'), 'fallback tier attempted');
    assert.ok(calls.indexOf('Pinnacle') < calls.indexOf('FanDuel'), 'sharp books tried before fallbacks');
  });

  it('supports a provider-level fallback-book override', async () => {
    const calls = [];
    const provider = createSharpOddsHistoryProvider({
      client: {
        fetchBoard: async () => ({
          data: [
            boardEvent({
              books: [
                { id: 7, name: 'Pinnacle' },
                { id: 99, name: 'FanDuel' },
                { id: 101, name: 'DraftKings' }
              ]
            })
          ]
        }),
        fetchHistory: async (params) => {
          calls.push(params.bookName);
          if (params.bookName === 'Pinnacle') return { data: EMPTY_HISTORY };
          return { data: historyPayload(params.bookName) };
        }
      },
      fallbackBooks: ['DraftKings'],
      timezone: TZ
    });
    const result = await provider.resolve(totalRow());
    assert.deepEqual(calls, ['Pinnacle', 'DraftKings']);
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.movementSourceBook, 'DraftKings');
    assert.equal(result.historyBookTier, 'mainstream_fallback');
  });

  it('supports a per-resolve fallback-book override', async () => {
    const calls = [];
    const provider = createSharpOddsHistoryProvider({
      client: {
        fetchBoard: async () => ({
          data: [
            boardEvent({
              books: [
                { id: 7, name: 'Pinnacle' },
                { id: 99, name: 'FanDuel' },
                { id: 101, name: 'DraftKings' }
              ]
            })
          ]
        }),
        fetchHistory: async (params) => {
          calls.push(params.bookName);
          if (params.bookName === 'Pinnacle') return { data: EMPTY_HISTORY };
          return { data: historyPayload(params.bookName) };
        }
      },
      timezone: TZ
    });
    const result = await provider.resolve(totalRow(), { fallbackBooks: ['DraftKings'] });
    assert.deepEqual(calls, ['Pinnacle', 'DraftKings']);
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.movementSourceBook, 'DraftKings');
    assert.equal(result.historyBookTier, 'mainstream_fallback');
  });
});
