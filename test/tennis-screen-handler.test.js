'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTennisScreenHandler } = require('../scripts/server/handlers/tennis-screen');

function makeCache() {
  const values = new Map();
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value)
  };
}

function makeHandler(client) {
  return createTennisScreenHandler(client, {
    responseCache: makeCache(),
    responseCacheTtlMs: 60_000
  });
}

describe('Tennis screen handler fallback', () => {
  it('returns a truthful empty response when screen and +EV have no tennis rows', async () => {
    const calls = [];
    const handlers = makeHandler({
      queryScreenOdds: async (args) => {
        calls.push(['screen', args]);
        return { game_data: [] };
      },
      querySportsbook: async (args) => {
        calls.push(['ev', args]);
        return [];
      }
    });

    const result = await handlers.runTennisScreen({ market: 'Moneyline' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.result, []);
    assert.equal(result.resultMeta.source, 'fallback_empty');
    assert.match(result.warning, /no tennis candidates in the requested card window/i);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'screen');
    assert.equal(calls[1][0], 'ev');
  });

  it('filters screen rows by the requested tournament name', async () => {
    const handlers = makeHandler({
      queryScreenOdds: async () => ({
        game_data: [
          {
            gameId: 'us-open-game',
            league: 'Tennis',
            leagueName: 'US Open',
            market: 'Moneyline',
            updatedAt: new Date().toISOString(),
            selections: {
              a: {
                selection1: 'Player A',
                participant1: 'Player A',
                selection2: 'Player B',
                participant2: 'Player B',
                odds: { Pinnacle: { odds1: -120, odds2: 100 } }
              }
            },
            defaultKey: 'a'
          },
          {
            gameId: 'other-game',
            league: 'Tennis',
            leagueName: 'ATP Cincinnati',
            market: 'Moneyline',
            updatedAt: new Date().toISOString(),
            selections: {
              a: {
                selection1: 'Player C',
                participant1: 'Player C',
                selection2: 'Player D',
                participant2: 'Player D',
                odds: { Pinnacle: { odds1: -120, odds2: 100 } }
              }
            },
            defaultKey: 'a'
          }
        ]
      })
    });

    const result = await handlers.runTennisScreen({ market: 'Moneyline', leagueName: 'US Open' });

    assert.ok(result.result.length > 0);
    assert.ok(result.result.every((row) => row.gameId === 'us-open-game'));
  });

  it('keeps the fallback envelope intact when +EV throws a non-Error value', async () => {
    const handlers = makeHandler({
      queryScreenOdds: async () => ({ game_data: [] }),
      querySportsbook: async () => {
        throw null;
      }
    });

    const result = await handlers.runTennisScreen({ market: 'Total Games' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.result, []);
    assert.equal(result.resultMeta.source, 'fallback_empty');
    assert.match(result.warning, /No tennis data available/);
  });
});
