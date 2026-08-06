'use strict';

/**
 * Realistic screen API response fixtures for offline testing.
 * Models 3 NBA games across 5 books with deliberate odds differences
 * to exercise consensus, movement, and ranking logic.
 */

const NOW = Date.now();
const FIXTURE_START = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();

function isoAgo(ms) {
  return new Date(NOW - ms).toISOString();
}

// Game 1: Strong consensus — all books agree on the favorite
// Lakers -150 across the board, slight variation
const GAME_LAKERS_CELTICS = {
  gameId: 'nba-20260610-lal-bos',
  league: 'NBA',
  market: 'Moneyline',
  updatedAt: isoAgo(30_000),
  start: FIXTURE_START,
  homeTeam: 'Los Angeles Lakers',
  awayTeam: 'Boston Celtics',
  selections: {
    ml: {
      selection1: 'Los Angeles Lakers',
      participant1: 'Los Angeles Lakers',
      selection1Id: 'Moneyline:Los_Angeles_Lakers',
      selection2: 'Boston Celtics',
      participant2: 'Boston Celtics',
      selection2Id: 'Moneyline:Boston_Celtics',
      odds: {
        NoVigApp: { odds1: -148, odds2: 130, liquidity1: 15420, liquidity2: 3100 },
        Pinnacle: { odds1: -150, odds2: 132, liquidity1: 48200, liquidity2: 9650 },
        Circa: { odds1: -145, odds2: 128, liquidity1: 22100, liquidity2: 7100 },
        BetOnline: { odds1: -152, odds2: 134, liquidity1: 9800, liquidity2: 4200 },
        // BookMaker has MORE dollar depth on side 2 than side 1 — liquidity
        // preservation must follow the side, not pick the max or always side 1.
        BookMaker: { odds1: -150, odds2: 130, liquidity1: 7600, liquidity2: 8900 }
      }
    }
  },
  defaultKey: 'ml'
};

// Game 2: Sharp movement — Fliff is stale at -120 while sharp books moved to -140
const GAME_WARRIORS_NUGGETS = {
  gameId: 'nba-20260610-gsw-den',
  league: 'NBA',
  market: 'Moneyline',
  updatedAt: isoAgo(15_000),
  start: FIXTURE_START,
  homeTeam: 'Golden State Warriors',
  awayTeam: 'Denver Nuggets',
  selections: {
    ml: {
      selection1: 'Golden State Warriors',
      participant1: 'Golden State Warriors',
      selection1Id: 'Moneyline:Golden_State_Warriors',
      selection2: 'Denver Nuggets',
      participant2: 'Denver Nuggets',
      selection2Id: 'Moneyline:Denver_Nuggets',
      odds: {
        // Warriors side 2 (Nuggets) carries more dollar depth than side 1.
        NoVigApp: { odds1: -120, odds2: 105, liquidity1: 8600, liquidity2: 12200 },
        Fliff: { odds1: -120, odds2: 105, liquidity1: 4300, liquidity2: 2100 },
        Pinnacle: { odds1: -140, odds2: 122, liquidity1: 51000, liquidity2: 9800 },
        Circa: { odds1: -138, odds2: 120, liquidity1: 19000, liquidity2: 6400 },
        BetOnline: { odds1: -142, odds2: 124, liquidity1: 11200, liquidity2: 3300 },
        BookMaker: { odds1: -135, odds2: 118, liquidity1: 8700, liquidity2: 2600 }
      }
    }
  },
  defaultKey: 'ml'
};

// Game 3: Split market — no clear consensus
const GAME_BUCKS_HEAT = {
  gameId: 'nba-20260610-mil-mia',
  league: 'NBA',
  market: 'Moneyline',
  updatedAt: isoAgo(45_000),
  start: FIXTURE_START,
  homeTeam: 'Milwaukee Bucks',
  awayTeam: 'Miami Heat',
  selections: {
    ml: {
      selection1: 'Milwaukee Bucks',
      participant1: 'Milwaukee Bucks',
      selection1Id: 'Moneyline:Milwaukee_Bucks',
      selection2: 'Miami Heat',
      participant2: 'Miami Heat',
      selection2Id: 'Moneyline:Miami_Heat',
      odds: {
        NoVigApp: { odds1: -110, odds2: -105, liquidity1: 5400, liquidity2: 4100 },
        Pinnacle: { odds1: -112, odds2: -103, liquidity1: 28900, liquidity2: 17500 },
        Circa: { odds1: -108, odds2: -108, liquidity1: 9800, liquidity2: 11300 },
        BetOnline: { odds1: -115, odds2: 100, liquidity1: 5200, liquidity2: 2900 }
      }
    }
  },
  defaultKey: 'ml'
};

