'use strict';

const { LruCache } = require('./propprofessor-lru-cache');
const { fetchJson, parseDateUtc, computeRestDays, isBackToBack } = require('./propprofessor-shared-utils');

// NHL API base — public `api-web.nhle.com` endpoint, no key required.
const NHL_API_BASE = 'https://api-web.nhle.com/v1/schedule';

const NHL_CURL_HEADERS = [
  '-H',
  'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  '-H',
  'Accept: application/json',
  '-H',
  'Accept-Language: en-US,en;q=0.9'
];

const SCHEDULE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const RESULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const _scheduleCache = new LruCache(64);
const _resultCache = new LruCache(256);

/**
 * Normalize a team name for comparison: lowercase, strip accents, trim.
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Fetch a URL via curl with NHL-specific headers.
 * @param {string} url
 * @returns {Promise<*>} Parsed JSON
 */
async function fetchJsonNhl(url) {
  return fetchJson(url, NHL_CURL_HEADERS);
}

/**
 * Parse the NHL schedule response into a flat array of game objects.
 *
 * Response shape from api-web.nhle.com:
 * {
 *   nextStartDate: "2026-06-28",
 *   previousStartDate: "2026-06-14",
 *   gameWeek: [{
 *     date: "2026-06-21",
 *     games: [{
 *       id: 2024021234,
 *       gameType: 2,
 *       gameState: "FUT"|"OFF"|"LIVE",
 *       awayTeam: {
 *         abbrev: "BOS",
 *         placeName: { default: "Boston" },
 *         commonName: { default: "Bruins" }
 *       },
 *       homeTeam: {
 *         abbrev: "MTL",
 *         placeName: { default: "Montréal" },
 *         commonName: { default: "Canadiens" }
 *       }
 *     }]
 *   }]
 * }
 *
 * @param {Object} response
 * @returns {Array<Object>}
 */
function parseScheduleGames(response) {
  const games = [];
  if (!response || !Array.isArray(response.gameWeek)) return games;
  for (const day of response.gameWeek) {
    const date = day.date || '';
    for (const game of day.games || []) {
      const awayPlace = game.awayTeam?.placeName?.default || '';
      const awayCommon = game.awayTeam?.commonName?.default || '';
      const homePlace = game.homeTeam?.placeName?.default || '';
      const homeCommon = game.homeTeam?.commonName?.default || '';
      games.push({
        gameId: String(game.id || ''),
        gameDate: date,
        gameType: game.gameType || 0,
        gameState: game.gameState || '',
        awayTeam: {
          abbrev: game.awayTeam?.abbrev || '',
          displayName: [awayPlace, awayCommon].filter(Boolean).join(' '),
          placeName: awayPlace,
          commonName: awayCommon
        },
        homeTeam: {
          abbrev: game.homeTeam?.abbrev || '',
          displayName: [homePlace, homeCommon].filter(Boolean).join(' '),
          placeName: homePlace,
          commonName: homeCommon
        }
      });
    }
  }
  return games;
}

/**
 * Fetch NHL schedule for the game date and up to 5 days prior.
 * The NHL API returns a full week of data per call, so date-range coverage
 * is handled by fetching individual dates back from the target.
 *
 * @param {string} gameDate - YYYY-MM-DD
 * @returns {Promise<Array<Object>>}
 */
async function fetchSchedule(gameDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) {
    throw new Error(`invalid gameDate: ${gameDate}`);
  }

  const gameDt = parseDateUtc(gameDate);
  const results = [];

  for (let offset = -5; offset <= 0; offset++) {
    const dt = new Date(gameDt.getTime() + offset * 24 * 60 * 60 * 1000);
    const dateStr = dt.toISOString().slice(0, 10);
    const cacheKey = `nhl:${dateStr}`;
    const cached = _scheduleCache.get(cacheKey);
    if (cached) {
      results.push(...cached);
      continue;
    }
    try {
      const url = `${NHL_API_BASE}/${dateStr}`;
      const response = await fetchJsonNhl(url);
      const games = parseScheduleGames(response);
      _scheduleCache.set(cacheKey, games, SCHEDULE_CACHE_TTL_MS);
      results.push(...games);
    } catch {
      // Silently skip dates that fail
    }
  }

  return results;
}

/**
 * Find the last played game date for a team from a list of games.
 * Matches against displayName (e.g. "Boston Bruins"), commonName (e.g. "Bruins"),
 * placeName (e.g. "Boston"), and abbrev (e.g. "BOS").
 *
 * @param {Array<Object>} games
 * @param {string} teamName - Team name from the caller
 * @param {string} gameDate - Current game date (exclude this date)
 * @returns {string|null}
 */
