'use strict';

const DEFAULT_SHARP_BOOKS = ['Pinnacle', 'Polymarket', 'Kalshi', 'BetOnline', 'Circa'];

// Origin tier of each screen book for movement-signal provenance.
// Sharp ORIGINATORS are the books that move FIRST on informed action; retail
// FOLLOWERS copy them seconds later. A move seen only at a follower may have
// already repriced, so a confirmation from an originator is the stronger
// signal. EXCHANGES (Polymarket/Kalshi) are sharp-informed but use a different
// price-discovery mechanism (order flow, not a line maker). DERIVED books
// (NoVigApp/OnyxOdds) are no-vig consensus lines, not raw movers.
//
// Source: sports-betting market-structure research (Pinnacle, Circa, BookMaker,
// BetOnline, BetCRIS, Heritage are the consistently-cited originators;
// DraftKings/FanDuel/BetMGM are followers). THIS IS A SIGNAL-PROVENANCE LABEL,
// not a profitability claim and not financial advice.
const SHARP_BOOK_ORIGIN_TIERS = {
  Pinnacle: 'originator',
  Circa: 'originator',
  BookMaker: 'originator',
  Bookmaker: 'originator',
  BetOnline: 'originator',
  BetCRIS: 'originator',
  Heritage: 'originator',
  Polymarket: 'exchange',
  Kalshi: 'exchange',
  NoVigApp: 'derived',
  OnyxOdds: 'derived'
};

/**
 * Classify a book by where it sits in the line-movement chain.
 * @param {string} book - Screen book name (any casing/alias)
 * @returns {'originator'|'exchange'|'derived'|'follower'} Origin tier
 */
function classifySharpBookOrigin(book) {
  const name = canonicalizeScreenBookName(book);
  if (SHARP_BOOK_ORIGIN_TIERS[name]) return SHARP_BOOK_ORIGIN_TIERS[name];
  return 'follower';
}

/**
 * True when the book is a sharp originator (moves first on informed action).
 * @param {string} book - Screen book name
 * @returns {boolean}
 */
function isSharpOriginator(book) {
  return classifySharpBookOrigin(book) === 'originator';
}

// Full books list matching the PropProfessor screen frontend.
// The /screen endpoint only returns multi-book data for
// secondary sports (Tennis, Soccer, etc.) when the complete list is passed.
const ALL_SCREEN_BOOKS = [
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
];
const NBA_MAIN_MARKET_SHARP_BOOKS = ['Circa', 'Pinnacle', 'BookMaker', 'BetOnline', 'DraftKings'];
const NBA_PROP_MARKET_SHARP_BOOKS = ['FanDuel', 'BookMaker', 'Prop Builder', 'NoVigApp', 'Pinnacle'];
const NFL_MAIN_MARKET_SHARP_BOOKS = ['Circa', 'Pinnacle', 'BookMaker', 'NoVigApp', 'FanDuel'];
const NFL_PROP_MARKET_SHARP_BOOKS = ['Pinnacle', 'FanDuel', 'BookMaker', 'Circa', 'BetOnline'];
const MLB_MAIN_MARKET_SHARP_BOOKS = ['Pinnacle', 'Circa', 'BookMaker', 'BetOnline', 'DraftKings', 'BetMGM'];
const MLB_PROP_MARKET_SHARP_BOOKS = ['Circa', 'FanDuel', 'Prop Builder', 'Pinnacle', 'DraftKings', 'Bet365'];
const MLB_PROP_CIRCA_CONFIDENT_MARKETS = [
  'player strikeouts',
  'pitcher strikeouts',
  'strikeouts',
  'player home runs',
  'home runs'
];

/**
 * Per-league, per-market comparison book sets for alt markets.
 * These are books known to consistently post Run Line, Puck Line, Total, and Spread odds.
 * Used when the default sharp book set doesn't have enough coverage for the queried market.
 *
 * Source: Live API investigation 2026-06-10. Book availability verified against
 * the PropProfessor /screen endpoint.
 */
