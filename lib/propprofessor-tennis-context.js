'use strict';

const cp = require('child_process');
const { getWeekForDate, pickTourneyForMatchup } = require('./tennis-schedule-data/weekly-schedule-2026');
const _correctTennisTimes = require('./propprofessor-tennis');

// Same pattern as propprofessor-news-sources.js: recreate promise each call
// so tests that mock cp.execFile by reassignment are honored.
const pExecFile = (...args) =>
  new Promise((resolve, reject) => {
    const execFile = /** @type {*} */ (cp.execFile);
    execFile(...args, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });

const CURL_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Surface detection: ordered from most specific to most general so that
// tournaments that contain multiple keywords match the correct surface.
// ---------------------------------------------------------------------------

/** @type {Array<{pattern: RegExp, surface: string}>} */
const SURFACE_PATTERNS = [
  // Clay
  { pattern: /\b(?:Roland\s*Garros|French\s*Open)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Monte\s*Carlo|Rolex\s*Monte\s*Carlo)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Internazionali\s*Bnl\s*D|Italian\s*Open|Rome)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Mutua\s*Madrid|Madrid\s*Open)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Hamburg|German\s*Open)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Swiss\s*Open|Gstaad)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Swedish\s*Open|Bastad)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Croatia\s*Open|Umag)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Austrian\s*Open|Kitzbuhel|Generali)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Argentina\s*Open|Buenos\s*Aires)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Rio\s*Open|Rio\s*de\s*Janeiro)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Chile\s*Open|Santiago|Movistar)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Cordoba|Córdoba)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Sao\s*Paulo|Brasil)\s*Open\b/i, surface: 'Clay' },
  { pattern: /\b(?:Marrakech|Grand\s*Prix\s*Hassan\s*Ii)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Estoril|Portugal\s*Open)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Bucharest|Romanian|Tiriac)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Munich|BMW\s*Open|Bavarian)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Geneva|Gonet)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Lyon|Open\s*Parc)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Bordeaux)\b/i, surface: 'Clay' },
  { pattern: /\b(?:Aix-en-Provence)\b/i, surface: 'Clay' },
  { pattern: /\bClay\b/i, surface: 'Clay' },

  // Grass
  { pattern: /\b(?:Wimbledon)\b/i, surface: 'Grass' },
  { pattern: /\b(?:Queen[''']s|Queen\s*Club|cinch\s*Championships?)\b/i, surface: 'Grass' },
  { pattern: /\b(?:Eastbourne|Rothesay\s*International)\b/i, surface: 'Grass' },
  { pattern: /\b(?:Halle|Gerry\s*Weber|Terra\s*Wortmann)\b/i, surface: 'Grass' },
  { pattern: /\b(?:Stuttgart\s*(?:Open|Weissenhof))\b/i, surface: 'Grass' },
  { pattern: /\b(?:Newport|Hall\s*of\s*Fame)\b/i, surface: 'Grass' },
  { pattern: /\b(?:Mallorca|Majorca)\b/i, surface: 'Grass' },
  { pattern: /\b(?:s[''']?Hertogenbosch|Rosmalen|Libema)\b/i, surface: 'Grass' },
  { pattern: /\b(?:Nottingham|Nature\s*Valley)\b/i, surface: 'Grass' },
  { pattern: /\b(?:Ilkley)\b/i, surface: 'Grass' },
  { pattern: /\bGrass\b/i, surface: 'Grass' },

  // Carpet (rare, legacy)
  { pattern: /\bCarpet\b/i, surface: 'Carpet' },

  // Indoor hard — must match before generic "hard"
  { pattern: /\b(?:Paris\s*(?:Masters?|Bercy|Rolex))\b/i, surface: 'Indoor' },
  { pattern: /\b(?:Basel|Swiss\s*Indoors|Davidoff)\b/i, surface: 'Indoor' },
  { pattern: /\b(?:Vienna|Erste\s*Bank|Stadthalle)\b/i, surface: 'Indoor' },
  { pattern: /\b(?:Rotterdam|ABN\s*Amro)\b/i, surface: 'Indoor' },
  { pattern: /\b(?:Marseille|Open\s*13|Provence)\b/i, surface: 'Indoor' },
  { pattern: /\b(?:Metz|Moselle)\b/i, surface: 'Indoor' },
  { pattern: /\b(?:Stockholm)\b/i, surface: 'Indoor' },
  { pattern: /\b(?:Sofia|Sofia\s*Open)\b/i, surface: 'Indoor' },
  { pattern: /\b(?:St\.?\s*Petersburg|St\s*Petersburg)\b/i, surface: 'Indoor' },
  { pattern: /\b(?:Moscow|Kremlin\s*Cup)\b/i, surface: 'Indoor' },
  { pattern: /\b(?:Montpellier|Open\s*Sud)\b/i, surface: 'Indoor' },
  { pattern: /\bIndoor\b/i, surface: 'Indoor' },

  // Hardcourt — catch-all remaining hard-court events
  { pattern: /\b(?:Australian\s*Open|AO)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:US\s*Open|Flushing)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Indian\s*Wells|BNP\s*Paribas|Tennis\s*Garden)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Miami\s*Open|Miami\s*Masters?)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Cincinnati|Western\s*&?\s*Southern)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Canada(?:ian)?\s*Open|Rogers\s*Cup|National\s*Bank|Toronto|Montreal)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Shanghai|Rolex\s*Shanghai)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Beijing|China\s*Open)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Tokyo|Japan\s*Open|Rakuten)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Washington|Citi\s*Open|Legg\s*Mason)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Acapulco|Mexican\s*Open|Abierto)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Dubai|Dubai\s*Tennis)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Doha|Qatar\s*Open|ExxonMobil)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Adelaide|Adelaide\s*International)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Brisbane|Brisbane\s*International)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Sydney\s*International|Sydney\s*Tennis)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Auckland|ASB\s*Classic)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Delray\s*Beach)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Los\s*Cabos)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Winston-Salem)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Chengdu)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Zhuhai)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Astana|Almaty|Nur-Sultan)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Florence|Firenze)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Gijon|Gijón)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Tel\s*Aviv|Tel\s*Aviv\s*Watergen)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Seoul|Korea\s*Open)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Hangzhou)\b/i, surface: 'Hardcourt' },
  { pattern: /\b(?:Hard(?:court)?)\b/i, surface: 'Hardcourt' }
];