function findLastPlayedGame(games, teamName, gameDate) {
  const target = normalizeName(teamName);
  if (!target) return null;

  const eligible = games.filter((g) => {
    if (g.gameDate >= gameDate) return false;
    const awayNormal = normalizeName(g.awayTeam.displayName);
    const homeNormal = normalizeName(g.homeTeam.displayName);
    const awayCommon = normalizeName(g.awayTeam.commonName);
    const homeCommon = normalizeName(g.homeTeam.commonName);
    const awayPlace = normalizeName(g.awayTeam.placeName);
    const homePlace = normalizeName(g.homeTeam.placeName);
    const awayAbbrev = g.awayTeam.abbrev.toLowerCase();
    const homeAbbrev = g.homeTeam.abbrev.toLowerCase();

    return (
      awayNormal === target ||
      homeNormal === target ||
      awayCommon === target ||
      homeCommon === target ||
      awayPlace === target ||
      homePlace === target ||
      awayAbbrev === target ||
      homeAbbrev === target
    );
  });

  if (eligible.length === 0) return null;
  eligible.sort((a, b) => b.gameDate.localeCompare(a.gameDate));
  return eligible[0].gameDate;
}

/**
 * NHL game-context provider.
 *
 * Fetches recent NHL schedule data from api-web.nhle.com, computes rest days
 * and back-to-back flags for both teams, and returns a risk assessment.
 *
 * @param {Object} options
 * @param {number|string} [options.gamePk] - Game ID
 * @param {string} [options.awayTeam] - Away team name (e.g. "Boston Bruins" or "BOS")
 * @param {string} [options.homeTeam] - Home team name
 * @param {string} [options.gameDate] - Game date in YYYY-MM-DD format
 * @returns {Promise<Object>}
 */
async function getNhlContext({ gamePk, awayTeam, homeTeam, gameDate } = {}) {
  const pk = String(gamePk || '').trim();
  const fetchedAt = new Date().toISOString();

  const resultCacheKey = `nhl:${pk}:${normalizeName(awayTeam)}:${normalizeName(homeTeam)}:${gameDate || ''}`;
  const cachedResult = _resultCache.get(resultCacheKey);
  if (cachedResult) {
    return { ...cachedResult, cached: true };
  }

  // Handle empty/missing params — return unknown risk
  if (!gameDate || !awayTeam || !homeTeam) {
    const result = {
      ok: true,
      sport: 'NHL',
      gamePk: pk || null,
      awayTeam: awayTeam ? { name: awayTeam, restDays: null, backToBack: false } : null,
      homeTeam: homeTeam ? { name: homeTeam, restDays: null, backToBack: false } : null,
      riskFlag: 'unknown',
      riskSummary: 'Insufficient parameters provided; cannot compute rest days',
      signals: {
        awayBackToBack: false,
        homeBackToBack: false,
        restDisparity: null
      },
      cached: false,
      fetchedAt
    };
    _resultCache.set(resultCacheKey, result, RESULT_CACHE_TTL_MS);
    return result;
  }

  try {
    const games = await fetchSchedule(gameDate);

    const lastAway = findLastPlayedGame(games, awayTeam, gameDate);
    const lastHome = findLastPlayedGame(games, homeTeam, gameDate);

    const awayRestDays = computeRestDays(gameDate, lastAway);
    const homeRestDays = computeRestDays(gameDate, lastHome);

    const awayB2b = isBackToBack(awayRestDays);
    const homeB2b = isBackToBack(homeRestDays);

    let restDisparity = null;
    if (awayRestDays !== null && homeRestDays !== null) {
      restDisparity = awayRestDays - homeRestDays;
    }

    const reasons = [];
    let riskFlag = 'clean';

    if (awayB2b && homeB2b) {
      riskFlag = 'low';
      reasons.push('both teams on back-to-back');
    } else if (awayB2b || homeB2b) {
      const b2bName = awayB2b ? awayTeam : homeTeam;
      const b2bRest = awayB2b ? awayRestDays : homeRestDays;
      riskFlag = 'low';
      reasons.push(`${b2bName} on back-to-back (rest: ${b2bRest} day${b2bRest === 1 ? '' : 's'})`);
    }

    if (restDisparity !== null && Math.abs(restDisparity) >= 2) {
      const moreRest = restDisparity > 0 ? 'Away' : 'Home';
      reasons.push(`${moreRest} team has ${Math.abs(restDisparity)} more days rest`);
      if (riskFlag === 'clean') riskFlag = 'low';
    }

    const result = {
      ok: true,
      sport: 'NHL',
      gamePk: pk || null,
      awayTeam: {
        name: awayTeam,
        restDays: awayRestDays,
        backToBack: awayB2b
      },
      homeTeam: {
        name: homeTeam,
        restDays: homeRestDays,
        backToBack: homeB2b
      },
      riskFlag,
      riskSummary: reasons.length > 0 ? reasons.join('; ') : null,
      signals: {
        awayBackToBack: awayB2b,
        homeBackToBack: homeB2b,
        restDisparity
      },
      cached: false,
      fetchedAt
    };

    _resultCache.set(resultCacheKey, result, RESULT_CACHE_TTL_MS);
    return result;
  } catch (err) {
    return {
      ok: false,
      sport: 'NHL',
      gamePk: pk || null,
      error: { code: 'API_ERROR', message: err?.message || String(err) },
      fetchedAt
    };
  }
}

module.exports = {
  getNhlContext,
  // Exports for testing
  parseScheduleGames,
  computeRestDays,
  isBackToBack,
  findLastPlayedGame,
  parseDateUtc,
  normalizeName
};
