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
 * RecoverTennisFromScreen iterates [Moneyline, Total Games, Set Handicap]
 * by default and calls queryScreenOdds once
 * per market — so we need to return only the selections relevant to the
 * requested market.
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
  'Set Handicap': {
    game_data: [
      {
        gameId: 'tennis-20260730-djokovic-alcaraz',
        awayTeam: 'Novak Djokovic',
        homeTeam: 'Carlos Alcaraz',
        start: '2026-07-30T18:00:00Z',
        selections: {
          sh_standard: {
            selection1: 'Novak Djokovic -1.5',
            selection1Id: 'Set_Handicap:Novak_Djokovic_-1.5',
            participant1: 'Novak Djokovic',
            selection2: 'Carlos Alcaraz +1.5',
            selection2Id: 'Set_Handicap:Carlos_Alcaraz_+1.5',
            participant2: 'Carlos Alcaraz',
            odds: {
              Pinnacle: { odds1: -105, odds2: -115 }
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

// History keyed by selectionId. Each side is queried independently — CLV
// is never copied or inverted from the opposite side.
// Djokovic ML: -150 → -175 = IP 60% → 63.64% = +3.64% CLV → supportive_clean
// Alcaraz ML: no history entry → insufficient
// GH -1.5: -110 → -130 = IP 52.38% → 56.52% = +4.14% CLV → supportive_clean
// GH -2.5: -105 → -120 = IP 51.22% → 54.55% = +3.33% CLV → supportive_clean
// GH -4.5: would be filtered
// Total Games Over: -110 → -125 = IP 52.38% → 55.56% = +3.18% CLV → supportive_clean
const TENNIS_HISTORY = {
  'Moneyline:Novak_Djokovic': supportiveHistory(-150, -175),
  'Game_Handicap:Novak_Djokovic_-1.5': supportiveHistory(-110, -130),
  'Game_Handicap:Novak_Djokovic_-2.5': supportiveHistory(-105, -120),
  'Game_Handicap:Novak_Djokovic_-4.5': supportiveHistory(-110, -130),
  'Set_Handicap:Novak_Djokovic_-1.5': supportiveHistory(-105, -125),
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

    // Alcaraz has no odds history of its own → insufficient signal
    assert.equal(alcaraz.verdict, 'CONSIDER', 'Alcaraz (no movement evidence) should be CONSIDER');
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
    const plays = await recoverTennisFromScreen({
      client,
      book: 'Pinnacle',
      markets: ['Game Handicap'],
      skipTimeCorrection: true
    });
    const gh15 = plays.filter(
      (p) =>
        p.market === 'Game Handicap' && (p.selection === 'Novak Djokovic -1.5' || p.selection === 'Carlos Alcaraz +1.5')
    );
    assert.equal(gh15.length, 2, 'standard GH ±1.5 should be kept');
  });

  it('keeps standard Game Handicap ±2.5', async () => {
    const plays = await recoverTennisFromScreen({
      client,
      book: 'Pinnacle',
      markets: ['Game Handicap'],
      skipTimeCorrection: true
    });
    const gh25 = plays.filter((p) => p.selection === 'Novak Djokovic -2.5' || p.selection === 'Carlos Alcaraz +2.5');
    assert.equal(gh25.length, 2, 'standard GH ±2.5 should be kept');
  });

  it('filters out expanded Game Handicap ±4.5 (alternate)', async () => {
    const plays = await recoverTennisFromScreen({
      client,
      book: 'Pinnacle',
      markets: ['Game Handicap'],
      skipTimeCorrection: true
    });
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

  it('keeps all standard Total Games lines (23.5 and 25.5) from the full selection matrix', async () => {
    const history = {
      'Total_Games:Over_23.5': supportiveHistory(-110, -125),
      'Total_Games:Under_23.5': supportiveHistory(-110, -115),
      'Total_Games:Over_25.5': supportiveHistory(-110, -150),
      'Total_Games:Under_25.5': supportiveHistory(-110, -105)
    };
    const client = {
      calls: { screen: [], history: [] },
      queryScreenOdds({ market }) {
        this.calls.screen.push(market);
        if (market !== 'Total Games') return Promise.resolve({ game_data: [] });
        return Promise.resolve({
          game_data: [
            {
              gameId: 'tennis-primary-total',
              awayTeam: 'Tsitsipas',
              homeTeam: 'Fonseca',
              selections: {
                primary: {
                  line1: 23.5,
                  line2: 23.5,
                  selection1: 'Over 23.5',
                  selection1Id: 'Total_Games:Over_23.5',
                  selection2: 'Under 23.5',
                  selection2Id: 'Total_Games:Under_23.5',
                  odds: {
                    Pinnacle: { odds1: -110, odds2: -110 },
                    NoVigApp: { odds1: -110, odds2: -110 }
                  }
                },
                alternate: {
                  line1: 25.5,
                  line2: 25.5,
                  selection1: 'Over 25.5',
                  selection1Id: 'Total_Games:Over_25.5',
                  selection2: 'Under 25.5',
                  selection2Id: 'Total_Games:Under_25.5',
                  odds: { Pinnacle: { odds1: -110, odds2: -110 } }
                }
              }
            }
          ]
        });
      },
      queryOddsHistory({ selectionId }) {
        this.calls.history.push(selectionId);
        return Promise.resolve(history[selectionId] || {});
      }
    };

    const plays = await recoverTennisFromScreen({
      client,
      book: 'Pinnacle',
      markets: 'Total Games',
      skipTimeCorrection: true
    });

    assert.deepEqual(
      plays.map((play) => play.selection).sort(),
      ['Over 23.5', 'Over 25.5', 'Under 23.5', 'Under 25.5'],
      'all standard totals should be recovered (Total Games never has alternates)'
    );
    assert.deepEqual(
      client.calls.history.sort(),
      ['Total_Games:Over_23.5', 'Total_Games:Over_25.5', 'Total_Games:Under_23.5', 'Total_Games:Under_25.5'],
      'history must be queried for every standard side'
    );
  });

  it('keeps standard totals even when distinct lines have tied book coverage', async () => {
    const client = {
      queryScreenOdds() {
        return Promise.resolve({
          game_data: [
            {
              gameId: 'tennis-tied-total',
              awayTeam: 'A',
              homeTeam: 'B',
              selections: {
                first: {
                  line1: 22.5,
                  line2: 22.5,
                  selection1: 'Over 22.5',
                  selection2: 'Under 22.5',
                  odds: { Pinnacle: { odds1: -110, odds2: -110 } }
                },
                second: {
                  line1: 24.5,
                  line2: 24.5,
                  selection1: 'Over 24.5',
                  selection2: 'Under 24.5',
                  odds: { Pinnacle: { odds1: -110, odds2: -110 } }
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

    const plays = await recoverTennisFromScreen({
      client,
      book: 'Pinnacle',
      markets: 'Total Games',
      skipTimeCorrection: true
    });

    assert.deepEqual(
      plays.map((play) => play.selection).sort(),
      ['Over 22.5', 'Over 24.5', 'Under 22.5', 'Under 24.5'],
      'standard totals are kept regardless of book-coverage ties'
    );
  });

  it('tolerates unusable odds objects without dropping standard totals', async () => {
    const client = {
      queryScreenOdds() {
        return Promise.resolve({
          game_data: [
            {
              gameId: 'tennis-invalid-total-coverage',
              awayTeam: 'A',
              homeTeam: 'B',
              selections: {
                apparentPrimary: {
                  line1: 22.5,
                  line2: 22.5,
                  selection1: 'Over 22.5',
                  selection2: 'Under 22.5',
                  odds: {
                    Pinnacle: { odds1: -110, odds2: -110 },
                    Circa: {},
                    DraftKings: { odds1: null, odds2: 'not-odds' }
                  }
                },
                alternate: {
                  line1: 24.5,
                  line2: 24.5,
                  selection1: 'Over 24.5',
                  selection2: 'Under 24.5',
                  odds: {
                    Pinnacle: { odds1: -110, odds2: -110 },
                    Circa: { odds1: -105, odds2: -115 }
                  }
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

    const plays = await recoverTennisFromScreen({
      client,
      book: 'Pinnacle',
      markets: 'Total Games',
      skipTimeCorrection: true
    });

    assert.deepEqual(
      plays.map((play) => play.selection).sort(),
      ['Over 22.5', 'Over 24.5', 'Under 22.5', 'Under 24.5'],
      'unusable odds objects are ignored but never cause standard totals to be dropped'
    );
  });

  it('keeps standard Game Handicap ±1.5 and ±2.5 from the full selection matrix', async () => {
    const client = {
      calls: { history: [] },
      queryScreenOdds() {
        return Promise.resolve({
          game_data: [
            {
              gameId: 'tennis-primary-handicap',
              awayTeam: 'Norrie',
              homeTeam: 'Buse',
              selections: {
                primary: {
                  line1: -1.5,
                  line2: 1.5,
                  selection1: 'Norrie -1.5',
                  selection1Id: 'Game_Handicap:Norrie_-1.5',
                  selection2: 'Buse +1.5',
                  selection2Id: 'Game_Handicap:Buse_+1.5',
                  odds: {
                    Pinnacle: { odds1: -110, odds2: -110 },
                    NoVigApp: { odds1: -110, odds2: -110 }
                  }
                },
                alternate: {
                  line1: -2.5,
                  line2: 2.5,
                  selection1: 'Norrie -2.5',
                  selection1Id: 'Game_Handicap:Norrie_-2.5',
                  selection2: 'Buse +2.5',
                  selection2Id: 'Game_Handicap:Buse_+2.5',
                  odds: { Pinnacle: { odds1: -110, odds2: -110 } }
                }
              }
            }
          ]
        });
      },
      queryOddsHistory({ selectionId }) {
        this.calls.history.push(selectionId);
        return Promise.resolve({});
      }
    };

    const plays = await recoverTennisFromScreen({
      client,
      book: 'Pinnacle',
      markets: 'Game Handicap',
      skipTimeCorrection: true
    });

    assert.deepEqual(
      plays.map((play) => play.selection).sort(),
      ['Buse +1.5', 'Buse +2.5', 'Norrie -1.5', 'Norrie -2.5'],
      'both standard GH lines (±1.5 and ±2.5) should be recovered'
    );
    assert.deepEqual(
      client.calls.history.sort(),
      ['Game_Handicap:Buse_+1.5', 'Game_Handicap:Buse_+2.5', 'Game_Handicap:Norrie_-1.5', 'Game_Handicap:Norrie_-2.5'],
      'history must be queried for every standard side'
    );
  });

  it('does not promote a row with missing movement evidence to BET', async () => {
    const client = {
      queryScreenOdds() {
        return Promise.resolve({
          game_data: [
            {
              gameId: 'tennis-no-history',
              awayTeam: 'A',
              homeTeam: 'B',
              selections: {
                primary: {
                  primary: true,
                  selection1: 'A',
                  selection1Id: 'Moneyline:A',
                  selection2: 'B',
                  selection2Id: 'Moneyline:B',
                  odds: { Pinnacle: { odds1: 200, odds2: -250 } }
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
    const plays = await recoverTennisFromScreen({
      client,
      book: 'Pinnacle',
      markets: 'Moneyline',
      skipTimeCorrection: true
    });
    assert.ok(plays.length > 0);
    assert.ok(plays.every((play) => play.movementDisposition === 'insufficient'));
    assert.ok(plays.every((play) => play.verdict === 'CONSIDER'));
  });
});

describe('recoverTennisFromScreen — Set Handicap', () => {
  it('queries and preserves Set Handicap as its own standard market', async () => {
    const client = createMockClient();
    const plays = await recoverTennisFromScreen({
      client,
      book: 'Pinnacle',
      markets: 'Set Handicap',
      skipTimeCorrection: true
    });
    const setPlays = plays;
    assert.equal(setPlays.length, 2, 'both Set Handicap sides should be present');
    assert.deepEqual(
      client.calls.screen.map((call) => call.market),
      ['Set Handicap']
    );
    assert.ok(
      client.calls.history.some((call) => call.selectionId?.startsWith('Set_Handicap:')),
      'Set Handicap selection IDs should be sent to odds history'
    );
  });

  it('normalizes CLI-style aliases before querying the backend', async () => {
    const client = createMockClient();
    await recoverTennisFromScreen({
      client,
      book: 'Pinnacle',
      markets: ['ml', 'handicap', 'set handicap'],
      skipTimeCorrection: true
    });

    assert.deepEqual(
      client.calls.screen.map((call) => call.market),
      ['Moneyline', 'Game Handicap', 'Set Handicap']
    );
  });

  it('falls back to the standard markets when the explicit list is empty', async () => {
    const client = createMockClient();
    await recoverTennisFromScreen({ client, book: 'Pinnacle', markets: [], skipTimeCorrection: true });

    assert.deepEqual(
      client.calls.screen.map((call) => call.market),
      ['Moneyline', 'Total Games', 'Set Handicap']
    );
  });
});

describe('recoverTennisFromScreen — market completeness', () => {
  let client;
  let plays;

  before(async () => {
    client = createMockClient();
    plays = await recoverTennisFromScreen({ client, book: 'Pinnacle', skipTimeCorrection: true });
  });

  it('returns plays across the three preferred markets and excludes Game Handicap', () => {
    const markets = new Set(plays.map((p) => p.market));
    assert.ok(markets.has('Moneyline'), 'Moneyline should be present');
    assert.ok(markets.has('Set Handicap'), 'Set Handicap should be present');
    assert.ok(markets.has('Total Games'), 'Total Games should be present');
    assert.ok(!markets.has('Game Handicap'), 'Game Handicap must not appear in default recovery');
  });

  it('queries Set Handicap by default', () => {
    const queried = new Set(client.calls.screen.map((call) => call.market));
    assert.deepEqual(
      [...queried].sort(),
      ['Moneyline', 'Set Handicap', 'Total Games'],
      'default recovery should query preferred tennis markets'
    );
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