// ---------------------------------------------------------------------------
// Match-level detection
// ---------------------------------------------------------------------------

/** @type {Array<{pattern: RegExp, level: string}>} */
const LEVEL_PATTERNS = [
  // Grand Slams
  { pattern: /\b(?:Australian\s*Open|French\s*Open|Roland\s*Garros|Wimbledon|US\s*Open)\b/i, level: 'Grand Slam' },

  // ATP Finals
  { pattern: /\b(?:ATP\s*(?:World\s*)?Tour\s*Finals?|Nitto\s*ATP\s*Finals?|Tour\s*Finals?)\b/i, level: 'ATP Finals' },

  // Masters 1000
  {
    pattern:
      /\b(?:Indian\s*Wells|Miami\s*(?:Open)?|Monte\s*Carlo|Madrid\s*(?:Open)?|Rome|Italian\s*Open|Canada(?:ian)?\s*Open|Rogers\s*Cup|Cincinnati|Shanghai|Paris\s*(?:Masters?|Bercy|Rolex))\b/i,
    level: 'Masters'
  },

  // ATP 500
  {
    pattern:
      /\b(?:Rotterdam|Rio\s*(?:Open|de\s*Janeiro)|Acapulco|Mexican\s*Open|Dubai|Barcelona|Halle|Queen['']s|Hamburg|Washington|Beijing|Tokyo|Basel|Vienna)\b/i,
    level: 'ATP 500'
  },

  // ATP 250 literal
  { pattern: /\bATP\s*250\b/i, level: 'ATP 250' },

  // Challenger
  { pattern: /\bChallenger\b/i, level: 'Challenger' },

  // ITF Futures / World Tennis Tour / M-level events
  { pattern: /\b(?:M15|M25|ITF|Futures|World\s*Tennis\s*Tour)\b/i, level: 'ITF Futures' },

  // Fallback: mentions Open/International/Cup/Trophy -> ATP 250
  { pattern: /\b(?:Open|International|Cup|Trophy)\b/i, level: 'ATP 250' }
];

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Guess the playing surface from a tournament name.
 * @param {string} tournament - Tournament name to classify.
 * @returns {string|null} Surface name (Clay, Grass, Hardcourt, Indoor, Carpet) or null if unknown.
 */
