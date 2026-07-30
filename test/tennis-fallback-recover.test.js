'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { recoverTennisFromScreen } = require('../lib/tennis-fallback');

const NOW_SEC = Math.floor(Date.now() / 1000);
const HOUR = 3600;

/**
 * Build odds history that produces a target CLV for the given odds.
 * Returns pin prices moving from baseOdds → targetOdds over 6 hours
 * so computeClvFromHistory yields approximately the desired prob delta.
 */
function supportiveHistory(baseOdds, targetOdds) {
  return {
    Pinnacle: [
      { odds: baseOdds, start_ts: NOW_SEC - 6 * HOUR },
      { odds: targetOdds, start_ts: NOW_SEC }
    ],
    Circa: [
      { odds: baseOdds, start_ts: NOW_SEC - 6 * HOUR },
      { odds: targetOdds, start_ts: NOW_SEC - 2 * HOUR },
      { odds: targetOdds, start_ts: NOW_SEC }
    ],
    NoVigApp: [
      { odds: baseOdds, start_ts: NOW_SEC - 4 * HOUR },
      { odds: targetOdds, start_ts: NOW_SEC }
    ]
  };
}

/**
 * Market-specific screen data builders.
 * RecoverTennisFromScreen iterates [Moneyline, Game Handicap, Total Games]
 * and calls queryScreenOdds once per market — so we need to return only
 * the selections relevant to the requested market.
 */

const MARKET_FIXTURES = {
  Moneyline: {
    game_data: [
      {
        gameId: 'tennis-20260730-djokovic-alcaraz',
        awayTeam: 'Novak Djokovic',
        homeTeam: 'Carlos Alcaraz',
        start: '2026-07-30T18:00:00Z',
        selections: {
          ml: {
            selection1: 'Novak Djokovic',
            selection1Id: 'Moneyline:Novak_Djokovic',
            participant1: 'Novak Djokovic',
            selection2: 'Carlos Alcaraz',
            selection2Id: 'Moneyline:Carlos_Alcaraz',
            participant2: 'Carlos Alcaraz',
            odds: {
              Pinnacle: { odds1: -163, odds2: 133 }
            }
          }
        }
      }
    ]
  },
  'Game Handicap': {
    game_data: [
      {
        gameId: 'tennis-20260730-djokovic-alcaraz',
        awayTeam: 'Novak Djokovic',
        homeTeam: 'Carlos Alcaraz',
        start: '2026-07-30T18:00:00Z',
        selections: {
          gh_standard: {
            selection1: 'Novak Djokovic -1.5',
            selection1Id: 'Game_Handicap:Novak_Djokovic_-1.5',
            participant1: 'Novak Djokovic',
            selection2: 'Carlos Alcaraz +1.5',
            selection2Id: 'Game_Handicap:Carlos_Alcaraz_+1.5',
            participant2: 'Carlos Alcaraz',
            odds: {
              Pinnacle: { odds1: -110, odds2: -110 }
            }
          },
          gh_standard_25: {
            selection1: 'Novak Djokovic -2.5',
            selection1Id: 'Game_Handicap:Novak_Djokovic_-2.5',
            participant1: 'Novak Djokovic',
            selection2: 'Carlos Alcaraz +2.5',
            selection2Id: 'Game_Handicap:Carlos_Alcaraz_+2.5',
            participant2: 'Carlos Alcaraz',
            odds: {
              Pinnacle: { odds1: -105, odds2: -115 }
            }
          },
          gh_expanded: {
            selection1: 'Novak Djokovic -4.5',
            selection1Id: 'Game_Handicap:Novak_Djokovic_-4.5',
            participant1: 'Novak Djokovic',
            selection2: 'Carlos Alcaraz +4.5',
            selection2Id: 'Game_Handicap:Carlos_Alcaraz_+4.5',
            participant2: 'Carlos Alcaraz',
            odds: {
              Pinnacle: { odds1: -110, odds2: -110 }
            }
          }
        }
      }
    ]
  },
  'Total Games': {
    game_data: [
      {
        gameId: 'tennis-20260730-djokovic-alcaraz',
        awayTeam: 'Novak Djokovic',
        homeTeam: 'Carlos Alcaraz',
        start: '2026-07-30T18:00:00Z',
        selections: {
          tg: {
            selection1: 'Over 22.5',
            selection1Id: 'Total_Games:Over_22.5',
            participant1: 'Over 22.5',
            selection2: 'Under 22.5',
            selection2Id: 'Total_Games:Under_22.5',
            participant2: 'Under 22.5',
            odds: {
              Pinnacle: { odds1: -110, odds2: -110 }
            }
          }
        }
      }
    ]
  }
};

