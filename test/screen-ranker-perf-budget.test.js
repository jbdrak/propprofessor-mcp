'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { rankScreenRows } = require('../lib/screen-ranker');

// Trimmed real screen rows keep the ranking gates realistic without checking
// in generated output-only fields or depending on the ignored local snapshot.
const BASE_ROWS = [
  {
    id: 'WNBA:PREMATCH:Las_Vegas_Aces:New_York_Liberty:1786293000:Las Vegas Aces',
    gameId: 'WNBA:PREMATCH:Las_Vegas_Aces:New_York_Liberty:1786293000',
    start: '2026-08-09T16:30:00.000Z',
    league: 'WNBA',
    homeTeam: 'Las Vegas Aces',
    awayTeam: 'New York Liberty',
    isLive: false,
    market: 'Moneyline',
    participant: 'New York Liberty',
    selections: {
      null: {
        selection1: 'Las Vegas Aces',
        participant1: 'Las Vegas Aces',
        selectionType1: null,
        selection1Id: 'Moneyline:Las_Vegas_Aces',
        line1: null,
        selection2: 'New York Liberty',
        participant2: 'New York Liberty',
        selectionType2: null,
        selection2Id: 'Moneyline:New_York_Liberty',
        line2: null,
        odds: {
          NoVigApp: {
            book: 'NoVigApp',
            odds1: 335,
            odds2: -355,
            liquidity1: 179,
            liquidity2: 277
          },
          theScore: {
            book: 'theScore',
            odds1: 360,
            odds2: -500,
            liquidity1: 0,
            liquidity2: 0
          },
          Kalshi: {
            book: 'Kalshi',
            odds1: 296,
            odds2: -381,
            liquidity1: 695,
            liquidity2: 8076
          },
          '4cx': {
            book: '4cx',
            odds1: 279,
            odds2: -419,
            liquidity1: 191,
            liquidity2: 959
          },
          BetRivers: {
            book: 'BetRivers',
            odds1: 295,
            odds2: -400,
            liquidity1: 0,
            liquidity2: 0
          },
          BetMGM: {
            book: 'BetMGM',
            odds1: 325,
            odds2: -425,
            liquidity1: 0,
            liquidity2: 0
          },
          Rebet: {
            book: 'Rebet',
            odds1: 320,
            odds2: -469,
            liquidity1: 0,
            liquidity2: 0
          },
          Circa: {
            book: 'Circa',
            odds1: 350,
            odds2: -435,
            liquidity1: 0,
            liquidity2: 0
          },
          OnyxOdds: {
            book: 'OnyxOdds',
            odds1: 340,
            odds2: -440,
            liquidity1: 0,
            liquidity2: 0
          },
          Bet105: {
            book: 'Bet105',
            odds1: 314,
            odds2: -412,
            liquidity1: 500,
            liquidity2: 500
          },
          BetOnline: {
            book: 'BetOnline',
            odds1: 344,
            odds2: -440,
            liquidity1: 0,
            liquidity2: 0
          },
          Fliff: {
            book: 'Fliff',
            odds1: 300,
            odds2: -425,
            liquidity1: 0,
            liquidity2: 0
          },
          Pinnacle: {
            book: 'Pinnacle',
            odds1: 314,
            odds2: -413,
            liquidity1: 1000,
            liquidity2: 1000
          },
          Fanatics: {
            book: 'Fanatics',
            odds1: 340,
            odds2: -450,
            liquidity1: 0,
            liquidity2: 0
          },
          Polymarket: {
            book: 'Polymarket',
            odds1: 318,
            odds2: -372,
            liquidity1: 400,
            liquidity2: 3330
          },
          Prophet: {
            book: 'Prophet',
            odds1: 318,
            odds2: -357,
            liquidity1: 47,
            liquidity2: 183
          },
          DraftKings: {
            book: 'DraftKings',
            odds1: 340,
            odds2: -440,
            liquidity1: 0,
            liquidity2: 0
          },
          Caesars: {
            book: 'Caesars',
            odds1: 345,
            odds2: -455,
            liquidity1: 0,
            liquidity2: 0
          },
          FanDuel: {
            book: 'FanDuel',
            odds1: 350,
            odds2: -480,
            liquidity1: 0,
            liquidity2: 0
          },
          Bovada: {
            book: 'Bovada',
            odds1: 310,
            odds2: -415,
            liquidity1: 0,
            liquidity2: 0
          }
        }
      }
    },
    selection1: 'Las Vegas Aces',
    participant1: 'Las Vegas Aces',
    selection1Id: 'Moneyline:Las_Vegas_Aces',
    selection2: 'New York Liberty',
    participant2: 'New York Liberty',
    selection2Id: 'Moneyline:New_York_Liberty',
    odds: -355,
    book: 'NoVigApp',
    playType: 'Moneyline',
    game: 'Las Vegas Aces vs New York Liberty',
    pick: 'New York Liberty',
    selection: 'New York Liberty',
    allBookOdds: {
      NoVigApp: {
        book: 'NoVigApp',
        odds1: 335,
        odds2: -355,
        liquidity1: 179,
        liquidity2: 277
      },
      theScore: {
        book: 'theScore',
        odds1: 360,
        odds2: -500,
        liquidity1: 0,
        liquidity2: 0
      },
      Kalshi: {
        book: 'Kalshi',
        odds1: 296,
        odds2: -381,
        liquidity1: 695,
        liquidity2: 8076
      },
      '4cx': {
        book: '4cx',
        odds1: 279,
        odds2: -419,
        liquidity1: 191,
        liquidity2: 959
      },
      BetRivers: {
        book: 'BetRivers',
        odds1: 295,
        odds2: -400,
        liquidity1: 0,
        liquidity2: 0
      },
      BetMGM: {
        book: 'BetMGM',
        odds1: 325,
        odds2: -425,
        liquidity1: 0,
        liquidity2: 0
      },
      Rebet: {
        book: 'Rebet',
        odds1: 320,
        odds2: -469,
        liquidity1: 0,
        liquidity2: 0
      },
      Circa: {
        book: 'Circa',
        odds1: 350,
        odds2: -435,
        liquidity1: 0,
        liquidity2: 0
      },
      OnyxOdds: {
        book: 'OnyxOdds',
        odds1: 340,
        odds2: -440,
        liquidity1: 0,
        liquidity2: 0
      },
      Bet105: {
        book: 'Bet105',
        odds1: 314,
        odds2: -412,
        liquidity1: 500,
        liquidity2: 500
      },
      BetOnline: {
        book: 'BetOnline',
        odds1: 344,
        odds2: -440,
        liquidity1: 0,
        liquidity2: 0
      },
      Fliff: {
        book: 'Fliff',
        odds1: 300,
        odds2: -425,
        liquidity1: 0,
        liquidity2: 0
      },
      Pinnacle: {
        book: 'Pinnacle',
        odds1: 314,
        odds2: -413,
        liquidity1: 1000,
        liquidity2: 1000
      },
      Fanatics: {
        book: 'Fanatics',
        odds1: 340,
        odds2: -450,
        liquidity1: 0,
        liquidity2: 0
      },
      Polymarket: {
        book: 'Polymarket',
        odds1: 318,
        odds2: -372,
        liquidity1: 400,
        liquidity2: 3330
      },
      Prophet: {
        book: 'Prophet',
        odds1: 318,
        odds2: -357,
        liquidity1: 47,
        liquidity2: 183
      },
      DraftKings: {
        book: 'DraftKings',
        odds1: 340,
        odds2: -440,
        liquidity1: 0,
        liquidity2: 0
      },
      Caesars: {
        book: 'Caesars',
        odds1: 345,
        odds2: -455,
        liquidity1: 0,
        liquidity2: 0
      },
      FanDuel: {
        book: 'FanDuel',
        odds1: 350,
        odds2: -480,
        liquidity1: 0,
        liquidity2: 0
      },
      Bovada: {
        book: 'Bovada',
        odds1: 310,
        odds2: -415,
        liquidity1: 0,
        liquidity2: 0
      }
    },
    currentOdds: -355,
    liquidityUsd: 277,
    selectionId: 'Moneyline:New_York_Liberty',
    lineHistory: [
      {
        line: null,
        odds: -463,
        book: '4cx',
        time: 1786245540689,
        liquidity: 579
      },
      {
        line: null,
        odds: -445,
        book: '4cx',
        time: 1786245569693,
        liquidity: 1042
      },
      {
        line: null,
        odds: -440,
        book: 'Fliff',
        time: 1786245596160,
        liquidity: 0
      },
      {
        line: null,
        odds: -376,
        book: 'NoVigApp',
        time: 1786245956572,
        liquidity: 57
      },
      {
        line: null,
        odds: -435,
        book: 'Fliff',
        time: 1786246217082,
        liquidity: 0
      },
      {
        line: null,
        odds: -388,
        book: 'NoVigApp',
        time: 1786246259949,
        liquidity: 871
      },
      {
        line: null,
        odds: -378,
        book: 'Prophet',
        time: 1786246495144,
        liquidity: 248
      },
      {
        line: null,
        odds: -383,
        book: 'Prophet',
        time: 1786246604253,
        liquidity: 188
      },
      {
        line: null,
        odds: -398,
        book: 'Prophet',
        time: 1786246627293,
        liquidity: 609
      },
      {
        line: null,
        odds: -393,
        book: 'Prophet',
        time: 1786247192016,
        liquidity: 235
      },
      {
        line: null,
        odds: -469,
        book: 'Rebet',
        time: 1786247273111,
        liquidity: 0
      },
      {
        line: null,
        odds: -425,
        book: 'Fliff',
        time: 1786247362977,
        liquidity: 0
      },
      {
        line: null,
        odds: -381,
        book: 'Kalshi',
        time: 1786247519970,
        liquidity: 8076
      },
      {
        line: null,
        odds: -388,
        book: 'Prophet',
        time: 1786247520390,
        liquidity: 95
      },
      {
        line: null,
        odds: -367,
        book: 'Prophet',
        time: 1786247521394,
        liquidity: 101
      },
      {
        line: null,
        odds: -362,
        book: 'Prophet',
        time: 1786247524387,
        liquidity: 266
      },
      {
        line: null,
        odds: -355,
        book: 'NoVigApp',
        time: 1786247525352,
        liquidity: 277
      },
      {
        line: null,
        odds: -455,
        book: 'BetRivers',
        time: 1786247551136,
        liquidity: 0
      },
      {
        line: null,
        odds: -357,
        book: 'Prophet',
        time: 1786247569452,
        liquidity: 183
      },
      {
        line: null,
        odds: -420,
        book: '4cx',
        time: 1786247621128,
        liquidity: 2208
      },
      {
        line: null,
        odds: -419,
        book: '4cx',
        time: 1786247631171,
        liquidity: 959
      },
      {
        line: null,
        odds: -400,
        book: 'BetRivers',
        time: 1786247704183,
        liquidity: 0
      },
      {
        line: null,
        odds: -372,
        book: 'Polymarket',
        time: 1786247707345,
        liquidity: 3330
      },
      {
        line: null,
        odds: -500,
        book: 'theScore',
        time: 1786247722043,
        liquidity: 0
      }
    ],
    lineHistoryAvailable: true,
    lineHistorySource: 'odds_history',
    lineHistoryLookbackHours: 6,
    normalizedSelectionId: 'Moneyline:New_York_Liberty',
    historyGameId: 'WNBA:PREMATCH:Las_Vegas_Aces:New_York_Liberty:1786293000',
    historyMatchedBy: 'selectionId',
    historyMatchKey: 'selectionId',
    historySportsbooksRequested: [
      '4cx',
      'BallyBet',
      'Bet105',
      'BetMGM',
      'BetOnline',
      'BetParx',
      'BetRivers',
      'BookMaker',
      'Bovada',
      'Caesars',
      'Circa',
      'DraftKings',
      'Fanatics',
      'FanaticsMarkets',
      'FanDuel',
      'Fliff',
      'Kalshi',
      'NoVigApp',
      'OnyxOdds',
      'Pinnacle',
      'Polymarket',
      'Prop Builder',
      'Prophet',
      'Rebet',
      'theScore',
      'PrizePicks',
      'Betr',
      'Dabble',
      'DraftKings6',
      'OwnersBox',
      'Sleeper',
      'ParlayPlay',
      'HotStreak',
      'BoomFantasy',
      'Betr (Alt)',
      'Dabble (Alt)',
      'DraftKings6 (Alt)',
      'Rebet (Alt)',
      'Underdog (Alt)'
    ],
    lineFieldMissingCount: 0,
    consensusEdge: 2.946812375387464,
    hasConsensus: true,
    edgeSanityFlag: 'ok',
    focusBookMissing: false,
    consensusBookCount: 19,
    consensusStrength: 'strong',
    compDataMissing: false,
    marketBookCount: 19,
    marketBooks: [
      'theScore',
      'Kalshi',
      '4cx',
      'BetRivers',
      'BetMGM',
      'Rebet',
      'Circa',
      'OnyxOdds',
      'Bet105',
      'BetOnline',
      'Fliff',
      'Pinnacle',
      'Fanatics',
      'Polymarket',
      'Prophet',
      'DraftKings',
      'Caesars',
      'FanDuel',
      'Bovada'
    ],
    supportBookCount: 19,
    supportBooks: [
      'theScore',
      'Kalshi',
      '4cx',
      'BetRivers',
      'BetMGM',
      'Rebet',
      'Circa',
      'OnyxOdds',
      'Bet105',
      'BetOnline',
      'Fliff',
      'Pinnacle',
      'Fanatics',
      'Polymarket',
      'Prophet',
      'DraftKings',
      'Caesars',
      'FanDuel',
      'Bovada'
    ],
    targetBookOdds: -355,
    bestAvailableOdds: -357,
    executionQuality: 'best',
    steamMove: false,
    steamDirection: 'up',
    steamBookCount: 0,
    steamMoveLegacy: false,
    steamDirectionLegacy: 'up',
    steamBookCountLegacy: 0,
    multiWindowScore: 0,
    consensusWindowCount: 0,
    totalConsensusWindows: 6,
    multiWindowConfirmedBooks: 0,
    multiWindowRequiredBooks: 2,
    multiWindowInsufficientData: false,
    clvProxyPct: 6.512006512006508,
    openingOdds: -251,
    freshnessSource: 'response_received',
    freshnessFallbackUsed: true,
    stale: false,
    screenMarket: 'moneyline',
    leaguePreset: 'WNBA',
    marketHintMatch: 'moneyline',
    screenScore: 16.673,
    preferredBookMatch: true,
    gatePassed: true,
    hasLineMovement: true,
    isActionable: true,
    movementDisposition: 'supportive_bouncy',
    movementGrade: 'yellow',
    riskScore: 2,
    kaiCall: 'BET',
    confidenceTier: 'TIER 1',
    confidenceTierLive: 'TIER 1',
    tierTrajectory: {
      trend: 'new',
      volatility: 'unknown',
      dataPoints: 1,
      currentRisk: 2,
      avgRisk: 2,
      riskRange: 0
    },
    rationale:
      'New York Liberty \u2014 19 books \u2014 2.95% edge \u2014 supportive_bouncy \u2014 best \u2014 6.51% CLV \u2014 \ud83d\udfe1 TIER 1',
    reasonCodes: ['SUPPORTIVE_MOVEMENT', 'CONSENSUS_8_PLUS', 'EDGE_SIGNIFICANT', 'CLV_POSITIVE'],
    movementSourceBook: 'NoVigApp',
    movementMode: 'same_book',
    movementLabel: 'supportive',
    movementPointCount: 40,
    filteredHistoryPointCount: 428,
    droppedHistoryPointCount: 0,
    movementQuality: 'high',
    movementQualityScore: 0.95,
    lineHistoryUsable: true,
    recentClvPct: 6.512006512006508,
    recentWindowHours: 6,
    recentSharpMoveDirection: 'supportive',
    fullWindowSharpMoveDirection: 'supportive',
    openToCurrentClvPct: 6.512006512006508,
    peakAdverseClvPct: 0,
    minClvPct: 0,
    selectionKey: 'new york liberty',
    playId: 'WNBA:PREMATCH:Las_Vegas_Aces:New_York_Liberty:1786293000::Moneyline::new york liberty'
  },
  {
    id: 'WNBA:PREMATCH:Dallas_Wings:Minnesota_Lynx:1786303800:Dallas Wings',
    gameId: 'WNBA:PREMATCH:Dallas_Wings:Minnesota_Lynx:1786303800',
    start: '2026-08-09T19:30:00.000Z',
    league: 'WNBA',
    homeTeam: 'Dallas Wings',
    awayTeam: 'Minnesota Lynx',
    isLive: false,
    market: 'Moneyline',
    participant: 'Dallas Wings',
    selections: {
      null: {
        selection1: 'Dallas Wings',
        participant1: 'Dallas Wings',
        selectionType1: null,
        selection1Id: 'Moneyline:Dallas_Wings',
        line1: null,
        selection2: 'Minnesota Lynx',
        participant2: 'Minnesota Lynx',
        selectionType2: null,
        selection2Id: 'Moneyline:Minnesota_Lynx',
        line2: null,
        odds: {
          OnyxOdds: {
            book: 'OnyxOdds',
            odds1: 205,
            odds2: -250,
            liquidity1: 0,
            liquidity2: 0
          },
          NoVigApp: {
            book: 'NoVigApp',
            odds1: 228,
            odds2: -239,
            liquidity1: 209,
            liquidity2: 370
          },
          DraftKings: {
            book: 'DraftKings',
            odds1: 205,
            odds2: -250,
            liquidity1: 0,
            liquidity2: 0
          },
          Circa: {
            book: 'Circa',
            odds1: 210,
            odds2: -245,
            liquidity1: 0,
            liquidity2: 0
          },
          BetRivers: {
            book: 'BetRivers',
            odds1: 210,
            odds2: -275,
            liquidity1: 0,
            liquidity2: 0
          },
          theScore: {
            book: 'theScore',
            odds1: 210,
            odds2: -250,
            liquidity1: 0,
            liquidity2: 0
          },
          Polymarket: {
            book: 'Polymarket',
            odds1: 222,
            odds2: -257,
            liquidity1: 19,
            liquidity2: 2784
          },
          Fanatics: {
            book: 'Fanatics',
            odds1: 210,
            odds2: -260,
            liquidity1: 0,
            liquidity2: 0
          },
          Bovada: {
            book: 'Bovada',
            odds1: null,
            odds2: -260,
            liquidity1: null,
            liquidity2: 0
          },
          Bet105: {
            book: 'Bet105',
            odds1: 209,
            odds2: -263,
            liquidity1: 500,
            liquidity2: 500
          },
          Fliff: {
            book: 'Fliff',
            odds1: 215,
            odds2: -295,
            liquidity1: 0,
            liquidity2: 0
          },
          Kalshi: {
            book: 'Kalshi',
            odds1: 208,
            odds2: -251,
            liquidity1: 2426,
            liquidity2: 1338
          },
          Rebet: {
            book: 'Rebet',
            odds1: 195,
            odds2: -260,
            liquidity1: 0,
            liquidity2: 0
          },
          BetMGM: {
            book: 'BetMGM',
            odds1: 210,
            odds2: -250,
            liquidity1: 0,
            liquidity2: 0
          },
          Caesars: {
            book: 'Caesars',
            odds1: 210,
            odds2: -260,
            liquidity1: 0,
            liquidity2: 0
          },
          Pinnacle: {
            book: 'Pinnacle',
            odds1: 209,
            odds2: -263,
            liquidity1: 1000,
            liquidity2: 1000
          },
          FanDuel: {
            book: 'FanDuel',
            odds1: 210,
            odds2: -265,
            liquidity1: 0,
            liquidity2: 0
          },
          BetOnline: {
            book: 'BetOnline',
            odds1: 207,
            odds2: -250,
            liquidity1: 0,
            liquidity2: 0
          },
          Prophet: {
            book: 'Prophet',
            odds1: 216,
            odds2: -245,
            liquidity1: 302,
            liquidity2: 282
          },
          '4cx': {
            book: '4cx',
            odds1: 197,
            odds2: -292,
            liquidity1: 170,
            liquidity2: 660
          }
        }
      }
    },
    selection1: 'Dallas Wings',
    participant1: 'Dallas Wings',
    selection1Id: 'Moneyline:Dallas_Wings',
    selection2: 'Minnesota Lynx',
    participant2: 'Minnesota Lynx',
    selection2Id: 'Moneyline:Minnesota_Lynx',
    odds: 228,
    book: 'NoVigApp',
    playType: 'Moneyline',
    game: 'Dallas Wings vs Minnesota Lynx',
    pick: 'Dallas Wings',
    selection: 'Dallas Wings',
    allBookOdds: {
      OnyxOdds: {
        book: 'OnyxOdds',
        odds1: 205,
        odds2: -250,
        liquidity1: 0,
        liquidity2: 0
      },
      NoVigApp: {
        book: 'NoVigApp',
        odds1: 228,
        odds2: -239,
        liquidity1: 209,
        liquidity2: 370
      },
      DraftKings: {
        book: 'DraftKings',
        odds1: 205,
        odds2: -250,
        liquidity1: 0,
        liquidity2: 0
      },
      Circa: {
        book: 'Circa',
        odds1: 210,
        odds2: -245,
        liquidity1: 0,
        liquidity2: 0
      },
      BetRivers: {
        book: 'BetRivers',
        odds1: 210,
        odds2: -275,
        liquidity1: 0,
        liquidity2: 0
      },
      theScore: {
        book: 'theScore',
        odds1: 210,
        odds2: -250,
        liquidity1: 0,
        liquidity2: 0
      },
      Polymarket: {
        book: 'Polymarket',
        odds1: 222,
        odds2: -257,
        liquidity1: 19,
        liquidity2: 2784
      },
      Fanatics: {
        book: 'Fanatics',
        odds1: 210,
        odds2: -260,
        liquidity1: 0,
        liquidity2: 0
      },
      Bovada: {
        book: 'Bovada',
        odds1: null,
        odds2: -260,
        liquidity1: null,
        liquidity2: 0
      },
      Bet105: {
        book: 'Bet105',
        odds1: 209,
        odds2: -263,
        liquidity1: 500,
        liquidity2: 500
      },
      Fliff: {
        book: 'Fliff',
        odds1: 215,
        odds2: -295,
        liquidity1: 0,
        liquidity2: 0
      },
      Kalshi: {
        book: 'Kalshi',
        odds1: 208,
        odds2: -251,
        liquidity1: 2426,
        liquidity2: 1338
      },
      Rebet: {
        book: 'Rebet',
        odds1: 195,
        odds2: -260,
        liquidity1: 0,
        liquidity2: 0
      },
      BetMGM: {
        book: 'BetMGM',
        odds1: 210,
        odds2: -250,
        liquidity1: 0,
        liquidity2: 0
      },
      Caesars: {
        book: 'Caesars',
        odds1: 210,
        odds2: -260,
        liquidity1: 0,
        liquidity2: 0
      },
      Pinnacle: {
        book: 'Pinnacle',
        odds1: 209,
        odds2: -263,
        liquidity1: 1000,
        liquidity2: 1000
      },
      FanDuel: {
        book: 'FanDuel',
        odds1: 210,
        odds2: -265,
        liquidity1: 0,
        liquidity2: 0
      },
      BetOnline: {
        book: 'BetOnline',
        odds1: 207,
        odds2: -250,
        liquidity1: 0,
        liquidity2: 0
      },
      Prophet: {
        book: 'Prophet',
        odds1: 216,
        odds2: -245,
        liquidity1: 302,
        liquidity2: 282
      },
      '4cx': {
        book: '4cx',
        odds1: 197,
        odds2: -292,
        liquidity1: 170,
        liquidity2: 660
      }
    },
    currentOdds: 228,
    liquidityUsd: 209,
    selectionId: 'Moneyline:Dallas_Wings',
    lineHistory: [
      {
        line: null,
        odds: 216,
        book: 'Prophet',
        time: 1786247358194,
        liquidity: 107
      },
      {
        line: null,
        odds: 188,
        book: '4cx',
        time: 1786247365698,
        liquidity: 1106
      },
      {
        line: null,
        odds: 189,
        book: '4cx',
        time: 1786247369710,
        liquidity: 177
      },
      {
        line: null,
        odds: 217,
        book: 'NoVigApp',
        time: 1786247387194,
        liquidity: 69
      },
      {
        line: null,
        odds: 223,
        book: 'NoVigApp',
        time: 1786247388175,
        liquidity: 14
      },
      {
        line: null,
        odds: 217,
        book: 'NoVigApp',
        time: 1786247407231,
        liquidity: 71
      },
      {
        line: null,
        odds: 223,
        book: 'NoVigApp',
        time: 1786247408201,
        liquidity: 27
      },
      {
        line: null,
        odds: 217,
        book: 'NoVigApp',
        time: 1786247420211,
        liquidity: 71
      },
      {
        line: null,
        odds: 223,
        book: 'NoVigApp',
        time: 1786247421217,
        liquidity: 28
      },
      {
        line: null,
        odds: 208,
        book: 'Kalshi',
        time: 1786247471702,
        liquidity: 2426
      },
      {
        line: null,
        odds: 195,
        book: 'Rebet',
        time: 1786247496419,
        liquidity: 0
      },
      {
        line: null,
        odds: 210,
        book: 'BetRivers',
        time: 1786247512179,
        liquidity: 0
      },
      {
        line: null,
        odds: 228,
        book: 'NoVigApp',
        time: 1786247521364,
        liquidity: 209
      },
      {
        line: null,
        odds: 209,
        book: 'Pinnacle',
        time: 1786247547363,
        liquidity: 1000
      },
      {
        line: null,
        odds: 209,
        book: 'Bet105',
        time: 1786247559567,
        liquidity: 500
      },
      {
        line: null,
        odds: 184,
        book: '4cx',
        time: 1786247567015,
        liquidity: 298
      },
      {
        line: null,
        odds: 210,
        book: 'BetMGM',
        time: 1786247571211,
        liquidity: 0
      },
      {
        line: null,
        odds: 194,
        book: '4cx',
        time: 1786247596093,
        liquidity: 933
      },
      {
        line: null,
        odds: 220,
        book: 'Prophet',
        time: 1786247610513,
        liquidity: 23
      },
      {
        line: null,
        odds: 195,
        book: '4cx',
        time: 1786247615071,
        liquidity: 172
      },
      {
        line: null,
        odds: 196,
        book: '4cx',
        time: 1786247621128,
        liquidity: 1238
      },
      {
        line: null,
        odds: 197,
        book: '4cx',
        time: 1786247625084,
        liquidity: 170
      },
      {
        line: null,
        odds: 216,
        book: 'Prophet',
        time: 1786247649543,
        liquidity: 302
      },
      {
        line: null,
        odds: 222,
        book: 'Polymarket',
        time: 1786247707345,
        liquidity: 19
      }
    ],
    lineHistoryAvailable: true,
    lineHistorySource: 'odds_history',
    lineHistoryLookbackHours: 6,
    normalizedSelectionId: 'Moneyline:Dallas_Wings',
    historyGameId: 'WNBA:PREMATCH:Dallas_Wings:Minnesota_Lynx:1786303800',
    historyMatchedBy: 'selectionId',
    historyMatchKey: 'selectionId',
    historySportsbooksRequested: [
      '4cx',
      'BallyBet',
      'Bet105',
      'BetMGM',
      'BetOnline',
      'BetParx',
      'BetRivers',
      'BookMaker',
      'Bovada',
      'Caesars',
      'Circa',
      'DraftKings',
      'Fanatics',
      'FanaticsMarkets',
      'FanDuel',
      'Fliff',
      'Kalshi',
      'NoVigApp',
      'OnyxOdds',
      'Pinnacle',
      'Polymarket',
      'Prop Builder',
      'Prophet',
      'Rebet',
      'theScore',
      'PrizePicks',
      'Betr',
      'Dabble',
      'DraftKings6',
      'OwnersBox',
      'Sleeper',
      'ParlayPlay',
      'HotStreak',
      'BoomFantasy',
      'Betr (Alt)',
      'Dabble (Alt)',
      'DraftKings6 (Alt)',
      'Rebet (Alt)',
      'Underdog (Alt)'
    ],
    lineFieldMissingCount: 0,
    consensusEdge: 1.9100731392041437,
    hasConsensus: true,
    edgeSanityFlag: 'ok',
    focusBookMissing: false,
    consensusBookCount: 18,
    consensusStrength: 'strong',
    compDataMissing: false,
    marketBookCount: 18,
    marketBooks: [
      'OnyxOdds',
      'DraftKings',
      'Circa',
      'BetRivers',
      'theScore',
      'Polymarket',
      'Fanatics',
      'Bet105',
      'Fliff',
      'Kalshi',
      'Rebet',
      'BetMGM',
      'Caesars',
      'Pinnacle',
      'FanDuel',
      'BetOnline',
      'Prophet',
      '4cx'
    ],
    supportBookCount: 18,
    supportBooks: [
      'OnyxOdds',
      'DraftKings',
      'Circa',
      'BetRivers',
      'theScore',
      'Polymarket',
      'Fanatics',
      'Bet105',
      'Fliff',
      'Kalshi',
      'Rebet',
      'BetMGM',
      'Caesars',
      'Pinnacle',
      'FanDuel',
      'BetOnline',
      'Prophet',
      '4cx'
    ],
    targetBookOdds: 228,
    bestAvailableOdds: 222,
    executionQuality: 'best',
    steamMove: false,
    steamDirection: 'up',
    steamBookCount: 0,
    steamMoveLegacy: true,
    steamBooksLegacy: ['Pinnacle', 'DraftKings', 'BetOnline'],
    steamDirectionLegacy: 'down',
    steamBookCountLegacy: 3,
    multiWindowScore: 1,
    consensusWindowCount: 6,
    totalConsensusWindows: 6,
    consensusWindows: ['1h', '2h', '6h', '12h', '24h', '48h'],
    multiWindowConfirmedBooks: 2,
    multiWindowRequiredBooks: 2,
    multiWindowInsufficientData: false,
    clvProxyPct: 0.45777484801874935,
    openingOdds: 233,
    freshnessSource: 'response_received',
    freshnessFallbackUsed: true,
    stale: false,
    screenMarket: 'moneyline',
    leaguePreset: 'WNBA',
    marketHintMatch: 'moneyline',
    screenScore: 5.972,
    preferredBookMatch: true,
    gatePassed: true,
    hasLineMovement: true,
    isActionable: true,
    movementDisposition: 'supportive_bouncy',
    movementGrade: 'yellow',
    riskScore: 2,
    kaiCall: 'BET',
    confidenceTier: 'TIER 2',
    confidenceTierLive: 'TIER 2',
    tierTrajectory: {
      trend: 'new',
      volatility: 'unknown',
      dataPoints: 1,
      currentRisk: 2,
      avgRisk: 2,
      riskRange: 0
    },
    rationale:
      'Dallas Wings \u2014 18 books \u2014 1.91% edge \u2014 supportive_bouncy \u2014 best \u2014 0.46% CLV \u2014 \ud83d\udfe1 TIER 2',
    reasonCodes: ['SUPPORTIVE_MOVEMENT', 'CONSENSUS_8_PLUS', 'EDGE_POSITIVE', 'CLV_POSITIVE'],
    movementSourceBook: 'NoVigApp',
    movementMode: 'same_book',
    movementLabel: 'supportive',
    movementPointCount: 94,
    filteredHistoryPointCount: 425,
    droppedHistoryPointCount: 0,
    movementQuality: 'high',
    movementQualityScore: 0.95,
    lineHistoryUsable: true,
    recentClvPct: 0.45777484801874935,
    recentWindowHours: 6,
    recentSharpMoveDirection: 'supportive',
    fullWindowSharpMoveDirection: 'supportive',
    openToCurrentClvPct: 0.45777484801874935,
    peakAdverseClvPct: -2.018825548237313,
    minClvPct: -2.018825548237313,
    selectionKey: 'dallas wings',
    playId: 'WNBA:PREMATCH:Dallas_Wings:Minnesota_Lynx:1786303800::Moneyline::dallas wings'
  }
];

