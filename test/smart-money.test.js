'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');

// Minimal inline client: only what smart_money touches.
function makeClient(smartRows) {
  return {
    querySmartMoney: async () => smartRows
  };
}

const SAMPLE = [
  {
    id: 'WNBA:PREMATCH:Las_Vegas_Aces:Phoenix_Mercury:1783807200:OnyxOdds:Point_Spread:Phoenix_Mercury_+8.5',
    gameId: 'WNBA:PREMATCH:Las_Vegas_Aces:Phoenix_Mercury:1783807200',
    league: 'WNBA',
    market: 'Point Spread',
    selection: 'Phoenix Mercury +8.5',
    subSelection: 'Las Vegas Aces -8.5',
    site: 'OnyxOdds',
    url: 'https://app.onyxodds.com/game/33857-26091-2026-07-11',
    totalLiquidArb: 3090,
    maxArbOdds: 108,
    minArbOdds: 108,
    isLive: false,
    start: '2026-07-11T22:00:00.000Z',
    sportsbookData: [
      { book: 'Bovada', odds: -105 },
      { book: 'DraftKings', odds: -112 }
    ]
  },
  {
    id: 'UFC:PREMATCH:Holloway:Mcgregor:1783797300:NoVigApp:Moneyline:Mcgregor',
    gameId: 'UFC:PREMATCH:Holloway:Mcgregor:1783797300',
    league: 'UFC',
    market: 'Moneyline',
    selection: 'Mcgregor',
    site: 'NoVigApp',
    url: 'https://novig.com/events/xxx',
    totalLiquidArb: 17621,
    maxArbOdds: 277,
    minArbOdds: 277,
    isLive: false,
    start: '2026-07-11T21:00:00.000Z',
    sportsbookData: [{ book: 'Pinnacle', odds: 250 }]
  }
];

describe('smart_money tool (Task 6)', () => {
  it('surfaces volumeUsd + oddsRange per entry, sorted by volume', async () => {
    const handlers = createMcpHandlers({ client: makeClient(SAMPLE) });
    const result = await handlers.smart_money({ leagues: ['WNBA', 'UFC'] });
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    // Sorted by volume desc → UFC (17621) first.
    assert.equal(result.result[0].gameId, 'UFC:PREMATCH:Holloway:Mcgregor:1783797300');
    assert.equal(result.result[0].volumeUsd, 17621);
    assert.deepEqual(result.result[0].oddsRange, { min: 277, max: 277 });
    // WNBA entry
    const wnba = result.result[1];
    assert.equal(wnba.volumeUsd, 3090);
    assert.deepEqual(wnba.oddsRange, { min: 108, max: 108 });
    assert.equal(wnba.sportsbookCount, 2);
    // resultMeta rolls up total volume
    assert.equal(result.resultMeta.volumeTotalUsd, 17621 + 3090);
  });

  it('returns a clean error envelope when the backend fails', async () => {
    const handlers = createMcpHandlers({
      client: {
        querySmartMoney: async () => {
          throw new Error('backend down');
        }
      }
    });
    const result = await handlers.smart_money({});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SMART_MONEY_FAILED');
    assert.match(result.error.message, /backend down/);
  });

  it('handles an empty smart-money feed', async () => {
    const handlers = createMcpHandlers({ client: makeClient([]) });
    const result = await handlers.smart_money({});
    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
    assert.equal(result.resultMeta.volumeTotalUsd, 0);
  });

  it('audit fix 2026-07-11: does not pass sportsbooks: undefined to backend (causes 400 "Invalid sportsbooks value")', async () => {
    let capturedFilters = null;
    const client = {
      querySmartMoney: async (filters) => {
        capturedFilters = filters;
        return [];
      }
    };
    const handlers = createMcpHandlers({ client });
    await handlers.smart_money({ leagues: ['MLB'] });
    // The handler must NOT include `sportsbooks: undefined` (or any falsy value)
    // in the filter — the live backend rejects with HTTP 400.
    assert.equal(
      'sportsbooks' in capturedFilters,
      false,
      'sportsbooks key must be absent (not undefined) so client defaults apply'
    );
    assert.equal('marketTypes' in capturedFilters, false, 'marketTypes also omitted when not set');
  });

  it('passes sportsbooks when explicitly provided', async () => {
    let capturedFilters = null;
    const client = {
      querySmartMoney: async (f) => {
        capturedFilters = f;
        return [];
      }
    };
    const handlers = createMcpHandlers({ client });
    await handlers.smart_money({ leagues: ['MLB'], sportsbooks: ['DraftKings', 'FanDuel'] });
    assert.deepEqual(capturedFilters.sportsbooks, ['DraftKings', 'FanDuel']);
  });
});