function guessSurfaceFromTournament(tournament) {
  if (!tournament || typeof tournament !== 'string') return null;
  for (const { pattern, surface } of SURFACE_PATTERNS) {
    if (pattern.test(tournament)) return surface;
  }
  return null;
}

/**
 * Guess the match / tournament level.
 * @param {string} tournament - Tournament name to classify.
 * @returns {string|null} Level string (Grand Slam, ATP Finals, Masters, ATP 500, ATP 250,
 *   Challenger, ITF Futures) or null if unknown.
 */
function guessMatchLevel(tournament) {
  if (!tournament || typeof tournament !== 'string') return null;
  for (const { pattern, level } of LEVEL_PATTERNS) {
    if (pattern.test(tournament)) return level;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Matchup-to-tournament resolution
// ---------------------------------------------------------------------------
//
// The validate_play / quick_screen pipelines call this module with a
// `tournament` field that is actually a matchup string like
// "Dart vs Sonmez" — the tourney name is never present. The
// `guessSurfaceFromTournament` pattern matchers then fail to find a
// tour-level keyword and return `surface: unknown`.
//
// Fix: when `tournament` looks like a matchup (contains " vs " or fails
// every pattern), use the `start` timestamp + the player's known circuit
// to resolve to an actual tournament from the 2026 weekly schedule.
// Returns null when no match is found — caller falls through to the
// existing "unknown" path.

const MATCHUP_SEPARATOR = /\s+(?:vs|@|at)\s+/i;

/**
 * Heuristic: does this string look like a matchup rather than a
 * tournament name? A matchup contains " vs "/" vs "/" @ " or " at "
 * separating two capitalised names. Real tournament names occasionally
 * contain "vs" (rare) so we also confirm there's a player name on each
 * side by checking the existing pattern matchers.
 * @param {string} s
 * @returns {boolean}
 */
function looksLikeMatchup(s) {
  if (!s || typeof s !== 'string') return false;
  if (!MATCHUP_SEPARATOR.test(s)) return false;
  // If the pattern matchers already identify it as a real tournament, trust them.
  if (guessSurfaceFromTournament(s)) return false;
  if (guessMatchLevel(s)) return false;
  return true;
}

/**
 * Split a matchup string into { player1, player2 }.
 * @param {string} matchup
 * @returns {{player1: string, player2: string}}
 */
function parseMatchup(matchup) {
  if (!matchup || typeof matchup !== 'string') return { player1: '', player2: '' };
  const parts = matchup.split(MATCHUP_SEPARATOR);
  if (parts.length >= 2) {
    return { player1: (parts[0] || '').trim(), player2: (parts[1] || '').trim() };
  }
  return { player1: matchup.trim(), player2: '' };
}

/**
 * Resolve a matchup to a real tournament. Returns null when the schedule
 * data has no entry for that week or no player-circuit hint matches.
 *
 * @param {string} matchup - e.g. "Dart vs Sonmez"
 * @param {string|Date} startIso - Game start (ISO string or Date)
 * @returns {{name: string, surface: string, level: string, city: string, tour: string, slug: string, weekStart: string}|null}
 */
function resolveTournamentFromMatchup(matchup, startIso) {
  if (!matchup || !startIso) return null;
  const { player1, player2 } = parseMatchup(matchup);
  if (!player1 && !player2) return null;
  const tourney = pickTourneyForMatchup(player1, player2, startIso);
  if (!tourney) return null;
  const week = getWeekForDate(startIso);
  return { ...tourney, weekStart: week ? week.start : null };
}

// ---------------------------------------------------------------------------
// News-fetching helper
// ---------------------------------------------------------------------------

/**
 * Build a Google News RSS search URL for a tennis matchup query.
 * @param {string} player1
 * @param {string} player2
 * @returns {string}
 */
function buildMatchupNewsUrl(player1, player2) {
  const q = `tennis ${encodeURIComponent(player1)} vs ${encodeURIComponent(player2)}`;
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

/**
 * Parse a Google News RSS XML blob into a flat array of { title, link, pubDate, source }.
 * Returns an empty array on any parse failure (graceful degradation).
 * @param {string} xml
 * @returns {Array<{title: string, link: string, pubDate: string, source: string}>}
 */
function parseRss(xml) {
  if (typeof xml !== 'string' || xml.length === 0) return [];
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    let source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    items.push({
      title: stripCdata(rawTitle).trim(),
      link: link.trim(),
      pubDate: pubDate.trim(),
      source: stripCdata(source).trim()
    });
  }
  return items;
}

/**
 * Strip CDATA wrapper from a string.
 * @param {*} s
 * @returns {string}
 */
function stripCdata(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/**
 * Fetch Google News RSS results for player1 vs player2.
 * @param {string} player1
 * @param {string} player2
 * @returns {Promise<Array<{title: string, link: string, pubDate: string, source: string}>>}
 */
async function fetchMatchupNews(player1, player2) {
  try {
    const url = buildMatchupNewsUrl(player1, player2);
    const { stdout } = await pExecFile('curl', ['-sL', '--max-time', String(CURL_TIMEOUT_MS / 1000), url], {
      timeout: CURL_TIMEOUT_MS
    });
    return parseRss(stdout);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fallback: search for tournament info when player→tourney matching fails.
 * Uses ESPN scoreboard data (already cached by correctTennisTimes) to
 * find the tournament venue for a player matchup, then runs surface/level
 * pattern matching on the venue name. This is the most reliable fallback
 * since ESPN data is already fetched by the time context runs.
 *
 * @param {string} player1
 * @param {string} player2
 * @param {string} _dateStr - ISO date string (unused but kept for API consistency)
 * @returns {Promise<{surface: string|null, level: string|null}>}
 */
async function searchTournamentFallback(player1, player2, _dateStr) {
  if (!player1 || !player2) return { surface: null, level: null };

  try {
    const { fetchEspnMatches, findEspnMatch } = require('./propprofessor-tennis');
    const espnMatches = await fetchEspnMatches();
    if (!espnMatches || !espnMatches.length) return { surface: null, level: null };

    const match = findEspnMatch(espnMatches, player1, player2);
    if (!match || !match.venue) return { surface: null, level: null };

    const surface = guessSurfaceFromTournament(match.venue);
    const level = guessMatchLevel(match.venue);
    return { surface, level };
  } catch {
    return { surface: null, level: null };
  }
}

/**
 * Get tennis context for a match: surface, level, and optional matchup news count.
 *
 * @param {Object} opts
 * @param {string} [opts.player1] - Name of the first player.
 * @param {string} [opts.player2] - Name of the second player.
 * @param {string} [opts.tournament] - Tournament name (used for surface/level detection).
 *   When this looks like a matchup string ("Dart vs Sonmez") and `start` is
 *   provided, the matchup is resolved to a real tournament via the 2026
 *   weekly schedule + player circuit hints. The resolved tournament name
 *   is exposed as `tournament` in the result.
 * @param {string} [opts.surface] - Explicit surface override (skips tournament guessing).
 * @param {string} [opts.start] - Game start ISO timestamp (used for matchup resolution).
 * @returns {Promise<{
 *   ok: boolean,
 *   sport: string,
 *   surface: string|null,
 *   level: string|null,
 *   matchupNewsCount: number,
 *   riskFlag: string,
 *   riskSummary: string|null,
 *   signals: { surface: string|null, level: string|null, matchupArticles: boolean, resolvedFromMatchup: boolean },
 *   tournament: string|null,
 *   city: string|null,
 *   tour: string|null,
 *   cached: boolean,
 *   fetchedAt: string
 * }>}
 */
async function getTennisContext(opts = {}) {
  const { player1, player2, tournament: rawTournament, surface: explicitSurface, start } = opts;

  // Tennis start-time correction REMOVED. Rule: live odds on the book
  // mean the match hasn't started. Scheduled start times from feeds are
  // unreliable and correction adds API latency with no betting value added.
  let correctedStart = start;

  // If `tournament` looks like a matchup ("Dart vs Sonmez") and we have a
  // start time, try to resolve it to a real tournament first. If that
  // succeeds, treat the resolved name as the tournament for pattern
  // matching. If it fails, fall through to the original "unknown" path.
  //
  // When resolution succeeds, use the schedule's authoritative `surface`
  // and `level` fields instead of the pattern matchers — the pattern
  // matchers' "Open/International/Cup/Trophy → ATP 250" fallback would
  // misclassify "Lexus Eastbourne Open" as ATP 250 when it is actually
  // WTA 250. The schedule data is the source of truth.
  let tournament = rawTournament;
  let resolvedFromMatchup = false;
  let resolvedCity = null;
  let resolvedTour = null;
  let resolvedSurface = null;
  let resolvedLevel = null;
  if (correctedStart && looksLikeMatchup(rawTournament)) {
    const resolved = resolveTournamentFromMatchup(rawTournament, correctedStart);
    if (resolved) {
      tournament = resolved.name;
      resolvedFromMatchup = true;
      resolvedCity = resolved.city;
      resolvedTour = resolved.tour;
      resolvedSurface = resolved.surface;
      resolvedLevel = resolved.level;
    } else {
      // Fallback: try web search for tournament info when player→tourney
      // matching fails (players not in the static circuit map). This is a
      // lightweight DuckDuckGo query that extracts surface and level from
      // snippet text. Best-effort — returns null on failure.
      const fb = await searchTournamentFallback(player1, player2, correctedStart);
      if (fb.surface || fb.level) {
        resolvedSurface = fb.surface;
        resolvedLevel = fb.level;
      }
    }
  }

  // Guess surface & level from tournament (or use explicit surface). When
  // we resolved from a matchup, prefer the schedule's data over the
  // pattern matchers (see note above).
  let surface = explicitSurface || resolvedSurface || (tournament ? guessSurfaceFromTournament(tournament) : null);
  const level = resolvedLevel || (tournament ? guessMatchLevel(tournament) : null);

  // Determine risk state
  let riskFlag = 'clean';
  let riskSummary = null;

  if (!surface) {
    surface = 'unknown';
    riskFlag = 'unknown';
    riskSummary = 'Could not determine playing surface from tournament name';
  }

  if (!level) {
    riskSummary = riskSummary ? `${riskSummary}; could not determine match level` : 'Could not determine match level';
    if (riskFlag === 'clean') riskFlag = 'unknown';
  }

  // Optionally fetch matchup news
  let matchupNewsCount = 0;
  let matchupArticles = false;

  if (player1 && player2) {
    const articles = await fetchMatchupNews(player1, player2);
    matchupNewsCount = articles.length;
    matchupArticles = matchupNewsCount > 0;
  }

  return {
    ok: true,
    sport: 'Tennis',
    surface,
    level,
    matchupNewsCount,
    riskFlag,
    riskSummary,
    signals: {
      surface,
      level,
      matchupArticles,
      resolvedFromMatchup
    },
    tournament: resolvedFromMatchup ? tournament : null,
    city: resolvedCity,
    tour: resolvedTour,
    cached: false,
    fetchedAt: new Date().toISOString()
  };
}

module.exports = {
  getTennisContext,
  guessSurfaceFromTournament,
  guessMatchLevel,
  buildMatchupNewsUrl,
  parseRss,
  stripCdata,
  looksLikeMatchup,
  parseMatchup,
  resolveTournamentFromMatchup,
  SURFACE_PATTERNS,
  LEVEL_PATTERNS
};