// History keyed by selectionId
// Djokovic ML: -150 → -175 = IP 60% → 63.64% = +3.64% CLV → supportive_clean
// Alcaraz ML: CLV inverted → adverse_full
// GH -1.5: -110 → -130 = IP 52.38% → 56.52% = +4.14% CLV → supportive_clean
// GH -2.5: -105 → -120 = IP 51.22% → 54.55% = +3.33% CLV → supportive_clean
// GH -4.5: would be filtered
// Total Games Over: -110 → -125 = IP 52.38% → 55.56% = +3.18% CLV → supportive_clean
const TENNIS_HISTORY = {
  'Moneyline:Novak_Djokovic': supportiveHistory(-150, -175),
  'Game_Handicap:Novak_Djokovic_-1.5': supportiveHistory(-110, -130),
  'Game_Handicap:Novak_Djokovic_-2.5': supportiveHistory(-105, -120),
  'Game_Handicap:Novak_Djokovic_-4.5': supportiveHistory(-110, -130),
  'Total_Games:Over_22.5': supportiveHistory(-110, -125)
};

/**
 * Factory: creates a mock client for a single tennis game.
 * Returns market-specific screen data per queryScreenOdds call.
 */
function createMockClient() {
  const calls = { screen: [], history: [] };
  const client = {
    calls,
    queryScreenOdds(filters) {
      calls.screen.push(filters);
      const market = filters.market || 'Moneyline';
      const fixture = MARKET_FIXTURES[market] || { game_data: [] };
      return Promise.resolve(JSON.parse(JSON.stringify(fixture)));
    },
    queryOddsHistory({ gameId, selectionId }) {
      calls.history.push({ gameId, selectionId });
      const hist = TENNIS_HISTORY[selectionId];
      return Promise.resolve(hist || {});
    }
  };
  return client;
}

describe('recoverTennisFromScreen — opposite sides', () => {
  let client;

  before(() => {
    client = createMockClient();
  });

  it('selection1 with supportive CLV gets BET, selection2 (inverted) gets CONSIDER', async () => {
    const plays = await recoverTennisFromScreen({ client, book: 'Pinnacle', skipTimeCorrection: true });
    const mlPlays = plays.filter((p) => p.market === 'Moneyline');
    assert.equal(mlPlays.length, 2, 'both moneyline sides should be present');

    const djokovic = mlPlays.find((p) => p.selection === 'Novak Djokovic');
    const alcaraz = mlPlays.find((p) => p.selection === 'Carlos Alcaraz');

    assert.ok(djokovic, 'Djokovic ML should exist');
    assert.ok(alcaraz, 'Alcaraz ML should exist');

    // Djokovic odds moved from -150 → -175 (more favored) = supportive_clean
    assert.equal(djokovic.verdict, 'BET', 'Djokovic with supportive CLV should be BET');
    assert.ok(
      djokovic.movementDisposition.includes('supportive'),
      `Djokovic movement should be supportive, got ${djokovic.movementDisposition}`
    );

    // Alcaraz is opposite side: CLV inverted from Djokovic's positive → negative
    assert.equal(alcaraz.verdict, 'CONSIDER', 'Alcaraz (inverted adverse) should be CONSIDER');
  });
});

describe('recoverTennisFromScreen — expensive moneyline preserved', () => {
  let client;

  before(() => {
    client = createMockClient();
  });

  it('preserves Moneyline with odds +133 / -163 (exceeds old ±150 band)', async () => {
    const plays = await recoverTennisFromScreen({ client, book: 'Pinnacle', skipTimeCorrection: true });
    const mlPlays = plays.filter((p) => p.market === 'Moneyline');
    assert.equal(mlPlays.length, 2, 'expensive moneyline should be preserved (both sides)');

    const djokovic = mlPlays.find((p) => p.selection === 'Novak Djokovic');
    const alcaraz = mlPlays.find((p) => p.selection === 'Carlos Alcaraz');
    assert.ok(djokovic, 'Djokovic should exist');
    assert.ok(alcaraz, 'Alcaraz should exist');
    assert.equal(djokovic.odds, -163, 'Djokovic odds should be -163');
    assert.equal(alcaraz.odds, 133, 'Alcaraz odds should be +133');

    // Also verify: no CONSIDER-only play has odds outside ±150 just from being dropped
    const allMlOdds = mlPlays.map((p) => p.odds);
    assert.ok(allMlOdds.includes(-163), '-163 should be in moneyline odds');
    assert.ok(allMlOdds.includes(133), '+133 should be in moneyline odds');
  });
});

