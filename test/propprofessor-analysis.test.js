'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { analyzePlayerPropBet } = require('../lib/propprofessor-analysis');
const {
  americanOddsToImpliedProbability,
  normalizeDirection,
  normalizeMarketName
} = require('../lib/propprofessor-shared-utils');
const { extractScreenRows, parseBetPrompt, extractHistoryTrail } = require('../lib/screen-parser');
const { isTennisRow, rankTennisScreenRows } = require('../lib/screen-tennis');
const {
  rankScreenRows,
  rankLeagueScreenRows,
  getLeagueRankingPreset,
  getMarketPriorityScore,
  passesLeagueRankingGate
} = require('../lib/screen-ranker');
const { summarizeFreshness } = require('../lib/screen-summary');
const { summarizeSharpMovement } = require('../lib/propprofessor-sharp-history');

describe('normalizeMarketName', () => {
  it('normalizes common prop market names', () => {
    assert.equal(normalizeMarketName('Pts'), 'points');
    assert.equal(normalizeMarketName('Player Points'), 'points');
    assert.equal(normalizeMarketName('Assists'), 'assists');
  });
});

describe('normalizeDirection', () => {
  it('normalizes over/under words and symbols', () => {
    assert.equal(normalizeDirection('o'), 'over');
    assert.equal(normalizeDirection('over'), 'over');
    assert.equal(normalizeDirection('u'), 'under');
    assert.equal(normalizeDirection('under'), 'under');
  });
});

describe('parseBetPrompt', () => {
  it('parses a plain-language player prop query', () => {
    const parsed = parseBetPrompt('Is James Harden o18.5 Points a good bet?');
    assert.equal(parsed.player, 'James Harden');
    assert.equal(parsed.side, 'over');
    assert.equal(parsed.line, 18.5);
    assert.equal(parsed.market, 'points');
  });
});

describe('analyzePlayerPropBet', () => {
  const rows = [
    {
      book: 'FanDuel',
      participant: 'James Harden',
      market: 'Player Points',
      selection: 'James Harden Over 18.5',
      odds: -110,
      ev: 6.2
    },
    {
      book: 'DraftKings',
      participant: 'James Harden',
      market: 'Player Points',
      selection: 'James Harden Under 18.5',
      odds: -108,
      ev: -1.1
    }
  ];

  it('returns a yes verdict for a supported over play', () => {
    const result = analyzePlayerPropBet(
      {
        player: 'James Harden',
        side: 'over',
        line: 18.5,
        market: 'Points'
      },
      rows
    );

    assert.equal(result.verdict, 'yes');
    assert.equal(result.bestMatch.book, 'FanDuel');
    assert.equal(result.bestMatch.ev, 6.2);
  });

  it('returns pass when no row matches the requested market', () => {
    const result = analyzePlayerPropBet(
      {
        player: 'James Harden',
        side: 'over',
        line: 22.5,
        market: 'Rebounds'
      },
      rows
    );

    assert.equal(result.verdict, 'pass');
    assert.equal(result.bestMatch, null);
  });

  it('returns a no verdict when the best match has negative EV', () => {
    // Query the Under side so the negative-EV row (DraftKings, ev -1.1) wins.
    const result = analyzePlayerPropBet(
      {
        player: 'James Harden',
        side: 'under',
        line: 18.5,
        market: 'Points'
      },
      rows
    );

    assert.equal(result.verdict, 'no');
    assert.equal(result.bestMatch.book, 'DraftKings');
    assert.equal(result.bestMatch.ev, -1.1);
    assert.ok(result.confidence > 0 && result.confidence <= 95, `confidence in range, got ${result.confidence}`);
  });

  it('returns pass (not yes/no) when the best match EV is exactly zero', () => {
    const zeroEvRows = [
      {
        book: 'FanDuel',
        participant: 'Luka Doncic',
        market: 'Player Points',
        selection: 'Luka Doncic Over 27.5',
        odds: -110,
        ev: 0
      }
    ];
    const result = analyzePlayerPropBet(
      { player: 'Luka Doncic', side: 'over', line: 27.5, market: 'Points' },
      zeroEvRows
    );
    assert.equal(result.verdict, 'pass');
    assert.equal(result.bestMatch.book, 'FanDuel');
  });

  it('returns pass with no match when rows is not an array (null/undefined safe)', () => {
    const fromNull = analyzePlayerPropBet({ player: 'X', side: 'over', line: 1, market: 'Points' }, null);
    assert.equal(fromNull.verdict, 'pass');
    assert.equal(fromNull.bestMatch, null);
    assert.deepEqual(fromNull.alternatives, []);
    assert.equal(fromNull.rationale[0], 'No matching market found');
  });

  it('surfaces alternatives (runner-up matches) when present', () => {
    const result = analyzePlayerPropBet({ player: 'James Harden', side: 'over', line: 18.5, market: 'Points' }, rows);
    // FanDuel (ev 6.2) is best; DraftKings Under is the only other candidate.
    assert.ok(Array.isArray(result.alternatives), 'alternatives is an array');
    assert.equal(result.alternatives.length, 1);
    assert.equal(result.alternatives[0].book, 'DraftKings');
  });
});

describe('extractScreenRows', () => {
  it('returns rows from the odds screen game_data payload', () => {
    const payload = {
      game_data: [
        { id: 'row-1', league: 'Tennis' },
        { id: 'row-2', league: 'Tennis' }
      ],
      participants: [],
      games: []
    };

    assert.deepEqual(
      extractScreenRows(payload).map((row) => row.id),
      ['row-1', 'row-2']
    );
  });

  it('returns rows from an array-like game_data payload', () => {
    const payload = { game_data: { 0: { id: 'array-like-row' } } };
    assert.deepEqual(
      extractScreenRows(payload).map((row) => row.id),
      ['array-like-row']
    );
  });

  it('falls back to legacy data/results arrays', () => {
    assert.deepEqual(
      extractScreenRows({ data: [{ id: 'a' }] }).map((row) => row.id),
      ['a']
    );
    assert.deepEqual(
      extractScreenRows({ results: [{ id: 'b' }] }).map((row) => row.id),
      ['b']
    );
    assert.deepEqual(
      extractScreenRows([{ id: 'c' }]).map((row) => row.id),
      ['c']
    );
  });

  it('expands nested odds screen selections into per-book rows', () => {
    const payload = {
      game_data: [
        {
          gameId: 'game-1',
          league: 'NBA',
          market: 'Point Spread',
          homeTeam: 'Houston Rockets',
          awayTeam: 'Los Angeles Lakers',
          selections: {
            '-2.5': {
              selection1: 'Houston Rockets -2.5',
              participant1: 'Houston Rockets',
              selection1Id: 'Point_Spread:Houston_Rockets_-2.5',
              line1: -2.5,
              selection2: 'Los Angeles Lakers +2.5',
              participant2: 'Los Angeles Lakers',
              selection2Id: 'Point_Spread:Los_Angeles_Lakers_+2.5',
              line2: 2.5,
              odds: {
                OnyxOdds: { odds1: -132, odds2: 110 },
                NoVigApp: { odds1: -128, odds2: 104 }
              }
            }
          }
        }
      ]
    };

    const rows = extractScreenRows(payload, [{ book: 'OnyxOdds' }]);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.selectionId),
      ['Point_Spread:Houston_Rockets_-2.5', 'Point_Spread:Los_Angeles_Lakers_+2.5']
    );
    assert.deepEqual(
      rows.map((row) => row.book),
      ['OnyxOdds', 'OnyxOdds']
    );
    assert.deepEqual(
      rows.map((row) => row.odds),
      [-132, 110]
    );
  });
});

