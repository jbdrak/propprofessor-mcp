'use strict';

const LEAGUE_KEYWORDS = [
  ['Tennis', ['tennis', 'atp', 'wta']],
  ['NBA', ['nba', 'basketball', 'hoops']],
  ['NBASL', ['nbasl', 'summer league', 'nba summer']],
  ['MLB', ['mlb', 'baseball']],
  // NCAAF must precede NFL: "college football" contains the word "football",
  // so the more specific league has to win the keyword match.
  ['NCAAF', ['ncaaf', 'college football', 'cfc']],
  ['NFL', ['nfl', 'football']],
  ['NHL', ['nhl', 'hockey']],
  ['NCAAB', ['ncaab', 'college basketball', 'cbb']],
  ['WNBA', ['wnba']],
  // MLS must precede Soccer: "major league soccer" contains the word
  // "soccer", so the more specific league has to win the keyword match.
  ['MLS', ['mls', 'major league soccer']],
  ['Soccer', ['soccer', 'football match', 'premier league', 'uefa', 'liga']],
  ['UFC', ['ufc', 'mma', 'fight']],
  ['PGA', ['pga', 'golf', 'tour championship']],
  ['EuroLeague', ['euroleague']]
];

const BOOK_KEYWORDS = [
  'NoVigApp',
  'OnyxOdds',
  'Polymarket',
  'Kalshi',
  'BetOnline',
  'Circa',
  'Fliff',
  'Rebet',
  'Underdog',
  'PrizePicks',
  'Dabble',
  'DraftKings6',
  'DraftKings',
  'FanDuel',
  'Caesars',
  'BetMGM',
  'Sleeper',
  'Betr'
];

const MARKET_KEYWORDS = [
  // Exact combo/team-total phrases must win before their component keywords.
  ['Player Passing + Rushing Yards', ['player passing + rushing yards', 'passing + rushing yards']],
  ['Player Passing + Receiving Yards', ['player passing + receiving yards', 'passing + receiving yards']],
  ['Player Rushing + Receiving Yards', ['player rushing + receiving yards', 'rushing + receiving yards']],
  ['Player Hits + Runs + RBIs', ['player hits + runs + rbis', 'hits + runs + rbis', 'hits + runs + rbi', 'h+r+rbi', 'hr+rbi']],
  ['Player Points + Rebounds + Assists', ['player points + rebounds + assists', 'points rebounds assists', 'points + rebounds + assists', 'pra']],
  ['Player Points + Rebounds', ['player points + rebounds', 'points + rebounds', 'pts + reb']],
  ['Player Points + Assists', ['player points + assists', 'points + assists', 'pts + ast']],
  ['Player Rebounds + Assists', ['player rebounds + assists', 'rebounds + assists']],
  ['Player Blocks + Steals', ['player blocks + steals', 'blocks + steals']],
  ['Team Total Touchdowns', ['team total touchdowns']],
  ['Team Total Points', ['team total points']],
  ['Team Total Runs', ['team total runs']],

  // Specific player/pitcher phrases must win before generic stat words.
  ['Pitcher Earned Runs Allowed', ['pitcher earned runs allowed', 'earned runs allowed']],
  ['Pitcher Walks Allowed', ['pitcher walks allowed', 'walks allowed']],
  ['Pitcher Outs Recorded', ['pitcher outs recorded', 'outs recorded']],
  ['Pitcher Hits Allowed', ['pitcher hits allowed', 'hits allowed']],
  ['Player Strikeouts', ['player strikeouts', 'batter strikeouts']],
  ['Player Triples', ['player triples']],
  ['Player Doubles', ['player doubles']],
  ['Player Singles', ['player singles']],
  ['Player Hits', ['player hits']],
  ['Player Runs', ['player runs']],
  ['Player Walks', ['player walks']],
  ['Player Total Bases', ['player total bases', 'total bases']],
  ['Player Home Runs', ['player home runs', 'home runs']],
  ['Player RBIs', ['player rbis', 'rbis']],
  ['Player Steals', ['player steals']],
  ['Player Blocks', ['player blocks']],
  ['Player Turnovers', ['player turnovers']],
  ['Player Threes Made', ['player threes made', 'threes made']],
  ['Player Double Double', ['player double double', 'double double']],
  ['Player Triple Double', ['player triple double', 'triple double']],
  ['Player Passing Attempts', ['player passing attempts', 'passing attempts']],
  ['Player Passing Completions', ['player passing completions', 'passing completions']],
  ['Player Longest Completion', ['player longest completion', 'longest completion']],
  ['Player Interceptions', ['player interceptions', 'interceptions']],
  ['Player Passing Touchdowns', ['player passing touchdowns', 'passing touchdowns']],
  ['Player Rushing Attempts', ['player rushing attempts', 'rushing attempts']],
  ['Player Longest Rush', ['player longest rush', 'longest rush']],
  ['Player Receptions', ['player receptions', 'receptions']],
  ['Player Receiving Targets', ['player receiving targets', 'receiving targets']],
  ['Player Receiving Touchdowns', ['player receiving touchdowns', 'receiving touchdowns']],
  ['Player Longest Reception', ['player longest reception', 'longest reception']],
  ['Player Tackles + Assists', ['player tackles + assists', 'tackles + assists']],
  ['Player Tackles For Loss', ['player tackles for loss', 'tackles for loss']],
  ['Player Tackles Assisted', ['player tackles assisted', 'tackles assisted']],
  ['Player Tackles', ['player tackles', 'tackles']],
  ['Player Sacks', ['player sacks', 'sacks']],
  ['Player Field Goals Made', ['player field goals made', 'field goals made']],
  ['Player Extra Points', ['player extra points', 'extra points']],
  ['Player Kicking Points', ['player kicking points', 'kicking points']],
  ['Player Punts', ['player punts', 'punts']],
  ['Player Touchdowns', ['player touchdowns', 'touchdowns']],
  ['Player Passing Yards', ['player passing yards', 'passing yards', 'pass yds', 'passing yds']],
  ['Player Rushing Yards', ['player rushing yards', 'rushing yards', 'rush yds', 'rushing yds']],
  ['Player Receiving Yards', ['player receiving yards', 'receiving yards', 'rec yds', 'receiving yds']],
  ['Player Rebounds', ['player rebounds', 'rebounds']],
  ['Player Assists', ['player assists', 'assists']],
  ['Player Points', ['player points', 'points', 'pts', 'point prop']],
  ['Pitcher Strikeouts', ['pitcher strikeouts']],
  ['Pitcher Strikeouts', ['strikeouts', 'ks', 'k prop']],
  ['Moneyline', ['moneyline', 'ml', 'money line']],
  ['Spread', ['spread', 'handicap', 'run line']],
  ['Total', ['total', 'over/under', 'ou']]
];

