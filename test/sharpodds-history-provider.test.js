'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createSharpOddsClient } = require('../lib/sharpodds-client');
const {
  createSharpOddsHistoryProvider,
  DEFAULT_SHARP_BOOKS,
  mapRowMarket
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

function totalHistoryPayload() {
  return {
    meta: {
      sportsbook: 'Pinnacle',
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

function fakeClient({ board = [boardEvent()], history = totalHistoryPayload(), onBoard, onHistory, historyError } = {}) {
  return {
    fetchBoard: async (...args) => {
      if (onBoard) onBoard(args);
      return { data: board };
    },
    fetchHistory: async (params) => {
      if (onHistory) onHistory(params);
      if (historyError) throw historyError;
      return { data: history };
    }
  };
}

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

describe('sharpodds-history-provider market mapping', () => {
  it('maps only standard main markets', () => {
    assert.equal(mapRowMarket('Moneyline'), 'ML');
    assert.equal(mapRowMarket('Point Spread'), 'SPREAD');
    assert.equal(mapRowMarket('Run Line'), 'SPREAD');
    assert.equal(mapRowMarket('Puck Line'), 'SPREAD');
    assert.equal(mapRowMarket('Game Handicap'), 'SPREAD');
    assert.equal(mapRowMarket('Total Games'), 'TOTAL');
    assert.equal(mapRowMarket('Total Points'), 'TOTAL');
    assert.equal(mapRowMarket('Total Runs'), 'TOTAL');
    assert.equal(mapRowMarket('Total Goals'), 'TOTAL');
  });

  it('leaves unknown and segmented markets unmapped', () => {
    assert.equal(mapRowMarket('Grand Salami'), null);
    assert.equal(mapRowMarket('First 5 Innings'), null);
    assert.equal(mapRowMarket('1st Half Spread'), null);
    assert.equal(mapRowMarket(''), null);
    assert.equal(mapRowMarket(null), null);
  });

  it('exposes Pinnacle-first sharp book defaults', () => {
    assert.equal(DEFAULT_SHARP_BOOKS[0], 'Pinnacle');
  });
});

describe('sharpodds-history-provider resolve', () => {
  it('returns usable total history with the required provider fields', async () => {
    const provider = createSharpOddsHistoryProvider({ client: fakeClient(), timezone: TZ });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.lineHistorySource, 'sharpodds');
    assert.equal(result.historyProvider, 'sharpodds');
    assert.equal(result.historyGameId, '98765');
    assert.equal(result.historyMatchedBy, 'sharpodds_event');
    assert.deepEqual(result.historySportsbooksRequested, ['Pinnacle']);
    assert.equal(result.movementSourceBook, 'Pinnacle');
    assert.equal(result.movementMode, 'same_book');
    assert.equal(result.lineFieldMissingCount, 0);
    assert.equal(result.lineHistory.length, 2);
    for (const point of result.lineHistory) {
      assert.ok(point.time, 'point carries a timestamp');
      assert.equal(point.book, 'Pinnacle');
      assert.equal(point.liquidity, null);
      assert.ok(!('moneyPct' in point) && !('ticketsPct' in point), 'no invented percentages');
    }
    assert.equal(result.lineHistory[0].line, 8.5);
  });

  it('rejects history when every returned line differs from the requested line', async () => {
    const history = totalHistoryPayload();
    history.markets.TOTALS = history.markets.TOTALS.map((point) => ({
      ...point,
      away: point.away.replace('8.5', '9.5'),
      home: point.home.replace('8.5', '9.5')
    }));
    const provider = createSharpOddsHistoryProvider({ client: fakeClient({ history }), timezone: TZ });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyReason, 'line_mismatch');
    assert.match(result.historyWarning, /8\.5/);
  });

  it('resolves a moneyline row through the away column', async () => {
    const history = {
      meta: { sportsbook: 'Pinnacle', period: 'Game', away_team: 'NYY', home_team: 'LAD', date: '2026-09-01', updated: '2026-09-01T12:00:00Z' },
      markets: {
        MONEYLINES: [
          { date: '09/01', time: '9:00 AM', away: '-150', home: '+130', pub: null },
          { date: '09/01', time: '12:00 PM', away: '-160', home: '+140', pub: null }
        ]
      }
    };
    const provider = createSharpOddsHistoryProvider({ client: fakeClient({ history }), timezone: TZ });
    const result = await provider.resolve(totalRow({ market: 'Moneyline', pick: 'New York Yankees', selection: 'New York Yankees' }));
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.lineHistory[0].odds, -150);
  });

  it('maps the requested side when the SharpOdds board reverses home and away', async () => {
    const history = {
      meta: {
        sportsbook: 'Pinnacle',
        period: 'Game',
        away_team: 'Los Angeles Dodgers',
        home_team: 'New York Yankees',
        date: '2026-09-01',
        updated: '2026-09-01T12:00:00Z'
      },
      markets: {
        MONEYLINES: [
          { date: '09/01', time: '9:00 AM', away: '-150', home: '+130', pub: null },
          { date: '09/01', time: '12:00 PM', away: '-160', home: '+140', pub: null }
        ]
      }
    };
    const board = [
      boardEvent({ homeTeam: 'New York Yankees', awayTeam: 'Los Angeles Dodgers' })
    ];
    const provider = createSharpOddsHistoryProvider({ client: fakeClient({ board, history }), timezone: TZ });
    const result = await provider.resolve(
      totalRow({ market: 'Moneyline', pick: 'Los Angeles Dodgers', selection: 'Los Angeles Dodgers' })
    );
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.lineHistory[0].odds, -150);
  });

  it('keeps total over/under columns stable when the SharpOdds board reverses teams', async () => {
    const board = [boardEvent({ homeTeam: 'New York Yankees', awayTeam: 'Los Angeles Dodgers' })];
    const history = {
      meta: {
        sportsbook: 'Pinnacle',
        period: 'Game',
        away_team: 'Los Angeles Dodgers',
        home_team: 'New York Yankees',
        date: '2026-09-01'
      },
      markets: {
        TOTALS: [
          { date: '09/01', time: '9:00 AM', away: 'o8.5 -110', home: 'u8.5 +100', pub: null },
          { date: '09/01', time: '12:00 PM', away: 'o8.5 -115', home: 'u8.5 +105', pub: null }
        ]
      }
    };
    const provider = createSharpOddsHistoryProvider({ client: fakeClient({ board, history }), timezone: TZ });
    const [over, under] = await Promise.all([
      provider.resolve(totalRow({ pick: 'Over 8.5', selection: 'Over 8.5' })),
      provider.resolve(totalRow({ pick: 'Under 8.5', selection: 'Under 8.5' }))
    ]);
    assert.equal(over.lineHistory[0].odds, -110);
    assert.equal(under.lineHistory[0].odds, 100);
  });

  it('rejects history metadata for a different fixture', async () => {
    const history = {
      meta: {
        sportsbook: 'Pinnacle',
        period: 'Game',
        away_team: 'Boston Red Sox',
        home_team: 'New York Mets',
        date: '2026-09-01',
        updated: '2026-09-01T12:00:00Z'
      },
      markets: {
        TOTALS: [
          { date: '09/01', time: '9:00 AM', away: 'o8.5 -110', home: 'u8.5 -110', pub: null },
          { date: '09/01', time: '12:00 PM', away: 'o8.5 -115', home: 'u8.5 -105', pub: null }
        ]
      }
    };
    const provider = createSharpOddsHistoryProvider({ client: fakeClient({ history }), timezone: TZ });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyReason, 'history_identity_mismatch');
  });

  it('returns unavailable for unsupported markets without fetching history', async () => {
    let historyCalls = 0;
    const provider = createSharpOddsHistoryProvider({
      client: fakeClient({ onHistory: () => { historyCalls += 1; } }),
      timezone: TZ
    });
    const result = await provider.resolve(totalRow({ market: 'Grand Salami', pick: 'Over 100' }));
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyProvider, 'sharpodds');
    assert.equal(result.historyReason, 'market_unsupported');
    assert.ok(result.historyWarning);
    assert.equal(historyCalls, 0);
  });

  it('returns unavailable for non-full-game segments', async () => {
    const provider = createSharpOddsHistoryProvider({ client: fakeClient(), timezone: TZ });
    const result = await provider.resolve(totalRow({ market: 'Moneyline', segment: '1st-half' }));
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyReason, 'segment_unsupported');
  });

  it('returns event_mismatch when no board event matches', async () => {
    let historyCalls = 0;
    const provider = createSharpOddsHistoryProvider({
      client: fakeClient({ onHistory: () => { historyCalls += 1; } }),
      timezone: TZ
    });
    const result = await provider.resolve(totalRow({ homeTeam: 'Boston Red Sox', awayTeam: 'Chicago Cubs' }));
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyReason, 'event_mismatch');
    assert.equal(historyCalls, 0);
  });

  it('fetches the board once for multiple rows in one lookup', async () => {
    let boardCalls = 0;
    let historyCalls = 0;
    const provider = createSharpOddsHistoryProvider({
      client: fakeClient({ onBoard: () => { boardCalls += 1; }, onHistory: () => { historyCalls += 1; } }),
      timezone: TZ
    });
    const [over, under] = await Promise.all([
      provider.resolve(totalRow()),
      provider.resolve(totalRow({ pick: 'Under 8.5', selection: 'Under 8.5' }))
    ]);
    assert.equal(over.lineHistoryAvailable, true);
    assert.equal(under.lineHistoryAvailable, true);
    assert.equal(boardCalls, 1);
    assert.equal(historyCalls, 2);
  });

  it('returns unavailable (not a throw) on client timeout', async () => {
    const timeout = new Error('sharpodds-client: request timed out after 50ms');
    timeout.provider = 'sharpodds';
    timeout.category = 'timeout';
    const provider = createSharpOddsHistoryProvider({ client: fakeClient({ historyError: timeout }), timezone: TZ });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyReason, 'timeout');
  });

  it('rethows explicitly fatal client errors', async () => {
    const fatal = new Error('boom');
    fatal.fatal = true;
    const provider = createSharpOddsHistoryProvider({ client: fakeClient({ historyError: fatal }), timezone: TZ });
    await assert.rejects(() => provider.resolve(totalRow()), /boom/);
  });

  it('returns history_unusable for empty provider history', async () => {
    const history = { meta: { date: '2026-09-01' }, markets: { SPREADS: [], TOTALS: [], MONEYLINES: [] } };
    const provider = createSharpOddsHistoryProvider({ client: fakeClient({ history }), timezone: TZ });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyReason, 'history_unusable');
  });

  it('resolves through the live nested board shape with the root book map', async () => {
    let seenParams;
    const board = {
      data: [
        {
          league: 'NFL',
          games: [
            { id: '111', homeTeam: 'Dallas Cowboys', awayTeam: 'Philadelphia Eagles', startTime: '2026-09-01T20:00:00Z' }
          ]
        },
        {
          league: 'MLB',
          games: [
            { id: '98765', homeTeam: 'Los Angeles Dodgers', awayTeam: 'New York Yankees', startTime: START }
          ]
        }
      ],
      books: { 0: { id: 25, name: 'Pinnacle' }, 1: { id: 31, name: 'BetOnline' } }
    };
    const provider = createSharpOddsHistoryProvider({
      client: fakeClient({ board, onHistory: (params) => { seenParams = params; } }),
      timezone: TZ
    });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.historyGameId, '98765');
    assert.equal(result.movementSourceBook, 'Pinnacle');
    assert.deepEqual(result.historySportsbooksRequested, ['Pinnacle']);
    assert.equal(seenParams.gameId, '98765');
    assert.equal(seenParams.bookId, 25);
    assert.equal(seenParams.bookName, 'Pinnacle');
    assert.equal(seenParams.league, 'MLB');
  });

  it('converts America/Chicago to the DST-aware numeric offset (September)', async () => {
    let seenParams;
    const provider = createSharpOddsHistoryProvider({
      client: fakeClient({ onHistory: (params) => { seenParams = params; } }),
      timezone: 'America/Chicago'
    });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(seenParams.timezone, '-0500');
    assert.equal(seenParams.date, '2026-09-01');
  });

  it('converts America/Chicago to standard time in January', async () => {
    const janStart = '2026-01-15T19:05:00Z';
    const history = {
      meta: { sportsbook: 'Pinnacle', period: 'Game', away_team: 'NYY', home_team: 'LAD', date: '2026-01-15', updated: '2026-01-15T12:00:00Z' },
      markets: {
        TOTALS: [
          { date: '01/15', time: '9:00 AM', away: 'o8.5 -110', home: 'u8.5 -110', pub: null },
          { date: '01/15', time: '12:00 PM', away: 'o8.5 -115', home: 'u8.5 -105', pub: null }
        ]
      }
    };
    let seenParams;
    const provider = createSharpOddsHistoryProvider({
      client: fakeClient({
        board: [boardEvent({ startTime: janStart })],
        history,
        onHistory: (params) => { seenParams = params; }
      }),
      timezone: 'America/Chicago'
    });
    const result = await provider.resolve(totalRow({ start: janStart }));
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(seenParams.timezone, '-0600');
    assert.equal(seenParams.date, '2026-01-15');
  });

  it('fails closed on an unconvertible IANA timezone', async () => {
    let boardCalls = 0;
    const provider = createSharpOddsHistoryProvider({
      client: fakeClient({ onBoard: () => { boardCalls += 1; } }),
      timezone: 'Mars/Olympus_Mons'
    });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyReason, 'timezone_unknown');
    assert.equal(boardCalls, 0);
  });

  it('defaults to the PP local timezone instead of the machine zone', async () => {
    if (process.env.LOCAL_TIMEZONE) return;
    let seenParams;
    const provider = createSharpOddsHistoryProvider({
      client: fakeClient({ onHistory: (params) => { seenParams = params; } })
    });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(seenParams.timezone, '-0500');
  });

  it('falls through to the next sharp book when the first book has unusable history', async () => {
    const calls = [];
    const empty = { meta: { date: '2026-09-01' }, markets: { SPREADS: [], TOTALS: [], MONEYLINES: [] } };
    const provider = createSharpOddsHistoryProvider({
      client: {
        fetchBoard: async () => ({ data: [boardEvent({ books: [{ id: 7, name: 'Pinnacle' }, { id: 41, name: 'Circa' }] })] }),
        fetchHistory: async (params) => {
          calls.push(params.bookName);
          if (params.bookName === 'Pinnacle') return { data: empty };
          const fallbackHistory = totalHistoryPayload();
          fallbackHistory.meta.sportsbook = params.bookName;
          return { data: fallbackHistory };
        }
      },
      timezone: TZ
    });

    const result = await provider.resolve(totalRow());
    assert.deepEqual(calls, ['Pinnacle', 'Circa']);
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.movementSourceBook, 'Circa');
    assert.deepEqual(result.historySportsbooksRequested, ['Circa']);
  });

  it('prefers Pinnacle over other listed sharp books and passes its bid', async () => {
    let seenParams;
    const provider = createSharpOddsHistoryProvider({
      client: fakeClient({
        board: [boardEvent({ books: [{ id: 9, name: 'BetOnline' }, { id: 7, name: 'Pinnacle' }] })],
        onHistory: (params) => { seenParams = params; }
      }),
      timezone: TZ
    });
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, true);
    assert.equal(result.movementSourceBook, 'Pinnacle');
    assert.deepEqual(result.historySportsbooksRequested, ['Pinnacle']);
    assert.equal(seenParams.bookName, 'Pinnacle');
    assert.equal(seenParams.bookId, 7);
  });

  it('returns provider_misconfigured without a valid client', async () => {
    const provider = createSharpOddsHistoryProvider({});
    const result = await provider.resolve(totalRow());
    assert.equal(result.lineHistoryAvailable, false);
    assert.equal(result.historyReason, 'provider_misconfigured');
  });

  it('sends an exact history query with no sport-id map via the real client', async () => {
    const spreadPayload = () => ({
      meta: {
        sportsbook: 'Pinnacle',
        period: 'Game',
        away_team: 'New York Yankees',
        home_team: 'Los Angeles Dodgers',
        date: '2026-09-01',
        updated: '2026-09-01T12:00:00Z'
      },
      markets: {
        SPREADS: [
          { date: '09/01', time: '9:00 AM', away: '+1.5 -110', home: '-1.5 -110', pub: null },
          { date: '09/01', time: '12:00 PM', away: '+1.5 -115', home: '-1.5 -105', pub: null }
        ],
        TOTALS: [],
        MONEYLINES: []
      }
    });
    let seenUrl;
    const fetchImpl = async (url) => {
      seenUrl = String(url);
      if (new URL(seenUrl).searchParams.get('action') === 'linehistory') {
        return { ok: true, status: 200, json: async () => spreadPayload() };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: '98765',
              homeTeam: 'Los Angeles Dodgers',
              awayTeam: 'New York Yankees',
              league: 'MLB',
              startTime: '2026-09-01T19:05:00Z',
              books: [{ id: 7, name: 'Pinnacle' }]
            }
          ]
        })
      };
    };
    const client = createSharpOddsClient({ fetchImpl });
    const provider = createSharpOddsHistoryProvider({ client, timezone: TZ });
    const result = await provider.resolve(totalRow({ market: 'Run Line', pick: 'New York Yankees +1.5', selection: 'New York Yankees +1.5' }));
    assert.equal(result.lineHistoryAvailable, true);
    const query = new URL(seenUrl).searchParams;
    assert.equal(query.get('action'), 'linehistory');
    assert.equal(query.get('t'), 'SPREAD');
    assert.equal(query.get('d'), '2026-09-01');
    assert.equal(query.get('n'), '98765');
    assert.equal(query.get('p'), '0');
    assert.equal(query.get('z'), TZ);
    assert.equal(query.get('sn'), 'Pinnacle');
    assert.equal(query.get('bid'), '7');
    assert.equal(query.get('league'), 'MLB');
    assert.equal(query.get('s'), null);
  });
});