describe('tennis screen ranking helpers', () => {
  it('recognizes tennis rows and extracts history trails', () => {
    const row = {
      league: 'Tennis',
      market: 'Moneyline',
      lineHistory: [{ odds: -120 }, { odds: -105 }],
      currentOdds: -105
    };

    assert.equal(isTennisRow(row), true);
    assert.deepEqual(extractHistoryTrail(row), [-120, -105]);
    assert.equal(americanOddsToImpliedProbability(-120) > americanOddsToImpliedProbability(-105), true);
  });

  it('labels comparison-book movement when the named book lacks its own history', () => {
    const summary = summarizeSharpMovement({
      lineHistory: [
        { book: 'Pinnacle', odds: -142, time: 1 },
        { book: 'Pinnacle', odds: -150, time: 2 },
        { book: 'Polymarket', odds: -9900, time: 3 }
      ],
      preferredBook: 'NoVigApp',
      sharpBooks: ['Pinnacle', 'Polymarket', 'Kalshi'],
      options: { recentWindowHours: 6 }
    });

    assert.equal(summary.movementSourceBook, 'Pinnacle');
    assert.equal(summary.movementMode, 'comparison_book');
    assert.equal(summary.movementQuality, 'low');
    assert.equal(summary.lineHistoryUsable, true);
    assert.equal(summary.droppedHistoryPointCount, 1);
    assert.equal(summary.movementLabel, 'supportive');
  });

  it('derives consensus edge from nested /screen odds rows with a preferred book', () => {
    const rows = [
      {
        league: 'Tennis',
        market: 'Game Handicap',
        homeTeam: 'Lajovic',
        awayTeam: 'Sonego',
        defaultKey: 'null',
        selections: {
          null: {
            selection1: 'Lajovic -1.5',
            selection2: 'Sonego +1.5',
            odds: {
              Fliff: { odds1: -120, odds2: 105 },
              Polymarket: { odds1: -126, odds2: 110 },
              Kalshi: { odds1: -124, odds2: 108 },
              BetOnline: { odds1: -122, odds2: 107 },
              Circa: { odds1: -121, odds2: 106 }
            }
          }
        }
      }
    ];

    const ranked = rankTennisScreenRows(rows, { limit: 5, preferredBook: 'Fliff', includeAll: true });
    assert.equal(ranked.length >= 1, true);
    assert.equal(['Lajovic -1.5', 'Sonego +1.5'].includes(ranked[0].participant), true);
    assert.equal(ranked[0].book, 'Fliff');
    assert.equal(ranked[0].consensusEdge !== 0, true);
  });

  it('does not re-expand already extracted tennis rows and preserves the correct preferred-book sides', () => {
    const payload = {
      game_data: [
        {
          league: 'Tennis',
          market: 'Moneyline',
          homeTeam: 'Cobolli',
          awayTeam: 'Medvedev',
          gameId: 'g1',
          selections: {
            a: {
              selection1: 'Cobolli',
              participant1: 'Cobolli',
              selection1Id: 'Moneyline:Cobolli',
              selection2: 'Medvedev',
              participant2: 'Medvedev',
              selection2Id: 'Moneyline:Medvedev',
              odds: {
                NoVigApp: { odds1: 115, odds2: -125 },
                Polymarket: { odds1: 110, odds2: -130 },
                Kalshi: { odds1: 108, odds2: -132 },
                BetOnline: { odds1: 109, odds2: -131 },
                Circa: { odds1: 107, odds2: -133 }
              }
            }
          }
        }
      ]
    };

    const extracted = extractScreenRows(payload);
    const ranked = rankTennisScreenRows(extracted, { limit: 10, preferredBook: 'NoVigApp', includeAll: true });

    assert.equal(ranked.length, 2);
    assert.deepEqual(
      ranked.map((row) => row.book),
      ['NoVigApp', 'NoVigApp']
    );
    assert.deepEqual(ranked.map((row) => row.participant).sort(), ['Cobolli', 'Medvedev']);
    assert.deepEqual(ranked.map((row) => row.selectionId).sort(), ['Moneyline:Cobolli', 'Moneyline:Medvedev']);
    assert.equal(
      ranked.every((row) => row.hasConsensus),
      true
    );
    assert.equal(
      ranked.every((row) => row.consensusBookCount === 4),
      true
    );
  });

  it('derives consensus from the matched non-default extracted prop selection', () => {
    const payload = {
      game_data: [
        {
          league: 'MLB',
          market: 'Player Outs',
          gameId: 'g1',
          defaultKey: 'a',
          selections: {
            a: {
              selection1: 'Player A Over 15.5',
              participant1: 'Player A',
              selection1Id: 'Player_Outs:Player_A_Over_15.5',
              line1: 15.5,
              selection2: 'Player A Under 15.5',
              participant2: 'Player A',
              selection2Id: 'Player_Outs:Player_A_Under_15.5',
              line2: 15.5,
              odds: {
                NoVigApp: { odds1: -110, odds2: -110 },
                Pinnacle: { odds1: -120, odds2: 100 },
                DraftKings: { odds1: -118, odds2: -102 }
              }
            },
            b: {
              selection1: 'Kyle Harrison Over 15.5',
              participant1: 'Kyle Harrison',
              selection1Id: 'Player_Outs:Kyle_Harrison_Over_15.5',
              line1: 15.5,
              selection2: 'Kyle Harrison Under 15.5',
              participant2: 'Kyle Harrison',
              selection2Id: 'Player_Outs:Kyle_Harrison_Under_15.5',
              line2: 15.5,
              odds: {
                NoVigApp: { odds1: -104, odds2: -118 },
                Pinnacle: { odds1: -112, odds2: -108 },
                DraftKings: { odds1: -110, odds2: -110 },
                BetMGM: { odds1: -111, odds2: -109 }
              }
            }
          }
        }
      ]
    };

    const extracted = extractScreenRows(payload, [{ book: 'NoVigApp' }]).filter((row) =>
      String(row.selectionId).includes('Kyle_Harrison')
    );
    const ranked = rankScreenRows(extracted, {
      limit: 10,
      preferredBooks: ['NoVigApp', 'Pinnacle', 'DraftKings', 'BetMGM'],
      includeAll: true
    });

    assert.equal(ranked.length, 2);
    assert.equal(
      ranked.every((row) => row.hasConsensus),
      true
    );
    assert.equal(
      ranked.every((row) => row.consensusBookCount === 3),
      true
    );
    assert.equal(
      ranked.every((row) => Number.isFinite(row.consensusEdge)),
      true
    );
  });

  it('preserves the exact extracted prop selection when defaultKey points at a different alternate line', () => {
    const payload = {
      game_data: [
        {
          league: 'NBA',
          market: 'Player Points',
          gameId: 'nba-hartenstein-reg',
          defaultKey: '8.5',
          selections: {
            7.5: {
              selection1: 'Isaiah Hartenstein Over 7.5',
              participant1: 'Isaiah Hartenstein',
              selection1Id: 'Player_Points:Isaiah_Hartenstein_Over_7.5',
              line1: 7.5,
              selection2: 'Isaiah Hartenstein Under 7.5',
              participant2: 'Isaiah Hartenstein',
              selection2Id: 'Player_Points:Isaiah_Hartenstein_Under_7.5',
              line2: 7.5,
              odds: {
                NoVigApp: { odds1: 118, odds2: -142 },
                FanDuel: { odds1: -120, odds2: 100 },
                DraftKings: { odds1: -116, odds2: -104 }
              }
            },
            8.5: {
              selection1: 'Isaiah Hartenstein Over 8.5',
              participant1: 'Isaiah Hartenstein',
              selection1Id: 'Player_Points:Isaiah_Hartenstein_Over_8.5',
              line1: 8.5,
              selection2: 'Isaiah Hartenstein Under 8.5',
              participant2: 'Isaiah Hartenstein',
              selection2Id: 'Player_Points:Isaiah_Hartenstein_Under_8.5',
              line2: 8.5,
              odds: {
                NoVigApp: { odds1: 110, odds2: -125 },
                FanDuel: { odds1: -105, odds2: -115 },
                DraftKings: { odds1: -108, odds2: -112 }
              }
            }
          },
          lineHistory: [
            { book: 'FanDuel', odds: -130, time: Date.now() - 3 * 60 * 60 * 1000 },
            { book: 'FanDuel', odds: -120, time: Date.now() - 45 * 60 * 1000 }
          ],
          updatedAt: new Date().toISOString()
        }
      ]
    };

    const extracted = extractScreenRows(payload, [{ book: 'NoVigApp' }]).filter(
      (row) => row.selectionId === 'Player_Points:Isaiah_Hartenstein_Over_7.5'
    );
    assert.equal(extracted.length, 1);

    const ranked = rankScreenRows(extracted, {
      limit: 10,
      preferredBooks: ['NoVigApp', 'FanDuel', 'DraftKings'],
      includeAll: true
    });

    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].selectionId, 'Player_Points:Isaiah_Hartenstein_Over_7.5');
    assert.equal(ranked[0].participant, 'Isaiah Hartenstein Over 7.5');
    assert.equal(ranked[0].line, 7.5);
    assert.equal(ranked[0].odds, 118);
    assert.equal(ranked[0].consensusBookCount, 2);
    assert.equal(ranked[0].movementSourceBook, 'FanDuel');
  });

  it('preserves computed execution fields for participant-filtered selection2 rows', () => {
    const payload = {
      game_data: [
        {
          league: 'NBA',
          market: 'Point Spread',
          gameId: 'nba-spurs-wolves-reg',
          updatedAt: new Date().toISOString(),
          homeTeam: 'Minnesota Timberwolves',
          awayTeam: 'San Antonio Spurs',
          defaultKey: '5.5',
          selections: {
            5.5: {
              selection1: 'Minnesota Timberwolves -5.5',
              participant1: 'Minnesota Timberwolves',
              selection1Id: 'Point_Spread:Minnesota_Timberwolves_-5.5',
              line1: -5.5,
              selection2: 'San Antonio Spurs +5.5',
              participant2: 'San Antonio Spurs',
              selection2Id: 'Point_Spread:San_Antonio_Spurs_+5.5',
              line2: 5.5,
              odds: {
                NoVigApp: { odds1: -120, odds2: 100 },
                Pinnacle: { odds1: -127, odds2: 104 },
                DraftKings: { odds1: -125, odds2: 102 }
              }
            }
          },
          lineHistory: [
            { book: 'Pinnacle', odds: -112, time: Date.now() - 2 * 60 * 60 * 1000 },
            { book: 'Pinnacle', odds: -120, time: Date.now() - 20 * 60 * 1000 }
          ]
        }
      ]
    };

    const extracted = extractScreenRows(payload, [{ book: 'NoVigApp' }]).filter(
      (row) => row.selectionId === 'Point_Spread:San_Antonio_Spurs_+5.5'
    );
    assert.equal(extracted.length, 1);

    const ranked = rankScreenRows(extracted, {
      limit: 10,
      preferredBooks: ['NoVigApp', 'Pinnacle', 'DraftKings'],
      includeAll: true
    });

    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].selectionId, 'Point_Spread:San_Antonio_Spurs_+5.5');
    assert.equal(ranked[0].targetBookOdds, 100);
    assert.equal(ranked[0].bestAvailableOdds, 104);
    assert.equal(ranked[0].marketBookCount, 2);
    assert.equal(ranked[0].supportBookCount, 2);
    assert.equal(ranked[0].consensusBookCount, 2);
    assert.equal(ranked[0].executionQuality, 'playable');
  });

  it('ranks general screen rows with consensus and movement metadata', () => {
    const nowMs = Date.now();
    const rows = [
      {
        league: 'NBA',
        market: 'Moneyline',
        book: 'NoVigApp',
        value: 2.1,
        odds: -110,
        lineHistory: [
          { book: 'NoVigApp', odds: -100, time: nowMs - 4 * 60 * 60 * 1000 },
          { book: 'NoVigApp', odds: -105, time: nowMs - 2 * 60 * 60 * 1000 },
          { book: 'NoVigApp', odds: -110, time: nowMs - 30 * 60 * 1000 }
        ]
      },
      {
        league: 'NBA',
        market: 'Moneyline',
        book: 'DraftKings',
        value: 0.5,
        odds: 105
      }
    ];

    const ranked = rankScreenRows(rows, { limit: 5, includeAll: true });
    assert.equal(ranked[0].screenScore >= ranked[1].screenScore, true);
    assert.equal(typeof ranked[0].screenMarket, 'string');
    assert.equal(typeof ranked[0].scoreBreakdown.total, 'number');
    assert.equal(ranked[0].lineHistoryUsable, true);
    assert.equal(ranked[0].movementMode, 'same_book');
    assert.equal(ranked[0].movementSourceBook, 'NoVigApp');
    assert.equal(typeof ranked[0].recentClvPct, 'number');
    assert.equal(typeof ranked[0].movementQualityScore, 'number');
  });

  it('filters out weak rows when includeAll is false', () => {
    const ranked = rankScreenRows(
      [
        {
          league: 'NBA',
          market: 'Moneyline',
          book: 'NoVigApp',
          odds: -110
        }
      ],
      { limit: 5, includeAll: false }
    );

    assert.equal(ranked.length, 0);
  });

  it('applies a league ranking preset for NBA, MLB, NFL, NHL, and soccer', () => {
    assert.equal(getLeagueRankingPreset('NBA').displayName, 'NBA');
    assert.equal(getLeagueRankingPreset('MLB').displayName, 'MLB');
    assert.equal(getLeagueRankingPreset('NFL').displayName, 'NFL');
    assert.equal(getLeagueRankingPreset('NHL').displayName, 'NHL');
    assert.equal(getLeagueRankingPreset('soccer').displayName, 'Soccer');
  });

  it('uses market-aware sharp books for NBA, NFL, and MLB presets', () => {
    const nbaMain = getLeagueRankingPreset('NBA', 'Moneyline');
    const nbaProps = getLeagueRankingPreset('NBA', 'Player Points');
    const nflMain = getLeagueRankingPreset('NFL', 'Moneyline');
    const nflProps = getLeagueRankingPreset('NFL', 'Player Passing Yards');
    const mlbMain = getLeagueRankingPreset('MLB', 'Moneyline');
    const mlbProps = getLeagueRankingPreset('MLB', 'Player Strikeouts');
    assert.deepEqual(nbaMain.preferredBooks, ['Circa', 'Pinnacle', 'BookMaker', 'BetOnline', 'DraftKings']);
    assert.deepEqual(nbaProps.preferredBooks, ['FanDuel', 'BookMaker', 'Prop Builder', 'NoVigApp', 'Pinnacle']);
    assert.equal(nbaProps.sharpBookContext.key, 'nba_props');
    assert.deepEqual(nflMain.preferredBooks, ['Circa', 'Pinnacle', 'BookMaker', 'NoVigApp', 'FanDuel']);
    assert.deepEqual(nflProps.preferredBooks, ['Pinnacle', 'FanDuel', 'BookMaker', 'Circa', 'BetOnline']);
    assert.equal(nflProps.sharpBookContext.key, 'nfl_props');
    assert.deepEqual(mlbMain.preferredBooks, ['Pinnacle', 'Circa', 'BookMaker', 'BetOnline', 'DraftKings', 'BetMGM']);
    assert.deepEqual(mlbProps.preferredBooks, ['Circa', 'FanDuel', 'PropBuilder', 'Pinnacle', 'DraftKings', 'Bet365']);
    assert.equal(mlbProps.sharpBookContext.key, 'mlb_props');
  });

  it('scores higher-priority league markets above generic ones', () => {
    const nbaPreset = getLeagueRankingPreset('NBA');
    const pointsScore = getMarketPriorityScore(nbaPreset, 'player points');
    const moneylineScore = getMarketPriorityScore(nbaPreset, 'moneyline');
    assert.equal(pointsScore.weight > moneylineScore.weight, true);
  });

  it('hard-gates weak rows without consensus, movement, or market fit', () => {
    const preset = getLeagueRankingPreset('NBA');
    const gate = passesLeagueRankingGate({
      score: 0.5,
      hasConsensus: false,
      hasLineMovement: false,
      leaguePreset: preset,
      marketHintMatch: null
    });

    assert.equal(gate.passed, false);
    assert.match(gate.reason, /no consensus/);
  });

  it('hard-gates score below the league minimum even when a market fit exists', () => {
    const preset = getLeagueRankingPreset('MLB');
    const gate = passesLeagueRankingGate({
      score: 1.0,
      hasConsensus: false,
      hasLineMovement: true,
      leaguePreset: preset,
      marketHintMatch: 'player strikeouts'
    });

    assert.equal(gate.passed, false);
    assert.match(gate.reason, /below/);
  });

  it('rankLeagueScreenRows carries the league preset into ranked results', () => {
    const ranked = rankLeagueScreenRows(
      [
        {
          league: 'NBA',
          market: 'Moneyline',
          book: 'NoVigApp',
          value: 3,
          odds: -105,
          lineHistory: [-115, -105]
        }
      ],
      { league: 'NBA', includeAll: true }
    );

    assert.equal(ranked[0].leaguePreset, 'NBA');
    assert.equal(ranked[0].screenMarket, 'moneyline');
    assert.equal(ranked[0].scoreBreakdown.sportScore > 0, true);
  });

  it('rankLeagueScreenRows threads recentWindowHours into movement summaries', () => {
    const nowMs = Date.now();
    const ranked = rankLeagueScreenRows(
      [
        {
          league: 'NBA',
          market: 'Moneyline',
          book: 'NoVigApp',
          value: 3,
          odds: -105,
          lineHistory: [
            { book: 'Pinnacle', odds: -110, time: nowMs - 4 * 60 * 60 * 1000 },
            { book: 'Pinnacle', odds: -120, time: nowMs - 30 * 60 * 1000 }
          ]
        }
      ],
      { league: 'NBA', includeAll: true, recentWindowHours: 3 }
    );

    assert.equal(ranked[0].recentWindowHours, 3);
    assert.equal(ranked[0].movementDebug?.recentWindowHours, 3);
  });

  it('marks preferred-book-only tennis rows as unranked instead of scoring by book bonus', () => {
    const rows = [
      {
        league: 'Tennis',
        market: 'Moneyline',
        defaultKey: 'null',
        selections: {
          null: {
            selection1: 'Player A',
            selection2: 'Player B',
            odds: {
              Fliff: { odds1: -110, odds2: -110 }
            }
          }
        }
      }
    ];

    const ranked = rankTennisScreenRows(rows, { limit: 2, preferredBook: 'Fliff', includeAll: true });
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].hasConsensus, false);
    assert.equal(ranked[0].hasLineMovement, false);
    assert.equal(ranked[0].consensusEdge, null);
    assert.equal(ranked[0].tennisScore, 0);
    assert.equal(ranked[0].scoreBreakdown.sportScore, 0);
    assert.match(ranked[0].rankingReason, /unranked/);
    // The warning now surfaces the real gate failure reason (score below the
    // league floor) instead of the blanket 'Insufficient comparison data'
    // string, which was misleading when comparison data existed but the
    // score didn't clear the gate (see UFC 330 Makhachev 2026-08-15).
    assert.match(ranked[0].warning, /below .* gate/);
    assert.equal(ranked[0].isActionable, false);
    assert.equal(ranked[0].consensusBookCount, 0);
  });

  it('rankTennisScreenRows threads recentWindowHours into movement summaries', () => {
    const nowMs = Date.now();
    const rows = [
      {
        league: 'Tennis',
        market: 'Moneyline',
        book: 'NoVigApp',
        participant: 'Player A',
        selection: 'Player A',
        pick: 'Player A',
        odds: -112,
        currentOdds: -112,
        consensusEdge: 1.4,
        hasConsensus: true,
        consensusBookCount: 2,
        lineHistory: [
          { book: 'Pinnacle', odds: -108, time: nowMs - 2 * 60 * 60 * 1000 },
          { book: 'Pinnacle', odds: -112, time: nowMs - 15 * 60 * 1000 }
        ]
      }
    ];

    const ranked = rankTennisScreenRows(rows, {
      limit: 2,
      preferredBook: 'NoVigApp',
      includeAll: true,
      recentWindowHours: 1
    });

    assert.equal(ranked[0].recentWindowHours, 1);
    assert.equal(ranked[0].movementDebug?.recentWindowHours, 1);
  });

  it('keeps sport fixtures representative for NBA, MLB, NFL, NHL, and soccer', () => {
    const rows = [
      { league: 'NBA', market: 'Player Points', book: 'NoVigApp', value: 2.1, odds: -110 },
      { league: 'MLB', market: 'Player Strikeouts', book: 'NoVigApp', value: 2.2, odds: -105 },
      { league: 'NFL', market: 'Player Passing Yards', book: 'NoVigApp', value: 2.3, odds: -108 },
      { league: 'NHL', market: 'Player Shots', book: 'NoVigApp', value: 2.1, odds: -107 },
      { league: 'SOCCER', market: 'Goal Scorer', book: 'NoVigApp', value: 2.0, odds: 120 }
    ];

    const ranked = [
      rankLeagueScreenRows([rows[0]], { league: 'NBA', includeAll: true })[0],
      rankLeagueScreenRows([rows[1]], { league: 'MLB', includeAll: true })[0],
      rankLeagueScreenRows([rows[2]], { league: 'NFL', includeAll: true })[0],
      rankLeagueScreenRows([rows[3]], { league: 'NHL', includeAll: true })[0],
      rankLeagueScreenRows([rows[4]], { league: 'SOCCER', includeAll: true })[0]
    ];

    assert.deepEqual(
      ranked.map((row) => row.leaguePreset),
      ['NBA', 'MLB', 'NFL', 'NHL', 'Soccer']
    );
    assert.equal(
      ranked.every((row) => row.scoreBreakdown.total >= 0),
      true
    );
  });

  it('flags rows with stale timestamps when a max age is provided', () => {
    const now = new Date('2026-04-24T13:00:00.000Z').getTime();
    const ranked = rankScreenRows(
      [
        {
          league: 'NBA',
          book: 'NoVigApp',
          market: 'Moneyline',
          value: 2,
          odds: 110,
          updatedAt: new Date(now - 10 * 60 * 1000).toISOString()
        }
      ],
      { includeAll: true, maxAgeMs: 5 * 60 * 1000 }
    );

    assert.equal(ranked[0].stale, true);
    assert.equal(ranked[0].freshnessMs > 0, true);
    assert.match(ranked[0].rankingReason, /stale data/);
    assert.equal(ranked[0].scoreBreakdown.freshnessPenalty < 0, true);
  });

  it('summarizeFreshness reports timestamp sources and falls back to response age for undated rows', () => {
    const now = new Date('2026-04-24T13:00:00.000Z').getTime();
    const withTimestamps = summarizeFreshness(
      [
        { updatedAt: new Date(now - 10 * 1000).toISOString() },
        { payload: { updatedAt: new Date(now - 30 * 1000).toISOString() } },
        { meta: { timestamp: new Date(now - 20 * 1000).toISOString() } }
      ],
      now,
      { maxAgeMs: 15 * 1000 }
    );

    assert.equal(withTimestamps.rowCount, 3);
    assert.equal(withTimestamps.newestAgeMs, 10000);
    assert.equal(withTimestamps.oldestAgeMs, 30000);
    assert.equal(withTimestamps.staleCount, 2);
    assert.equal(withTimestamps.stale, true);
    assert.deepEqual(withTimestamps.timestampSources, {
      updatedAt: 1,
      'payload.updatedAt': 1,
      'meta.timestamp': 1
    });
    assert.equal(withTimestamps.freshnessFallbackUsed, false);

    const fallback = summarizeFreshness([{ league: 'NBA' }, { league: 'NFL' }], now);
    assert.equal(fallback.rowCount, 2);
    assert.equal(fallback.newestAgeMs, 0);
    assert.equal(fallback.oldestAgeMs, 0);
    assert.equal(fallback.freshnessFallbackUsed, true);
    assert.deepEqual(fallback.timestampSources, { response_received: 2 });
  });

  it('exposes richer movement debug metadata on ranked rows', () => {
    const nowMs = Date.now();
    const ranked = rankScreenRows(
      [
        {
          league: 'NBA',
          market: 'Moneyline',
          book: 'NoVigApp',
          value: 2.4,
          odds: -112,
          lineHistory: [
            { book: 'NoVigApp', odds: -104, time: nowMs - 5 * 60 * 60 * 1000 },
            { book: 'NoVigApp', odds: -104, time: nowMs - 4 * 60 * 60 * 1000 },
            { book: 'NoVigApp', odds: -112, time: nowMs - 60 * 60 * 1000 },
            { book: 'Polymarket', odds: -9999, time: nowMs - 30 * 60 * 1000 }
          ],
          historySportsbooksRequested: ['NoVigApp', 'Polymarket']
        }
      ],
      { limit: 5, includeAll: true }
    );

    assert.equal(ranked.length, 1);
    assert.deepEqual(ranked[0].droppedHistoryReasons ?? ranked[0].movementDebug?.droppedHistoryReasons, {
      duplicate_consecutive: 1,
      outlier_odds: 1
    });
    assert.equal(Array.isArray(ranked[0].filteredLineHistory), true);
    assert.equal(Array.isArray(ranked[0].droppedHistoryPoints), true);
    assert.equal(typeof ranked[0].openToCurrentClvPct, 'number');
    assert.equal(typeof ranked[0].movementDebug, 'object');
    assert.equal(ranked[0].movementDebug.movementMode, ranked[0].movementMode);
    assert.equal(ranked[0].movementDebug.openToCurrentClvPct, ranked[0].openToCurrentClvPct);
    assert.equal(ranked[0].freshnessSource, 'response_received');
    assert.equal(ranked[0].freshnessFallbackUsed, true);
    assert.equal(ranked[0].rankingProvenance.focusBook, 'NoVigApp');
    assert.equal(ranked[0].rankingProvenance.lineHistorySource, null);
    assert.deepEqual(ranked[0].historySportsbooksRequested, ['NoVigApp', 'Polymarket']);
  });

  it('can suppress verbose debug payloads while keeping provenance metadata', () => {
    const ranked = rankScreenRows(
      [
        {
          league: 'NBA',
          market: 'Moneyline',
          book: 'NoVigApp',
          participant: 'Boston Celtics',
          selection: 'Boston Celtics',
          pick: 'Boston Celtics',
          odds: -118,
          currentOdds: -118,
          consensusEdge: 2.4,
          hasConsensus: true,
          consensusBookCount: 2,
          lineHistory: [
            { book: 'NoVigApp', odds: -125, time: Date.now() - 60_000 },
            { book: 'NoVigApp', odds: -118, time: Date.now() }
          ],
          historySportsbooksRequested: ['NoVigApp']
        }
      ],
      { limit: 5, includeAll: true, debug: false }
    );

    assert.equal(ranked.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(ranked[0], 'movementDebug'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ranked[0], 'filteredLineHistory'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ranked[0], 'droppedHistoryReasons'), false);
    assert.ok(ranked[0].rankingProvenance);
    assert.equal(ranked[0].rankingProvenance.focusBook, 'NoVigApp');
  });

  it('maps spread and total market names into tennis screen query groups', () => {
    const { normalizeTennisMarketQuery } = require('../lib/screen-tennis');
    assert.deepEqual(normalizeTennisMarketQuery('Spread'), ['Game Handicap']);
    assert.deepEqual(normalizeTennisMarketQuery('Total'), ['Total Games']);
  });

  it('exposes the misleading consensusBookCount=0 for props with multiple comparison books (Kyle Freeland fixture)', () => {
    const payload = [
      {
        league: 'MLB',
        market: 'Pitcher Outs Recorded',
        gameId: 'mlb-kyle',
        defaultKey: 'a',
        selections: {
          a: {
            selection1: 'Kyle Freeland Over 17.5',
            participant1: 'Kyle Freeland',
            selection1Id: 'Pitcher_Outs:Kyle_Freeland_Over_17.5',
            line1: 17.5,
            selection2: 'Kyle Freeland Under 17.5',
            participant2: 'Kyle Freeland',
            selection2Id: 'Pitcher_Outs:Kyle_Freeland_Under_17.5',
            line2: 17.5,
            odds: {
              NoVigApp: { odds1: 100, odds2: -120 },
              Pinnacle: { odds1: null, odds2: -112 },
              DraftKings: { odds1: null, odds2: -108 }
            }
          }
        }
      }
    ];

    const ranked = rankScreenRows(payload, {
      limit: 10,
      preferredBooks: ['NoVigApp', 'Pinnacle', 'DraftKings'],
      includeAll: true
    });

    const row = ranked.find(
      (r) => r.participant && r.participant.includes('Kyle Freeland') && String(r.odds) === '100'
    );
    assert.ok(row, 'Kyle Freeland Over row should exist');
    assert.equal(row.consensusBookCount, 0);
    assert.equal(row.marketBookCount, 0);
    assert.equal(row.supportBookCount, 0);
    assert.ok(Array.isArray(row.marketBooks));
    assert.ok(Array.isArray(row.supportBooks));
    assert.equal(row.executionQuality, 'unknown');
  });

  it('exposes the misleading consensusBookCount=0 for props with multiple comparison books (Spencer Strider fixture)', () => {
    const payload = [
      {
        league: 'MLB',
        market: 'Pitcher Outs Recorded',
        gameId: 'mlb-strider',
        defaultKey: 'a',
        selections: {
          a: {
            selection1: 'Spencer Strider Over 15.5',
            participant1: 'Spencer Strider',
            selection1Id: 'Pitcher_Outs:Spencer_Strider_Over_15.5',
            line1: 15.5,
            selection2: 'Spencer Strider Under 15.5',
            participant2: 'Spencer Strider',
            selection2Id: 'Pitcher_Outs:Spencer_Strider_Under_15.5',
            line2: 15.5,
            odds: {
              NoVigApp: { odds1: -110, odds2: -110 },
              Pinnacle: { odds1: null, odds2: -104 },
              DraftKings: { odds1: null, odds2: -106 }
            }
          }
        }
      }
    ];

    const ranked = rankScreenRows(payload, {
      limit: 10,
      preferredBooks: ['NoVigApp', 'Pinnacle', 'DraftKings'],
      includeAll: true
    });

    const row = ranked.find((r) => r.participant && r.participant.includes('Spencer Strider') && r.odds === -110);
    assert.ok(row, 'Spencer Strider Over row should exist');
    assert.equal(row.consensusBookCount, 0);
    assert.equal(row.marketBookCount, 0);
    assert.equal(row.supportBookCount, 0);
    assert.ok(Array.isArray(row.marketBooks));
    assert.ok(Array.isArray(row.supportBooks));
    assert.equal(row.executionQuality, 'unknown');
  });

  it('exposes the misleading consensusBookCount=0 for props with multiple comparison books (Jared McCain fixture)', () => {
    const payload = [
      {
        league: 'NBA',
        market: 'Player Points',
        gameId: 'nba-mccain',
        defaultKey: 'a',
        selections: {
          a: {
            selection1: 'Jared McCain Over 7.5',
            participant1: 'Jared McCain',
            selection1Id: 'Player_Points:Jared_McCain_Over_7.5',
            line1: 7.5,
            selection2: 'Jared McCain Under 7.5',
            participant2: 'Jared McCain',
            selection2Id: 'Player_Points:Jared_McCain_Under_7.5',
            line2: 7.5,
            odds: {
              NoVigApp: { odds1: -112, odds2: -108 },
              FanDuel: { odds1: null, odds2: 100 },
              DraftKings: { odds1: null, odds2: -104 }
            }
          }
        }
      }
    ];

    const ranked = rankScreenRows(payload, {
      limit: 10,
      preferredBooks: ['NoVigApp', 'FanDuel', 'DraftKings'],
      includeAll: true
    });

    const row = ranked.find((r) => r.participant && r.participant.includes('Jared McCain') && r.odds === -112);
    assert.ok(row, 'Jared McCain Over row should exist');
    assert.equal(row.consensusBookCount, 0);
    assert.equal(row.marketBookCount, 0);
    assert.equal(row.supportBookCount, 0);
    assert.ok(Array.isArray(row.marketBooks));
    assert.ok(Array.isArray(row.supportBooks));
    assert.equal(row.executionQuality, 'unknown');
  });

  it('exposes marketBookCount and supportBookCount for props with valid comparison book odds', () => {
    const payload = [
      {
        league: 'MLB',
        market: 'Pitcher Outs Recorded',
        gameId: 'mlb-harrison',
        defaultKey: 'a',
        selections: {
          a: {
            selection1: 'Kyle Harrison Over 15.5',
            participant1: 'Kyle Harrison',
            selection1Id: 'Pitcher_Outs:Kyle_Harrison_Over_15.5',
            line1: 15.5,
            selection2: 'Kyle Harrison Under 15.5',
            participant2: 'Kyle Harrison',
            selection2Id: 'Pitcher_Outs:Kyle_Harrison_Under_15.5',
            line2: 15.5,
            odds: {
              NoVigApp: { odds1: -104, odds2: -118 },
              Pinnacle: { odds1: -112, odds2: -108 },
              DraftKings: { odds1: -110, odds2: -110 },
              BetMGM: { odds1: -111, odds2: -109 }
            }
          }
        }
      }
    ];

    const ranked = rankScreenRows(payload, {
      limit: 10,
      preferredBooks: ['NoVigApp', 'Pinnacle', 'DraftKings', 'BetMGM'],
      includeAll: true
    });

    const row = ranked.find((r) => r.participant && r.participant.includes('Kyle Harrison') && r.odds === -104);
    assert.ok(row, 'Kyle Harrison Over row should exist');
    assert.equal(row.consensusBookCount, 3);
    assert.equal(row.marketBookCount, 3);
    assert.deepEqual(row.marketBooks.sort(), ['BetMGM', 'DraftKings', 'Pinnacle'].sort());
    assert.equal(row.supportBookCount, 3);
    assert.deepEqual(row.supportBooks.sort(), ['BetMGM', 'DraftKings', 'Pinnacle'].sort());
    assert.ok(Array.isArray(row.marketBooks));
    assert.ok(Array.isArray(row.supportBooks));
  });

  it('classifies execution quality as best when target book has the best odds', () => {
    const payload = [
      {
        league: 'NBA',
        market: 'Player Points',
        gameId: 'game-eq-1',
        defaultKey: 'a',
        selections: {
          a: {
            selection1: 'Player A Over 10.5',
            participant1: 'Player A',
            selection1Id: 'Player_Points:Player_A_Over_10.5',
            line1: 10.5,
            selection2: 'Player A Under 10.5',
            participant2: 'Player A',
            selection2Id: 'Player_Points:Player_A_Under_10.5',
            line2: 10.5,
            odds: {
              NoVigApp: { odds1: -105, odds2: -115 },
              Pinnacle: { odds1: -110, odds2: -110 },
              DraftKings: { odds1: -108, odds2: -112 }
            }
          }
        }
      }
    ];

    const ranked = rankScreenRows(payload, {
      limit: 10,
      preferredBooks: ['NoVigApp', 'Pinnacle', 'DraftKings'],
      includeAll: true
    });

    const row = ranked.find((r) => r.participant && r.participant.includes('Player A') && r.odds === -105);
    assert.ok(row);
    assert.equal(row.executionQuality, 'best');
    assert.equal(row.targetBookOdds, -105);
    assert.equal(row.bestAvailableOdds, -108);
  });

  it('classifies execution quality as playable when target book is slightly worse than best', () => {
    const payload = [
      {
        league: 'NBA',
        market: 'Player Points',
        gameId: 'game-eq-2',
        defaultKey: 'a',
        selections: {
          a: {
            selection1: 'Player B Over 20.5',
            participant1: 'Player B',
            selection1Id: 'Player_Points:Player_B_Over_20.5',
            line1: 20.5,
            selection2: 'Player B Under 20.5',
            participant2: 'Player B',
            selection2Id: 'Player_Points:Player_B_Under_20.5',
            line2: 20.5,
            odds: {
              NoVigApp: { odds1: -112, odds2: -108 },
              Pinnacle: { odds1: -105, odds2: -115 },
              DraftKings: { odds1: -108, odds2: -112 }
            }
          }
        }
      }
    ];

    const ranked = rankScreenRows(payload, {
      limit: 10,
      preferredBooks: ['NoVigApp', 'Pinnacle', 'DraftKings'],
      includeAll: true
    });

    const row = ranked.find((r) => r.participant && r.participant.includes('Player B') && r.odds === -112);
    assert.ok(row);
    assert.equal(row.executionQuality, 'playable');
    assert.equal(row.targetBookOdds, -112);
    assert.equal(row.bestAvailableOdds, -105);
  });

  it('classifies execution quality as bad when target book is clearly worse', () => {
    const payload = [
      {
        league: 'NBA',
        market: 'Player Points',
        gameId: 'game-eq-3',
        defaultKey: 'a',
        selections: {
          a: {
            selection1: 'Player C Over 5.5',
            participant1: 'Player C',
            selection1Id: 'Player_Points:Player_C_Over_5.5',
            line1: 5.5,
            selection2: 'Player C Under 5.5',
            participant2: 'Player C',
            selection2Id: 'Player_Points:Player_C_Under_5.5',
            line2: 5.5,
            odds: {
              NoVigApp: { odds1: -130, odds2: 110 },
              Pinnacle: { odds1: -105, odds2: -115 },
              DraftKings: { odds1: -108, odds2: -112 }
            }
          }
        }
      }
    ];

    const ranked = rankScreenRows(payload, {
      limit: 10,
      preferredBooks: ['NoVigApp', 'Pinnacle', 'DraftKings'],
      includeAll: true
    });

    const row = ranked.find((r) => r.participant && r.participant.includes('Player C') && r.odds === -130);
    assert.ok(row);
    assert.equal(row.executionQuality, 'bad');
    assert.equal(row.targetBookOdds, -130);
    assert.equal(row.bestAvailableOdds, -105);
  });

  it('kyle_freeland_over_17_5_outs regression: ranked row exposes correct fields', () => {
    const payload = [
      {
        league: 'MLB',
        market: 'Pitcher Outs Recorded',
        gameId: 'mlb-kyle-reg',
        defaultKey: 'a',
        selections: {
          a: {
            selection1: 'Kyle Freeland Over 17.5',
            participant1: 'Kyle Freeland',
            selection1Id: 'Pitcher_Outs:Kyle_Freeland_Over_17.5',
            line1: 17.5,
            selection2: 'Kyle Freeland Under 17.5',
            participant2: 'Kyle Freeland',
            selection2Id: 'Pitcher_Outs:Kyle_Freeland_Under_17.5',
            line2: 17.5,
            odds: {
              NoVigApp: { odds1: 100, odds2: -120 },
              Pinnacle: { odds1: -104, odds2: -112 },
              DraftKings: { odds1: -108, odds2: -108 }
            }
          }
        },
        lineHistory: [
          { book: 'Pinnacle', odds: -112, time: Date.now() - 4 * 60 * 60 * 1000 },
          { book: 'Pinnacle', odds: -104, time: Date.now() - 30 * 60 * 1000 }
        ],
        updatedAt: new Date().toISOString()
      }
    ];

    const ranked = rankScreenRows(payload, {
      limit: 10,
      preferredBooks: ['NoVigApp', 'Pinnacle', 'DraftKings'],
      includeAll: true
    });

    const row = ranked.find((r) => r.participant && r.participant.includes('Kyle Freeland') && r.odds === 100);
    assert.ok(row);
    assert.equal(row.consensusBookCount, 2);
    assert.equal(row.marketBookCount, 2);
    assert.equal(row.supportBookCount, 2);
    assert.equal(row.movementSourceBook, 'Pinnacle');
    assert.equal(row.lineHistoryUsable, true);
    assert.equal(row.executionQuality, 'best');
    assert.ok(row.marketBooks.includes('Pinnacle'));
    assert.ok(row.marketBooks.includes('DraftKings'));
  });

  it('jared_mccain_over_7_5_points regression: ranked row exposes correct fields', () => {
    const payload = [
      {
        league: 'NBA',
        market: 'Player Points',
        gameId: 'nba-mccain-reg',
        defaultKey: 'a',
        selections: {
          a: {
            selection1: 'Jared McCain Over 7.5',
            participant1: 'Jared McCain',
            selection1Id: 'Player_Points:Jared_McCain_Over_7.5',
            line1: 7.5,
            selection2: 'Jared McCain Under 7.5',
            participant2: 'Jared McCain',
            selection2Id: 'Player_Points:Jared_McCain_Under_7.5',
            line2: 7.5,
            odds: {
              NoVigApp: { odds1: -112, odds2: -108 },
              FanDuel: { odds1: -120, odds2: 100 },
              DraftKings: { odds1: -116, odds2: -104 }
            }
          }
        },
        lineHistory: [
          { book: 'FanDuel', odds: -130, time: Date.now() - 3 * 60 * 60 * 1000 },
          { book: 'FanDuel', odds: -120, time: Date.now() - 45 * 60 * 1000 }
        ],
        updatedAt: new Date().toISOString()
      }
    ];

    const ranked = rankScreenRows(payload, {
      limit: 10,
      preferredBooks: ['NoVigApp', 'FanDuel', 'DraftKings'],
      includeAll: true
    });

    const row = ranked.find((r) => r.participant && r.participant.includes('Jared McCain') && r.odds === -112);
    assert.ok(row);
    assert.equal(row.consensusBookCount, 2);
    assert.equal(row.marketBookCount, 2);
    assert.equal(row.supportBookCount, 2);
    assert.equal(row.movementSourceBook, 'FanDuel');
    assert.equal(row.lineHistoryUsable, true);
    assert.equal(row.executionQuality, 'best');
  });

  it('tigers_ml target-book-only movement regression: still has target book as movement source', () => {
    const payload = [
      {
        league: 'MLB',
        market: 'Moneyline',
        gameId: 'mlb-tigers-reg',
        homeTeam: 'Detroit Tigers',
        awayTeam: 'New York Yankees',
        defaultKey: 'a',
        selections: {
          a: {
            selection1: 'Detroit Tigers',
            participant1: 'Detroit Tigers',
            selection1Id: 'Moneyline:Detroit_Tigers',
            selection2: 'New York Yankees',
            participant2: 'New York Yankees',
            selection2Id: 'Moneyline:New_York_Yankees',
            odds: {
              NoVigApp: { odds1: 135, odds2: -155 },
              Pinnacle: { odds1: 130, odds2: -150 },
              DraftKings: { odds1: 128, odds2: -148 }
            }
          }
        },
        lineHistory: [
          { book: 'NoVigApp', odds: 120, time: Date.now() - 5 * 60 * 60 * 1000 },
          { book: 'NoVigApp', odds: 135, time: Date.now() - 30 * 60 * 1000 }
        ],
        updatedAt: new Date().toISOString()
      }
    ];

    const ranked = rankScreenRows(payload, {
      limit: 10,
      preferredBooks: ['NoVigApp', 'Pinnacle', 'DraftKings'],
      includeAll: true
    });

    const row = ranked.find((r) => r.participant && r.participant.includes('Detroit Tigers'));
    assert.ok(row);
    assert.equal(row.movementSourceBook, 'NoVigApp');
    assert.equal(row.consensusBookCount, 2);
    assert.equal(row.executionQuality, 'best');
  });
});

