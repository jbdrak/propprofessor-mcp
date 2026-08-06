'use strict';

/**
 * Market registry for each sport/book combination.
 * This is the single source of truth for what markets exist.
 * Agents call get_market_registry to discover available markets
 * before probing quick_screen or find_best_price.
 */
const PROP_MARKETS = {
  NBA: ['Player Points', 'Player Rebounds', 'Player Assists', 'Player PRA'],
  NBASL: ['Player Points', 'Player Rebounds', 'Player Assists', 'Player PRA'],
  WNBA: ['Player Points', 'Player Rebounds', 'Player Assists'],
  NCAAB: ['Player Points', 'Player Rebounds', 'Player Assists'],
  NFL: ['Player Passing Yards', 'Player Rushing Yards', 'Player Receiving Yards', 'Player Receptions'],
  NCAAF: ['Player Passing Yards', 'Player Rushing Yards', 'Player Receiving Yards'],
  MLB: ['Player Strikeouts', 'Player Hits', 'Player Outs', 'Player Hits Allowed', 'Player Earned Runs'],
  NHL: ['Player Goals', 'Player Shots', 'Player Saves', 'Player Assists']
};

const MARKET_REGISTRY = {
  Soccer: {
    NoVigApp: ['Draw No Bet', 'Match Handicap', 'Total Goals'],
    Fliff: ['Draw No Bet', 'Match Handicap', 'Total Goals'],
    DraftKings: ['Draw No Bet', 'Match Handicap', 'Total Goals', 'Both Teams to Score'],
    FanDuel: ['Draw No Bet', 'Match Handicap', 'Total Goals', 'Both Teams to Score'],
    default: ['Draw No Bet', 'Match Handicap', 'Total Goals']
  },
  // MLS shares the soccer odds feed but is a distinct backend league
  // identifier. Markets are exactly the soccer standard three — no
  // alternate-line or prop markets.
  MLS: {
    NoVigApp: ['Draw No Bet', 'Match Handicap', 'Total Goals'],
    Fliff: ['Draw No Bet', 'Match Handicap', 'Total Goals'],
    DraftKings: ['Draw No Bet', 'Match Handicap', 'Total Goals'],
    FanDuel: ['Draw No Bet', 'Match Handicap', 'Total Goals'],
    default: ['Draw No Bet', 'Match Handicap', 'Total Goals']
  },
  Tennis: {
    default: ['Moneyline', 'Total Games', 'Set Handicap']
  },
  MLB: {
    default: ['Moneyline', 'Run Line', 'Total Runs']
  },
  NBA: {
    default: ['Moneyline', 'Point Spread', 'Total Points']
  },
  WNBA: {
    default: ['Moneyline', 'Point Spread', 'Total Points']
  },
  NHL: {
    default: ['Moneyline', 'Puck Line', 'Total Goals']
  },
  NFL: {
    default: ['Moneyline', 'Point Spread', 'Total Points']
  },
  NCAAB: {
    default: ['Moneyline', 'Point Spread', 'Total Points']
  },
  NCAAF: {
    default: ['Moneyline', 'Point Spread', 'Total Points']
  },
  UFC: {
    default: ['Moneyline', 'Total Rounds']
  }
};

/**
 * Get the list of markets for a sport/book combination.
 * @param {string} sport - Sport name (e.g. 'Soccer', 'NBA')
 * @param {string} [book] - Book name (e.g. 'NoVigApp')
 * @returns {string[]} List of market names
 */
function getMarketsForSport(sport, book) {
  const sportKey = String(sport || '').trim();
  if (!sportKey) return ['Moneyline', 'Spread', 'Total'];

  // Case-insensitive lookup: search for the matching registry key
  const matchingKey = Object.keys(MARKET_REGISTRY).find((k) => k.toUpperCase() === sportKey.toUpperCase());
  const sportEntry = matchingKey ? MARKET_REGISTRY[matchingKey] : undefined;
  if (!sportEntry) return ['Moneyline', 'Spread', 'Total']; // fallback

  // Book-specific lookup (case-insensitive on book too)
  if (book) {
    const bookKey = String(book).trim();
    const matchingBookKey = Object.keys(sportEntry).find((k) => k.toUpperCase() === bookKey.toUpperCase());
    if (matchingBookKey && sportEntry[matchingBookKey]) return sportEntry[matchingBookKey];
  }

  return sportEntry.default || ['Moneyline', 'Spread', 'Total'];
}

/**
 * Get the list of player prop markets for a sport.
 * Case-insensitive lookup, mirrors getMarketsForSport. Empty for unknown leagues.
 * @param {string} sport - Sport name (e.g. 'NBA', 'MLB')
 * @returns {string[]} List of player prop market names (empty if unknown)
 */
function getPropMarketsForSport(sport) {
  const sportKey = String(sport || '').trim();
  if (!sportKey) return [];
  const matchingKey = Object.keys(PROP_MARKETS).find((k) => k.toUpperCase() === sportKey.toUpperCase());
  return matchingKey ? [...PROP_MARKETS[matchingKey]] : [];
}

module.exports = { getMarketsForSport, getPropMarketsForSport, MARKET_REGISTRY, PROP_MARKETS };