const ALT_MARKET_BOOKS = {
  MLB: {
    'Run Line': ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel', 'BookMaker'],
    'Total Runs': ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel'],
    Total: ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel'],
    Spread: ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel']
  },
  NBA: {
    'Point Spread': ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel', 'BookMaker'],
    'Total Points': ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel'],
    Total: ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel']
  },
  NHL: {
    'Puck Line': ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel', 'BookMaker'],
    'Total Goals': ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel'],
    Total: ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel']
  },
  WNBA: {
    'Point Spread': ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel'],
    'Total Points': ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel'],
    Total: ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel']
  },
  SOCCER: {
    'Point Spread': ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel'],
    'Total Goals': ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel'],
    Total: ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel']
  },
  UFC: {
    'Total Rounds': ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel'],
    Total: ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel']
  },
  TENNIS: {
    'Total Games': ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel'],
    Total: ['Pinnacle', 'Circa', 'BetOnline', 'DraftKings', 'BetMGM', 'FanDuel']
  }
};

/**
 * Get the comparison book set for alt markets. Falls back to the main sharp books
 * if no alt-market specific set exists for the league/market combination.
 *
 * @param {Object} options
 * @param {string} options.league - League name
 * @param {string} options.market - Market name (already alias-resolved)
 * @returns {string[]} Book names to query for comparison
 */
function getAltMarketBooks(opts = /** @type {{ league: string, market: string }} */ ({})) {
  const { league, market } = opts;
  const leagueKey = normalizeLeague(league);
  const marketKey = normalizeMarket(market);
  const leagueBooks = ALT_MARKET_BOOKS[leagueKey];
  if (!leagueBooks) return null;
  // Try exact match first, then partial match
  if (leagueBooks[marketKey]) return [...leagueBooks[marketKey]];
  for (const [key, books] of Object.entries(leagueBooks)) {
    if (marketKey.includes(key.toLowerCase()) || key.toLowerCase().includes(marketKey)) {
      return [...books];
    }
  }
  return null;
}

const SCREEN_BOOK_ALIASES = new Map([
  ['rebet', 'Rebet'],
  ['rebet (alt)', 'Rebet (Alt)'],
  ['re-bet', 'Rebet'],
  ['re-bet (alt)', 'Rebet (Alt)'],
  ['propbuilder', 'Prop Builder'],
  ['prop builder', 'Prop Builder'],
  ['sportzino', 'SportZino'],
  ['sport zino', 'SportZino']
]);

/**
 * Canonicalize a book name to its standard screen book name.
 * Checks aliases first, then exact case-insensitive match against ALL_SCREEN_BOOKS.
 * @param {string} book - Raw book name to canonicalize.
 * @returns {string} The canonical screen book name, or the trimmed original if no match.
 */
function canonicalizeScreenBookName(book) {
  const raw = String(book || '').trim();
  if (!raw) return '';
  const aliased = SCREEN_BOOK_ALIASES.get(raw.toLowerCase());
  if (aliased) return aliased;
  const exactMatch = ALL_SCREEN_BOOKS.find((candidate) => candidate.toLowerCase() === raw.toLowerCase());
  return exactMatch || raw;
}

/**
 * Deduplicate and canonicalize a list of book names.
 * @param {string[]} books - Array of book names to process.
 * @returns {string[]} Array of unique, canonicalized book names.
 */
function uniqueBooks(books) {
  return Array.from(
    new Set((Array.isArray(books) ? books : []).map((book) => canonicalizeScreenBookName(book)).filter(Boolean))
  );
}

function normalizeLeague(league) {
  return String(league || '')
    .trim()
    .toUpperCase();
}

/**
 * Normalize a market string: trim, lowercase, and collapse whitespace.
 * @param {string} market - Raw market string to normalize.
 * @returns {string} Normalized market string.
 */
