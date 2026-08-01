'use strict';

const cp = require('child_process');
const { LruCache } = require('./propprofessor-lru-cache');

// Fresh promise on each call so tests mocking cp.execFile are honored.
const pExecFile = (...args) =>
  new Promise((resolve, reject) => {
    const execFile = /** @type {*} */ (cp.execFile);
    execFile(...args, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });

const CURL_TIMEOUT_MS = 10000;

// NBA Stats API base — public, no key required, but needs browser-like headers.
const NBA_API_BASE = 'https://stats.nba.com/stats';

// Headers required by stats.nba.com to avoid 403.
const NBA_CURL_HEADERS = [
  '-H',
  'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  '-H',
  'Referer: https://www.nba.com/',
  '-H',
  'Accept: application/json',
  '-H',
  'Origin: https://www.nba.com',
  '-H',
  'Accept-Language: en-US,en;q=0.9'
];

// Cache TTLs — schedule data changes infrequently; 6-hour refresh keeps us
// fresh without hammering the API.
const SCHEDULE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const RESULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours for computed results

const _scheduleCache = new LruCache(64);
const _resultCache = new LruCache(256);

// List of NBA/league IDs supported for basketball game-context.
const NBA_LEAGUE_ID = '00';
const WNBA_LEAGUE_ID = '10';

/**
 * Parse an NBA date string (e.g. "2026-06-21") into a Date object at midnight UTC.
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {Date}
 */
function parseDateUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Compute rest days between two date strings (YYYY-MM-DD).
 * Returns null if either date is missing or invalid.
 * @param {string} gameDate - Date of the current game
 * @param {string} lastPlayed - Date of the team's last game
 * @returns {number|null} Number of days of rest (>= 0), or null
 */
function computeRestDays(gameDate, lastPlayed) {
  if (!gameDate || !lastPlayed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate) || !/^\d{4}-\d{2}-\d{2}$/.test(lastPlayed)) return null;
  const d1 = parseDateUtc(gameDate);
  const d2 = parseDateUtc(lastPlayed);
  const diffMs = d1.getTime() - d2.getTime();
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
  return days >= 0 ? days : null; // null if lastPlayed is after gameDate (data issue)
}

/**
 * Determine if a team is on a back-to-back (≤1 day rest).
 * @param {number|null} restDays
 * @returns {boolean}
 */
function isBackToBack(restDays) {
  return restDays !== null && restDays <= 1;
}

/**
 * Fetch a URL via curl with NBA-specific headers.
 * @param {string} url
 * @returns {Promise<*>} Parsed JSON
 */
async function fetchJsonNba(url) {
  const args = ['-fsS', '--max-time', String(CURL_TIMEOUT_MS / 1000), ...NBA_CURL_HEADERS, url];
  const { stdout } = await pExecFile('curl', args, {
    timeout: CURL_TIMEOUT_MS
  });
  return JSON.parse(stdout);
}

/**
 * Parse the NBA scoreboard response to extract game entries grouped by date,
 * with team info and game IDs.
 *
 * The scoreboardv3 response format:
 * {
 *   scoreboard: {
 *     gameDate: "2026-06-21",
 *     games: [{
 *       gameId: "0022300001",
 *       gameStatus: 1, // 1=scheduled/pre, 2=live, 3=final
 *       gameStatusText: "7:00 pm ET",
 *       homeTeam: { teamTricode: "LAL", teamName: "Lakers", ... },
 *       awayTeam: { teamTricode: "BOS", teamName: "Celtics", ... },
 *       gameDateTimeUTC: "2026-06-22T00:00:00Z"
 *     }]
 *   }
 * }
 *
 * @param {Object} response - Parsed scoreboardv3 JSON
 * @returns {Array<Object>} Flattened game objects
 */
function parseScoreboardGames(response) {
  const games = [];
  if (!response || !response.scoreboard) return games;
  const sb = response.scoreboard;
  for (const game of sb.games || []) {
    games.push({
      gameId: String(game.gameId || ''),
      gameDate: sb.gameDate || '',
      gameDateTimeUtc: game.gameDateTimeUTC || '',
      gameStatus: game.gameStatus || 0,
      gameStatusText: game.gameStatusText || '',
      homeTeam: {
        teamId: game.homeTeam?.teamId || null,
        tricode: game.homeTeam?.teamTricode || '',
        name: game.homeTeam?.teamName || game.homeTeam?.teamNickname || '',
        wins: game.homeTeam?.wins || 0,
        losses: game.homeTeam?.losses || 0
      },
      awayTeam: {
        teamId: game.awayTeam?.teamId || null,
        tricode: game.awayTeam?.teamTricode || '',
        name: game.awayTeam?.teamName || game.awayTeam?.teamNickname || '',
        wins: game.awayTeam?.wins || 0,
        losses: game.awayTeam?.losses || 0
      }
    });
  }
  return games;
}