/**
 * Normalize a text value by trimming, lowercasing, and collapsing whitespace.
 * @param {string} value - The text value to normalize.
 * @returns {string} The normalized text.
 */
function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check whether a keyword appears as a whole word within the given text.
 * @param {string} text - The text to search within.
 * @param {string} keyword - The keyword to look for.
 * @returns {boolean} True if the keyword is found as a distinct word in the text.
 */
function matchesKeyword(text, keyword) {
  const normalizedText = normalizeText(text);
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedText || !normalizedKeyword) return false;
  const pattern = normalizedKeyword.split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${pattern}(?:$|[^a-z0-9])`, 'i').test(normalizedText);
}

/**
 * Infer the preferred sportsbook from a query string.
 * @param {string} text - The query text to scan for a sportsbook name.
 * @returns {string|null} The matched sportsbook name, or null if none found.
 */
function inferPreferredBook(text) {
  const normalized = normalizeText(text);
  return BOOK_KEYWORDS.find((book) => matchesKeyword(normalized, book)) || null;
}

/**
 * Infer the default league from a query string.
 * @param {string} text - The query text to scan for a league name.
 * @returns {string|null} The matched league name (e.g. "NBA", "MLB"), or null if none found.
 */
function inferDefaultLeague(text) {
  const normalized = normalizeText(text);
  for (const [league, keywords] of LEAGUE_KEYWORDS) {
    // @ts-expect-error
    if (keywords.some((keyword) => matchesKeyword(normalized, keyword))) {
      // @ts-expect-error
      return league;
    }
  }
  return null;
}

/**
 * Infer the default market type from a query string.
 * @param {string} text - The query text to scan for a market type.
 * @param {string|null} [league] - Optional league name used for fallback market inference (e.g. Tennis defaults to "Moneyline").
 * @returns {string|null} The matched market name (e.g. "Moneyline", "Spread"), or null if none found.
 */
function inferDefaultMarket(text, league = null) {
  const normalized = normalizeText(text);
  for (const [market, keywords] of MARKET_KEYWORDS) {
    // @ts-expect-error
    if (keywords.some((keyword) => matchesKeyword(normalized, keyword))) {
      // @ts-expect-error
      return market;
    }
  }
  if (league === 'Tennis' || normalized.includes('tennis')) {
    if (matchesKeyword(normalized, 'spread') || matchesKeyword(normalized, 'handicap')) return 'Spread';
    if (matchesKeyword(normalized, 'total') || matchesKeyword(normalized, 'over/under') || normalized.includes('ou'))
      return 'Total';
    return 'Moneyline';
  }
  return null;
}

function parseSideAndLine(text) {
  const normalized = normalizeText(text)
    .replace(/\b(a\s+)?good\s+bet\??$/i, '')
    .trim();
  const match = normalized.match(/\b(over|under|o|u|\+|-)\s*(\d+(?:\.\d+)?)\b/i);
  if (!match) return { side: null, line: null };
  const sideToken = match[1].toLowerCase();
  return {
    side:
      sideToken === 'o' || sideToken === '+' ? 'over' : sideToken === 'u' || sideToken === '-' ? 'under' : sideToken,
    line: Number(match[2])
  };
}

// Validation-query prefixes that wrap a player prop ("should I bet Tatum over 29.5").
// Stripping them before player extraction keeps the player name clean.
const VALIDATION_PREFIX_REGEX = /\b(?:should i bet|is .*?safe|validate|check)\b/i;

function parsePlayer(text) {
  const normalized = String(text || '').trim();

  // Strip validation triggers before extracting the player name.
  let candidate = normalized;
  if (VALIDATION_PREFIX_REGEX.test(candidate)) {
    candidate = candidate.replace(VALIDATION_PREFIX_REGEX, '').trim();
  }

  const propMatch = candidate.match(/^(?:is\s+)?(.+?)\s+(?:o|u|over|under|\+|-)\s*\d+(?:\.\d+)?\b/i);
  if (!propMatch) return null;

  const playerName = propMatch[1].trim();
  const bookPrefixes = [
    'Fliff',
    'Rebet',
    'Underdog',
    'PrizePicks',
    'NoVigApp',
    'Polymarket',
    'Kalshi',
    'BetOnline',
    'Circa',
    'FanDuel',
    'DraftKings',
    'Caesars',
    'BetMGM',
    'Sleeper',
    'Betr',
    'Dabble',
    'DraftKings6'
  ];

  let cleanName = playerName;
  for (const prefix of bookPrefixes) {
    cleanName = cleanName.replace(new RegExp(`^${escapeRegExp(prefix)}\\s+`, 'i'), '').trim();
  }

  const tokens = cleanName.split(/\s+/).filter(Boolean);
  const stopTokens = new Set([
    'points',
    'pts',
    'rebounds',
    'assists',
    'blocks',
    'steals',
    'strikeouts',
    'hits',
    'total',
    'moneyline',
    'spread',
    'handicap',
    'fantasy',
    'good',
    'bet',
    'best',
    'find',
    'edges',
    'today'
  ]);
  while (tokens.length > 1 && stopTokens.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }

  return tokens.join(' ').trim() || cleanName;
}

/**
 * Parse a natural language prop bet query into its structured components.
 * @param {string} text - A natural language query string describing a prop bet.
 * @returns {{raw: string, intent: string, league: (string|null), book: (string|null), market: (string|null), side: (string|null), line: (number|null), player: (string|null), query: (string|null)}} An object containing the parsed query components.
 */
function parseNaturalLanguagePropQuery(text) {
  const raw = String(text || '').trim();
  const league = inferDefaultLeague(raw);
  let book = inferPreferredBook(raw);
  const market = inferDefaultMarket(raw, league);
  const intent = 'screen';
  const { side, line } = parseSideAndLine(raw);
  const player = parsePlayer(raw);

  // Book name extraction from query text (substring matching for broader detection)
  const bookKeywords = [
    'novig',
    'novigapp',
    'no vig',
    'pinnacle',
    'fanduel',
    'draftkings',
    'betmgm',
    'caesars',
    'pointsbet',
    'bet365',
    'betonline',
    'betrivers',
    'barstool',
    'foxbet',
    'wynnbet',
    'hardrock',
    'bookmaker',
    'prophet exchange',
    'prophet',
    'fliff',
    'rebet',
    'chamba',
    'vivid picks',
    'thescore',
    'prizepicks',
    'underdog',
    'onyxodds',
    'onyx odds'
  ];
  const queryLower = raw.toLowerCase();
  const foundBook = bookKeywords.find((bk) => queryLower.includes(bk));
  let suggestedArgs = {};
  if (foundBook && !book) {
    const bookMap = {
      novig: 'NoVigApp',
      novigapp: 'NoVigApp',
      'no vig': 'NoVigApp',
      pinnacle: 'Pinnacle',
      fanduel: 'FanDuel',
      draftkings: 'DraftKings',
      betmgm: 'BetMGM',
      betonline: 'BetOnline',
      circa: 'Circa',
      bookmaker: 'BookMaker',
      fliff: 'Fliff',
      rebet: 'Rebet',
      prophet: 'Prophet Exchange',
      thescore: 'theScore',
      underdog: 'Underdog',
      onyxodds: 'OnyxOdds',
      'onyx odds': 'OnyxOdds'
    };
    const canonicalBook = Object.keys(bookMap).find((k) => foundBook.startsWith(k));
    book = canonicalBook ? bookMap[canonicalBook] : foundBook;
  }
  if (book) {
    suggestedArgs = { books: [book] };
  }

  const suggestedToolName = 'quick_screen';

  return {
    raw,
    intent,
    league,
    book,
    market,
    side,
    line,
    player,
    query: raw || null,
    // @ts-expect-error
    suggestedTool: {
      tool: suggestedToolName,
      args: { ...suggestedArgs }
    }
  };
}

module.exports = {
  inferDefaultLeague,
  inferDefaultMarket,
  inferPreferredBook,
  matchesKeyword,
  normalizeText,
  parseNaturalLanguagePropQuery
};