function normalizeMarket(market) {
  return String(market || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Check whether a market is a primary main-market type (moneyline, spread, total, etc.).
 * Falls back to true for empty/falsy markets.
 * @param {string} market - Market string to check.
 * @returns {boolean} True if the market is a primary main-market or falsy.
 */
function isPrimaryMainMarket(market) {
  const normalizedMarket = normalizeMarket(market);
  if (!normalizedMarket) return true;
  return ['moneyline', 'spread', 'point spread', 'run line', 'total', 'team total', 'total runs'].some((token) =>
    normalizedMarket.includes(token)
  );
}

/**
 * Check if the league is NBA.
 * @param {string} league - League string (case-insensitive).
 * @returns {boolean} True if normalized league equals 'NBA'.
 */
function isNbaLeague(league) {
  return normalizeLeague(league) === 'NBA';
}

/**
 * Check if the league is NFL.
 * @param {string} league - League string (case-insensitive).
 * @returns {boolean} True if normalized league equals 'NFL'.
 */
function isNflLeague(league) {
  return normalizeLeague(league) === 'NFL';
}

/**
 * Check if the league is MLB.
 * @param {string} league - League string (case-insensitive).
 * @returns {boolean} True if normalized league equals 'MLB'.
 */
function isMlbLeague(league) {
  return normalizeLeague(league) === 'MLB';
}

/**
 * Check whether a market is an MLB main market (moneyline, run line, total, etc.).
 * Falls back to true for empty/falsy markets.
 * @param {string} market - Market string to check.
 * @returns {boolean} True if the market is an MLB main-market or falsy.
 */
function isMlbMainMarket(market) {
  const normalizedMarket = normalizeMarket(market);
  if (!normalizedMarket) return true;
  return [
    'moneyline',
    'run line',
    'spread',
    'point spread',
    'total',
    'team total',
    'total runs',
    'moneyline - 1st inning',
    'run line - 1st inning',
    'total runs - 1st inning',
    'team total runs - 1st inning',
    'first inning'
  ].some((token) => normalizedMarket.includes(token));
}

/**
 * Check whether a market is an MLB prop market (anything that is not a main market).
 * @param {string} market - Market string to check.
 * @returns {boolean} True if the market is an MLB prop market.
 */
function isMlbPropMarket(market) {
  const normalizedMarket = normalizeMarket(market);
  if (!normalizedMarket) return false;
  return !isMlbMainMarket(normalizedMarket);
}

/**
 * Resolve the sharp-book comparison set for a given league and market.
 * Returns requested books if provided, otherwise returns the predefined
 * sharp-book set for the league/market combination.
 * @param {Object} options - Options object.
 * @param {string} [options.league] - League name (e.g. 'NBA', 'NFL', 'MLB').
 * @param {string} [options.market] - Market string for further refinement.
 * @param {string[]} [options.requestedBooks] - Explicit book list; if non-empty, returned as-is.
 * @returns {string[]} Array of sharp book names.
 */
function getSharpBookComparisonSet({ league, market, requestedBooks } = {}) {
  const requested = uniqueBooks(requestedBooks);
  if (requested.length) return requested;

  // For non-primary markets (Run Line, Puck Line, Total Goals, etc.),
  // use the alt-market book set which includes FanDuel and other books
  // that consistently post those markets
  if (!isPrimaryMainMarket(market)) {
    const altBooks = getAltMarketBooks({ league, market });
    if (altBooks) return altBooks;
  }

  if (isNbaLeague(league)) {
    return isPrimaryMainMarket(market) ? [...NBA_MAIN_MARKET_SHARP_BOOKS] : [...NBA_PROP_MARKET_SHARP_BOOKS];
  }
  if (isNflLeague(league)) {
    return isPrimaryMainMarket(market) ? [...NFL_MAIN_MARKET_SHARP_BOOKS] : [...NFL_PROP_MARKET_SHARP_BOOKS];
  }
  if (isMlbLeague(league)) {
    return isMlbPropMarket(market) ? [...MLB_PROP_MARKET_SHARP_BOOKS] : [...MLB_MAIN_MARKET_SHARP_BOOKS];
  }
  return [...DEFAULT_SHARP_BOOKS];
}

/**
 * Get a detailed sharp-book context object for a given league and market.
 * Includes key, label, source, book list, notes, and league-specific metadata.
 * @param {Object} options - Options object.
 * @param {string} [options.league] - League name (e.g. 'NBA', 'NFL', 'MLB').
 * @param {string} [options.market] - Market string for context refinement.
 * @returns {{key: string, label: string, source: string, books: string[], notes: string[], circaFocusedMarkets?: string[]}} Context object with league/market-specific sharp-book metadata.
 */
function getSharpBookContext({ league, market } = {}) {
  const books = getSharpBookComparisonSet({ league, market });
  if (isNbaLeague(league)) {
    if (isPrimaryMainMarket(market)) {
      return {
        key: 'nba_main',
        label: 'NBA main markets',
        source: 'Pikkit sharp-book analysis, Dec 2024',
        books,
        notes: [
          'Circa leads NBA main markets, followed by Pinnacle, BookMaker, BetOnline, and DraftKings.',
          'Use this set for NBA moneylines, spreads, and totals.'
        ]
      };
    }
    return {
      key: 'nba_props',
      label: 'NBA secondary markets and player props',
      source: 'Pikkit sharp-book analysis, Dec 2024',
      books,
      notes: [
        'FanDuel leads NBA props, followed by BookMaker, PropBuilder, NoVigApp, and Pinnacle.',
        'Use the prop-specific ordering instead of the main-market hierarchy for NBA player markets.'
      ]
    };
  }

  if (isNflLeague(league)) {
    if (isPrimaryMainMarket(market)) {
      return {
        key: 'nfl_main',
        label: 'NFL main markets',
        source: 'Pikkit sharp-book analysis, Dec 2024',
        books,
        notes: [
          'Circa leads NFL main markets, followed by Pinnacle, BookMaker, NoVigApp, and FanDuel.',
          'Use this set for NFL moneylines, spreads, and totals.'
        ]
      };
    }
    return {
      key: 'nfl_props',
      label: 'NFL secondary markets and player props',
      source: 'Pikkit sharp-book analysis, Dec 2024',
      books,
      notes: [
        'Pinnacle leads NFL props, followed by FanDuel, BookMaker, Circa, and BetOnline.',
        'Use the prop-specific ordering instead of the main-market hierarchy for NFL player markets.'
      ]
    };
  }

  if (!isMlbLeague(league)) {
    return {
      key: 'default',
      label: 'Default sharp comparison set',
      source: 'Existing PropProfessor MCP baseline',
      books,
      notes: ['Uses the cross-sport default sharp set built around Pinnacle, Polymarket, Kalshi, BetOnline, and Circa.']
    };
  }

  if (isMlbPropMarket(market)) {
    return {
      key: 'mlb_props',
      label: 'MLB secondary markets and player props',
      source: 'PromoGuy sharp-book study via Pikkit/Bettor Odds, Aug 2025',
      books,
      notes: [
        'Use Circa and FanDuel as the top sharp references for MLB props, with Prop Builder, Pinnacle, DraftKings, and Bet365 next in line.',
        'Circa props should be trusted most on the limited MLB prop menu they actively hang, especially strikeouts and home runs.'
      ],
      circaFocusedMarkets: [...MLB_PROP_CIRCA_CONFIDENT_MARKETS]
    };
  }

  return {
    key: 'mlb_main',
    label: 'MLB main markets',
    source: 'PromoGuy sharp-book study via Pikkit/Bettor Odds, Aug 2025',
    books,
    notes: [
      'Use Pinnacle as the primary anchor for MLB moneylines, spreads, and totals.',
      'Circa, BookMaker, BetOnline, DraftKings, and BetMGM round out the preferred MLB main-market comp set.'
    ]
  };
}

module.exports = {
  ALT_MARKET_BOOKS,
  DEFAULT_SHARP_BOOKS,
  ALL_SCREEN_BOOKS,
  NBA_MAIN_MARKET_SHARP_BOOKS,
  NBA_PROP_MARKET_SHARP_BOOKS,
  NFL_MAIN_MARKET_SHARP_BOOKS,
  NFL_PROP_MARKET_SHARP_BOOKS,
  MLB_MAIN_MARKET_SHARP_BOOKS,
  MLB_PROP_MARKET_SHARP_BOOKS,
  MLB_PROP_CIRCA_CONFIDENT_MARKETS,
  getAltMarketBooks,
  getSharpBookComparisonSet,
  getSharpBookContext,
  isNbaLeague,
  isNflLeague,
  isMlbLeague,
  isPrimaryMainMarket,
  isMlbMainMarket,
  isMlbPropMarket,
  normalizeMarket,
  uniqueBooks,
  canonicalizeScreenBookName,
  classifySharpBookOrigin,
  isSharpOriginator,
  SHARP_BOOK_ORIGIN_TIERS
};