/**
 * Fetch the NBA scoreboard for a range of dates (today and recent past).
 * The scoreboardv3 endpoint accepts `GameDate` in YYYY-MM-DD format and
 * `LeagueID` (00=NBA, 10=WNBA).
 *
 * @param {string} leagueId - "00" for NBA, "10" for WNBA
 * @param {string} gameDate - YYYY-MM-DD date of the game we care about
 * @returns {Promise<Array<Object>>} Array of parsed game objects across the
 *   relevant date range (gameDate and up to 7 days prior for rest-day calc).
 */
async function fetchSchedule(leagueId, gameDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) {
    throw new Error(`invalid gameDate: ${gameDate}`);
  }

  // We need schedule data from the past ~7 days to compute rest days.
  // Fetch gameDate and up to 7 days before it.
  const gameDt = parseDateUtc(gameDate);
  const results = [];

  for (let offset = -7; offset <= 0; offset++) {
    const dt = new Date(gameDt.getTime() + offset * 24 * 60 * 60 * 1000);
    const dateStr = dt.toISOString().slice(0, 10);
    const cacheKey = `nba:${leagueId}:${dateStr}`;
    const cached = _scheduleCache.get(cacheKey);
    if (cached) {
      results.push(...cached);
      continue;
    }
    try {
      const url = `${NBA_API_BASE}/scoreboardv3?GameDate=${dateStr}&LeagueID=${leagueId}`;
      const response = await fetchJsonNba(url);
      const games = parseScoreboardGames(response);
      _scheduleCache.set(cacheKey, games, SCHEDULE_CACHE_TTL_MS);
      results.push(...games);
    } catch {
      // Silently skip dates that fail — the API may not have data for future
      // dates or very far past dates.
    }
  }

  return results;
}

/**
 * Determine the sport key for a given sport string.
 * @param {string} sport
 * @returns {string} "NBA", "WNBA", or null for unknown
 */
function resolveSport(sport) {
  const s = String(sport || '')
    .toUpperCase()
    .trim();
  if (s === 'NBA') return 'NBA';
  if (s === 'WNBA') return 'WNBA';
  return null;
}

/**
 * Get the league ID for a resolved sport.
 * @param {string} sport - "NBA" or "WNBA"
 * @returns {string}
 */
function leagueIdForSport(sport) {
  if (sport === 'NBA') return NBA_LEAGUE_ID;
  if (sport === 'WNBA') return WNBA_LEAGUE_ID;
  return NBA_LEAGUE_ID; // fallback
}

/**
 * Find the last played game date for a team from a list of scheduled/played games.
 * Looks backwards from the given gameDate.
 *
 * @param {Array<Object>} games - Parsed game objects
 * @param {string} teamName - Team name to search for
 * @param {string} gameDate - Date of the current game (exclude this date)
 * @returns {string|null} The date (YYYY-MM-DD) of the last game played, or null
 */
function findLastPlayedGame(games, teamName, gameDate) {
  const teamLower = String(teamName || '')
    .toLowerCase()
    .trim();
  if (!teamLower) return null;

  // Filter games that involve this team and happened before gameDate
  const eligible = games.filter((g) => {
    if (g.gameDate >= gameDate) return false;
    const awayName = String(g.awayTeam?.name || '')
      .toLowerCase()
      .trim();
    const homeName = String(g.homeTeam?.name || '')
      .toLowerCase()
      .trim();
    return awayName === teamLower || homeName === teamLower;
  });

  if (eligible.length === 0) return null;

  // Sort descending by date (most recent first), pick the latest
  eligible.sort((a, b) => b.gameDate.localeCompare(a.gameDate));
  return eligible[0].gameDate;
}

/**
 * Get basketball game context — rest days, back-to-back detection, risk flags.
 *
 * For NBA/WNBA: fetches recent schedule data from stats.nba.com, computes
 * rest days and back-to-back flags for both teams.
 * For non-NBA/WNBA sports: returns riskFlag 'unknown'.
 *
 * @param {Object} options
 * @param {number|string} [options.gamePk] - Game ID / gamePk
 * @param {string} [options.sport] - Sport name (e.g. "NBA", "WNBA", "NCAAB")
 * @param {string} [options.awayTeam] - Away team name
 * @param {string} [options.homeTeam] - Home team name
 * @param {string} [options.gameDate] - Game date in YYYY-MM-DD format
 * @returns {Promise<{ok: boolean, sport: string|null, gamePk: string|null,
 *   awayTeam: ({name: string|null, restDays: number|null, backToBack: boolean}|null),
 *   homeTeam: ({name: string|null, restDays: number|null, backToBack: boolean}|null),
 *   riskFlag: string, riskSummary: string|null, signals: Object,
 *   cached: boolean, fetchedAt: string, error?: {code: string, message: string}}>}
 */