describe('recoverTennisFromScreen — alternate line filtering', () => {
  let client;

  before(() => {
    client = createMockClient();
  });

  it('keeps standard Game Handicap ±1.5', async () => {
    const plays = await recoverTennisFromScreen({ client, book: 'Pinnacle', skipTimeCorrection: true });
    const gh15 = plays.filter((p) => p.selection === 'Novak Djokovic -1.5' || p.selection === 'Carlos Alcaraz +1.5');
    assert.equal(gh15.length, 2, 'standard GH ±1.5 should be kept');
  });

  it('keeps standard Game Handicap ±2.5', async () => {
    const plays = await recoverTennisFromScreen({ client, book: 'Pinnacle', skipTimeCorrection: true });
    const gh25 = plays.filter((p) => p.selection === 'Novak Djokovic -2.5' || p.selection === 'Carlos Alcaraz +2.5');
    assert.equal(gh25.length, 2, 'standard GH ±2.5 should be kept');
  });

  it('filters out expanded Game Handicap ±4.5 (alternate)', async () => {
    const plays = await recoverTennisFromScreen({ client, book: 'Pinnacle', skipTimeCorrection: true });
    const gh45 = plays.filter((p) => p.selection === 'Novak Djokovic -4.5' || p.selection === 'Carlos Alcaraz +4.5');
    assert.equal(gh45.length, 0, 'expanded GH ±4.5 should be filtered as alternate');
  });
});

describe('recoverTennisFromScreen — Total Games', () => {
  let client;

  before(() => {
    client = createMockClient();
  });

  it('preserves Total Games (always standard)', async () => {
    const plays = await recoverTennisFromScreen({ client, book: 'Pinnacle', skipTimeCorrection: true });
    const tgPlays = plays.filter((p) => p.market === 'Total Games');
    assert.equal(tgPlays.length, 2, 'Total Games should be preserved (both sides)');
  });
});

describe('recoverTennisFromScreen — market completeness', () => {
  let client;
  let plays;

  before(async () => {
    client = createMockClient();
    plays = await recoverTennisFromScreen({ client, book: 'Pinnacle', skipTimeCorrection: true });
  });

  it('returns plays across all three standard markets', () => {
    const markets = new Set(plays.map((p) => p.market));
    assert.ok(markets.has('Moneyline'), 'Moneyline should be present');
    assert.ok(markets.has('Game Handicap'), 'Game Handicap should be present');
    assert.ok(markets.has('Total Games'), 'Total Games should be present');
  });

  it('every play has required fields', () => {
    for (const p of plays) {
      assert.ok(p.game, `play ${p.selection} missing game`);
      assert.ok(p.gameId, `play ${p.selection} missing gameId`);
      assert.ok(p.selection, `play ${p.selection} missing selection`);
      assert.ok(p.odds, `play ${p.selection} missing odds`);
      assert.ok(['BET', 'CONSIDER'].includes(p.verdict), `play ${p.selection} has invalid verdict: ${p.verdict}`);
      assert.ok(p.movementDisposition, `play ${p.selection} missing movementDisposition`);
      assert.ok(p.tier, `play ${p.selection} missing tier`);
      assert.ok(p.source, `play ${p.selection} missing source`);
    }
  });

  it('no opposite sides of the same market are both BET', () => {
    const betByGameMarket = {};
    for (const p of plays) {
      if (p.verdict === 'BET') {
        const key = `${p.gameId}|${p.market}`;
        if (!betByGameMarket[key]) betByGameMarket[key] = [];
        betByGameMarket[key].push(p.selection);
      }
    }
    for (const [key, bets] of Object.entries(betByGameMarket)) {
      assert.ok(bets.length <= 1, `game+market ${key} has ${bets.length} BETs: ${bets.join(', ')}`);
    }
  });
});

describe('recoverTennisFromScreen — empty/edge cases', () => {
  it('returns empty array when no games', async () => {
    const client = {
      queryScreenOdds() {
        return Promise.resolve({ game_data: [] });
      },
      queryOddsHistory() {
        return Promise.resolve({});
      }
    };
    const plays = await recoverTennisFromScreen({ client, book: 'Pinnacle', skipTimeCorrection: true });
    assert.ok(Array.isArray(plays));
    assert.equal(plays.length, 0);
  });

  it('handles missing selections gracefully', async () => {
    const client = {
      queryScreenOdds() {
        return Promise.resolve({
          game_data: [
            {
              gameId: 'tennis-empty',
              awayTeam: 'A',
              homeTeam: 'B',
              selections: {}
            }
          ]
        });
      },
      queryOddsHistory() {
        return Promise.resolve({});
      }
    };
    const plays = await recoverTennisFromScreen({ client, book: 'Pinnacle', skipTimeCorrection: true });
    assert.equal(plays.length, 0);
  });

  it('handles missing odds gracefully', async () => {
    const client = {
      queryScreenOdds() {
        return Promise.resolve({
          game_data: [
            {
              gameId: 'tennis-no-odds',
              awayTeam: 'A',
              homeTeam: 'B',
              selections: {
                ml: {
                  selection1: 'A',
                  selection2: 'B',
                  odds: {}
                }
              }
            }
          ]
        });
      },
      queryOddsHistory() {
        return Promise.resolve({});
      }
    };
    const plays = await recoverTennisFromScreen({ client, book: 'Pinnacle', skipTimeCorrection: true });
    assert.equal(plays.length, 0);
  });
});