function makeScreen(rowCount) {
  return Array.from({ length: rowCount }, (_, index) => {
    const row = JSON.parse(JSON.stringify(BASE_ROWS[index % BASE_ROWS.length]));
    row.id = `${row.id}#perf-${index}`;
    row.gameId = `${row.gameId}#perf-${index}`;
    row.homeTeam = `${row.homeTeam} ${index}`;
    row.awayTeam = `${row.awayTeam} ${index}`;
    row.participant = index % 2 ? row.homeTeam : row.awayTeam;
    row.selection = row.participant;
    for (const selection of Object.values(row.selections || {})) {
      selection.selection1 = row.homeTeam;
      selection.participant1 = row.homeTeam;
      selection.selection2 = row.awayTeam;
      selection.participant2 = row.awayTeam;
    }
    return row;
  });
}

describe('screen-ranker performance budget', () => {
  it('ranks a 100-row realistic screen in under 1.5 seconds', () => {
    const rows = makeScreen(100);
    const options = { limit: 100, includeAll: true };

    rankScreenRows(rows, options);
    const elapsed = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = performance.now();
      const ranked = rankScreenRows(rows, options);
      elapsed.push(performance.now() - started);
      assert.equal(ranked.length, 100, 'performance fixture must keep all rows through ranking');
    }

    assert.ok(
      Math.min(...elapsed) < 1500,
      `rankScreenRows regressed: ${elapsed.map((ms) => ms.toFixed(1)).join(', ')}ms`
    );
  });
});