describe('extractScreenRows consensus preservation (v2.1.6 live-shape regression)', () => {
  // v2.1.6 regression: the upstream /screen response for non-prop markets
  // arrives as `selections: { null: { ...lifted fields, odds: { full book map } } }`
  // with `defaultKey: null`. `normalizeRow` lifts `selections.null.*` to the
  // top level and clears `selections`, leaving the full odds map at the top
  // level as `row.odds`. `extractScreenRows` was overriding `odds` with the
  // per-book number and dropping the full map on the floor — the ranker then
  // couldn't compute consensus and every row cascaded to consensusBookCount=0 /
  // TIER 4 / PASS. The fix preserves the full map as `allBookOdds` and the
  // ranker reconstructs `selections.null` from the lifted fields.

  it('preserves the full odds map on expanded rows so the ranker finds real consensus', () => {
    const payload = {
      game_data: [
        {
          league: 'MLB',
          market: 'Moneyline',
          gameId: 'MLB:PREMATCH:Athletics:Pittsburgh_Pirates:1781574000',
          homeTeam: 'Athletics',
          awayTeam: 'Pittsburgh Pirates',
          isLive: false,
          defaultKey: null,
          selections: {
            null: {
              selection1: 'Athletics',
              participant1: 'Athletics',
              selectionType1: 'home',
              selection1Id: 'Moneyline:Athletics',
              line1: null,
              selection2: 'Pittsburgh Pirates',
              participant2: 'Pittsburgh Pirates',
              selectionType2: 'away',
              selection2Id: 'Moneyline:Pittsburgh_Pirates',
              line2: null,
              odds: {
                Pinnacle: { odds1: -122, odds2: 110 },
                BetOnline: { odds1: -125, odds2: 113 },
                Circa: { odds1: -122, odds2: 110 },
                DraftKings: { odds1: -131, odds2: 108 }
              }
            }
          }
        }
      ]
    };

    const expanded = extractScreenRows(payload, [{ book: 'Pinnacle' }]);
    assert.equal(expanded.length, 2);

    // The per-book number is preserved (caller contract unchanged)
    assert.equal(typeof expanded[0].odds, 'number');
    assert.equal(expanded[0].odds, -122);
    assert.equal(expanded[0].currentOdds, -122);

    // The full odds map is now preserved as `allBookOdds` (the fix)
    assert.ok(expanded[0].allBookOdds, 'allBookOdds should be set');
    assert.deepEqual(Object.keys(expanded[0].allBookOdds).sort(), ['BetOnline', 'Circa', 'DraftKings', 'Pinnacle']);

    // And the ranker now finds real consensus from the preserved map
    const ranked = rankScreenRows(expanded, {
      limit: 5,
      preferredBooks: ['Pinnacle', 'BetOnline', 'Circa', 'DraftKings'],
      includeAll: true
    });
    assert.equal(ranked.length, 2);
    assert.ok(
      ranked.every((r) => r.consensusBookCount === 3),
      '3 comp books for each side'
    );
    assert.ok(
      ranked.every((r) => r.hasConsensus),
      'hasConsensus should be true'
    );
    assert.ok(
      ranked.every((r) => r.executionQuality !== 'unknown'),
      'executionQuality should be classified'
    );
    assert.ok(
      ranked.every((r) => Number.isFinite(r.consensusEdge)),
      'consensusEdge should be a number'
    );
    assert.ok(
      ranked.every((r) => r.consensusStrength === 'strong'),
      '3 comp books is a strong consensus'
    );
  });

  it('falls back to all books when the focus book is missing (v2.1.2 behavior preserved)', () => {
    // v2.1.2 fix: if the focus book has no odds in a row, fall back to all
    // books in the row. The v2.1.6 fix must not regress this — when the
    // per-book row is produced, allBookOdds should still carry the full map.
    const payload = {
      game_data: [
        {
          league: 'UFC',
          market: 'Moneyline',
          gameId: 'UFC:PREMATCH:Atmane:Muller:1',
          homeTeam: 'Atmane',
          awayTeam: 'Muller',
          isLive: false,
          defaultKey: null,
          selections: {
            null: {
              selection1: 'Atmane',
              participant1: 'Atmane',
              selection1Id: 'Moneyline:Atmane',
              line1: null,
              selection2: 'Muller',
              participant2: 'Muller',
              selection2Id: 'Moneyline:Muller',
              line2: null,
              odds: {
                NoVigApp: { odds1: 116, odds2: -136 },
                BetOnline: { odds1: 120, odds2: -140 },
                Caesars: { odds1: 118, odds2: -138 }
                // Pinnacle intentionally missing — UFC moneylines aren't posted
              }
            }
          }
        }
      ]
    };

    // Ask for Pinnacle focus; the v2.1.2 fallback should surface all 3 books
    const expanded = extractScreenRows(payload, [{ book: 'Pinnacle' }]);
    assert.ok(expanded.length >= 2, 'should produce at least the 2 sides');

    // And the per-row allBookOdds should carry the full map (so the ranker
    // can compute consensus regardless of which books posted odds)
    for (const row of expanded) {
      assert.ok(row.allBookOdds, 'allBookOdds set on each expanded row');
      assert.ok(Object.keys(row.allBookOdds).length >= 3);
    }
  });

  it('does not regress the per-book odds contract (odds stays a number, not the map)', () => {
    // Caller contract: `row.odds` is the per-book American odds (a number).
    // The v2.1.6 fix adds `allBookOdds` but must not change the type or
    // value of `odds`/`currentOdds` — many consumers (formatters, the
    // stake plan, downstream tools) read `row.odds` directly.
    const payload = {
      game_data: [
        {
          league: 'NBA',
          market: 'Moneyline',
          gameId: 'NBA:PREMATCH:LAL:BOS:1',
          homeTeam: 'Lakers',
          awayTeam: 'Celtics',
          defaultKey: null,
          selections: {
            null: {
              selection1: 'Lakers',
              participant1: 'Lakers',
              selection1Id: 'Moneyline:Lakers',
              line1: null,
              selection2: 'Celtics',
              participant2: 'Celtics',
              selection2Id: 'Moneyline:Celtics',
              line2: null,
              odds: {
                Pinnacle: { odds1: -110, odds2: -110 },
                DraftKings: { odds1: -108, odds2: -112 }
              }
            }
          }
        }
      ]
    };

    const expanded = extractScreenRows(payload, [{ book: 'Pinnacle' }]);
    assert.equal(expanded.length, 2);
    for (const row of expanded) {
      assert.equal(typeof row.odds, 'number', 'odds stays a number');
      assert.equal(typeof row.currentOdds, 'number', 'currentOdds stays a number');
      assert.equal(row.odds, row.currentOdds, 'odds and currentOdds match');
      assert.ok(row.allBookOdds, 'allBookOdds is set');
      assert.equal(typeof row.allBookOdds, 'object', 'allBookOdds is the full map');
    }
  });
});