async function getBasketballGameContext({ gamePk, sport, awayTeam, homeTeam, gameDate } = {}) {
  const pk = String(gamePk || '').trim();
  const resolvedSport = resolveSport(sport);
  const fetchedAt = new Date().toISOString();

  // Result cache key scoped to sport + gamePk
  const resultCacheKey = `basketball:${resolvedSport || 'unknown'}:${pk}:${String(awayTeam || '').toLowerCase()}:${String(homeTeam || '').toLowerCase()}:${gameDate || ''}`;
  const cachedResult = _resultCache.get(resultCacheKey);
  if (cachedResult) {
    return { ...cachedResult, cached: true };
  }

  // Non-NBA/WNBA: return 'unknown' risk with minimal context
  if (!resolvedSport) {
    const result = {
      ok: true,
      sport: sport || null,
      gamePk: pk || null,
      awayTeam: awayTeam ? { name: awayTeam, restDays: null, backToBack: false } : null,
      homeTeam: homeTeam ? { name: homeTeam, restDays: null, backToBack: false } : null,
      riskFlag: 'unknown',
      riskSummary: `Sport "${sport}" is not NBA or WNBA; no rest-day analysis available`,
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

  // Validate required params for NBA/WNBA
  if (!gameDate) {
    return /** @type {any} */ ({
      ok: false,
      sport: resolvedSport,
      gamePk: pk || null,
      error: { code: 'VALIDATION_ERROR', message: 'gameDate is required for NBA/WNBA context' }
    });
  }
  if (!awayTeam || !homeTeam) {
    return /** @type {any} */ ({
      ok: false,
      sport: resolvedSport,
      gamePk: pk || null,
      error: { code: 'VALIDATION_ERROR', message: 'awayTeam and homeTeam are required for NBA/WNBA context' }
    });
  }

  try {
    const leagueId = leagueIdForSport(resolvedSport);
    const games = await fetchSchedule(leagueId, gameDate);

    // Find last played dates
    const lastAway = findLastPlayedGame(games, awayTeam, gameDate);
    const lastHome = findLastPlayedGame(games, homeTeam, gameDate);

    // Compute rest days
    const awayRestDays = computeRestDays(gameDate, lastAway);
    const homeRestDays = computeRestDays(gameDate, lastHome);

    // Detect back-to-backs
    const awayB2b = isBackToBack(awayRestDays);
    const homeB2b = isBackToBack(homeRestDays);

    // Compute rest disparity (difference in rest days between home and away)
    let restDisparity = null;
    if (awayRestDays !== null && homeRestDays !== null) {
      restDisparity = awayRestDays - homeRestDays; // Positive = away has more rest
    }

    // Compose risk flag
    const reasons = [];
    let riskFlag = 'clean';

    if (awayB2b && homeB2b) {
      riskFlag = 'low';
      reasons.push('both teams on back-to-back');
    } else if (awayB2b || homeB2b) {
      const b2bTeam = awayB2b ? awayTeam : homeTeam;
      riskFlag = 'low';
      reasons.push(
        `${b2bTeam} on back-to-back (rest: ${awayB2b ? awayRestDays : homeRestDays} day${(awayB2b ? awayRestDays : homeRestDays) === 1 ? '' : 's'})`
      );
    }

    // Rest disparity >= 2 days is notable
    if (restDisparity !== null && Math.abs(restDisparity) >= 2) {
      const moreRest = restDisparity > 0 ? 'Away' : 'Home';
      reasons.push(`${moreRest} team has ${Math.abs(restDisparity)} more days rest`);
      if (riskFlag === 'clean') riskFlag = 'low';
    }

    const result = {
      ok: true,
      sport: resolvedSport,
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
    return /** @type {any} */ ({
      ok: false,
      sport: resolvedSport,
      gamePk: pk || null,
      error: { code: 'API_ERROR', message: err?.message || String(err) },
      fetchedAt
    });
  }
}

module.exports = {
  getBasketballGameContext,
  // Exports for testing
  parseScoreboardGames,
  computeRestDays,
  isBackToBack,
  findLastPlayedGame,
  resolveSport,
  parseDateUtc
};