const NBA_MONEYLINE_PAYLOAD = {
  game_data: [GAME_LAKERS_CELTICS, GAME_WARRIORS_NUGGETS, GAME_BUCKS_HEAT]
};

// Spread fixture
const NBA_SPREAD_PAYLOAD = {
  game_data: [
    {
      gameId: 'nba-20260610-lal-bos',
      league: 'NBA',
      market: 'Spread',
      updatedAt: isoAgo(30_000),
      start: FIXTURE_START,
      homeTeam: 'Los Angeles Lakers',
      awayTeam: 'Boston Celtics',
      selections: {
        sp: {
          selection1: 'Los Angeles Lakers',
          participant1: 'Los Angeles Lakers',
          selection1Id: 'Spread:Los_Angeles_Lakers',
          selection2: 'Boston Celtics',
          participant2: 'Boston Celtics',
          selection2Id: 'Spread:Boston_Celtics',
          line1: -3.5,
          line2: 3.5,
          odds: {
            NoVigApp: { odds1: -110, odds2: -110 },
            Pinnacle: { odds1: -108, odds2: -108 },
            Circa: { odds1: -112, odds2: -108 }
          }
        }
      },
      defaultKey: 'sp'
    }
  ]
};

// Total fixture
const NBA_TOTAL_PAYLOAD = {
  game_data: [
    {
      gameId: 'nba-20260610-lal-bos',
      league: 'NBA',
      market: 'Total',
      updatedAt: isoAgo(30_000),
      start: FIXTURE_START,
      homeTeam: 'Los Angeles Lakers',
      awayTeam: 'Boston Celtics',
      selections: {
        tot: {
          selection1: 'Over',
          participant1: 'Over',
          selection1Id: 'Total:Over',
          selection2: 'Under',
          participant2: 'Under',
          selection2Id: 'Total:Under',
          line1: 215.5,
          line2: 215.5,
          odds: {
            NoVigApp: { odds1: -110, odds2: -110 },
            Pinnacle: { odds1: -105, odds2: -115 },
            Circa: { odds1: -108, odds2: -112 }
          }
        }
      },
      defaultKey: 'tot'
    }
  ]
};

// Multi-market payload (for all_slates / multi-market tests)
const NBA_MULTI_MARKET_PAYLOAD = {
  game_data: [...NBA_MONEYLINE_PAYLOAD.game_data, ...NBA_SPREAD_PAYLOAD.game_data, ...NBA_TOTAL_PAYLOAD.game_data]
};

// MLB fixture
const MLB_MONEYLINE_PAYLOAD = {
  game_data: [
    {
      gameId: 'mlb-20260610-nyy-bos',
      league: 'MLB',
      market: 'Moneyline',
      updatedAt: isoAgo(60_000),
      start: FIXTURE_START,
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      selections: {
        ml: {
          selection1: 'New York Yankees',
          participant1: 'New York Yankees',
          selection1Id: 'Moneyline:New_York_Yankees',
          selection2: 'Boston Red Sox',
          participant2: 'Boston Red Sox',
          selection2Id: 'Moneyline:Boston_Red_Sox',
          odds: {
            NoVigApp: { odds1: -165, odds2: 145 },
            Pinnacle: { odds1: -170, odds2: 150 },
            Circa: { odds1: -160, odds2: 142 },
            DraftKings: { odds1: -168, odds2: 148 }
          }
        }
      },
      defaultKey: 'ml'
    }
  ]
};

module.exports = {
  GAME_LAKERS_CELTICS,
  GAME_WARRIORS_NUGGETS,
  GAME_BUCKS_HEAT,
  NBA_MONEYLINE_PAYLOAD,
  NBA_SPREAD_PAYLOAD,
  NBA_TOTAL_PAYLOAD,
  NBA_MULTI_MARKET_PAYLOAD,
  MLB_MONEYLINE_PAYLOAD
};
