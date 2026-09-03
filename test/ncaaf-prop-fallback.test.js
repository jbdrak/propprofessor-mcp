'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createScreenLeaguesHandlers } = require('../scripts/server/handlers/screen-leagues');

function makeContext() {
  return {
    responseCache: { get: () => null, set: () => {} },
    responseCacheTtlMs: 120000
  };
}

const touchdownPayload = {
  game_data: [
    {
      gameId: 'NCAAF:GAME:Team_A:Team_B:1800000000',
      league: 'NCAAF',
      leagueName: 'NCAAF',
      market: 'Player Touchdowns',
      start: '2026-09-05T00:00:00.000Z',
      homeTeam: 'Team A',
      awayTeam: 'Team B',
      participant: 'Player One',
      defaultKey: '0.5',
      selections: {
        '0.5': {
          selection1: 'Over',
          selection1Id: 'Player_Touchdowns:Player_One_0.5',
          selection2: 'Under',
          selection2Id: 'Player_Touchdowns:Player_One_0.5_Under',
          odds: { DraftKings: { odds1: 120, odds2: -160 } }
        }
      }
    }
  ]
};

describe('NCAAF player-prop discovery', () => {
  it('keeps touchdown rows when the requested NoVigApp target has no prop price', async () => {
    const client = {
      queryPositiveEV: async () => ({ game_data: [] }),
      queryScreenOddsBestComps: async () => touchdownPayload
    };
    const handlers = createScreenLeaguesHandlers(client, makeContext());

    const response = await handlers.runLeagueScreen(
      { market: 'Player Touchdowns', books: ['NoVigApp'], includeAll: true, skipHistory: true },
      'NCAAF'
    );

    assert.equal(response.result.length, 2);
    assert.equal(response.result[0].market, 'Player Touchdowns');
    assert.equal(response.result[0].book, 'DraftKings');
    assert.equal(response.resultMeta.focusBook, 'NoVigApp');
  });
});
