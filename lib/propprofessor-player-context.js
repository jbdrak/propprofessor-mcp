'use strict';

const cp = require('child_process');
const { fetchGoogleNews, fetchEspnSearch, searchNitterRSS } = require('./propprofessor-news-sources');
const { scoreTweet, scoreNewsArticle, assessRiskFlag } = require('./propprofessor-source-authority');
const { LruCache } = require('./propprofessor-lru-cache');

// Note: same as propprofessor-news-sources.js, we cannot capture
// promisify(execFile) at module load time because tests mock cp.execFile by
// reassignment. Use a fresh promise on each call so the mock is honored.
const pExecFile = (...args) =>
  new Promise((resolve, reject) => {
    const execFile = /** @type {*} */ (cp.execFile);
    execFile(...args, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });

// Allowlist for player-name characters before passing to a subprocess.
// Rationale (June 8 SEC-001 audit): cp.execFile is NOT shell exec, so the
// shell-injection risk is low — but the principle of sanitizing user-controlled
// strings before they reach an external process still applies. xurl's argv
// parser could misinterpret leading "--" as a flag, and exotic Unicode
// (emoji, RTL marks) adds nothing for a player-name search. Reject anything
// outside the allowlist and let the caller surface a validation error.
//
// Note: hyphens are allowed (for "Karl-Anthony Towns" style names) BUT a
// leading "--" is rejected separately below — it would be interpreted as a
// flag by xurl's argv parser. A single internal hyphen is fine.
const PLAYER_NAME_PATTERN = /^[\p{L}\p{N}\s.'’\-,]+$/u;

function sanitizePlayerName(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  // Cap length — defensive against absurd inputs that might break the CLI.
  if (trimmed.length > 100) return '';
  if (!PLAYER_NAME_PATTERN.test(trimmed)) return '';
  // Reject leading "--" (would be parsed as an xurl flag, not a player name).
  // Single leading "-" is also rejected to be safe — no real player name
  // starts with a hyphen. Internal hyphens like "Karl-Anthony" are fine.
  if (trimmed.startsWith('-')) return '';
  return trimmed;
}

/**
 * Try the xurl CLI as a paid-API escalation path. Used when useXurl=true on
 * query_player_context. xurl needs manual `xurl auth oauth2` setup; until then
 * it returns 401. We detect 401 (and other obvious auth errors) and report
 * source: 'xurl-failed' with a hint to set up auth.
 *
 * xurl's response shape on success is the standard X v2 search response with
 * data[].text, data[].author_id, data[].created_at, includes.users[].username.
 * We normalize to the same shape our extractTweets returns so downstream
 * scoring works without a second branch.
 *
 * @param {Object} options
 * @param {string} options.player - Full name of the player to search for.
 * @param {string} [options.sport] - Sport name (e.g. "NBA", "MLB", "Tennis").
 * @param {number} [options.maxResults=20] - Maximum number of search results to return.
 * @returns {Promise<Object>} An object with either `source: 'xurl'` and a `raw` payload,
 *   or `source: 'xurl-failed'` with an `error` string and empty `tweets`/`news` arrays.
 */
async function fetchViaXurl({ player, sport, maxResults = 20 }) {
  // Sanitize the player name before passing to xurl (June 8 SEC-001).
  // Empty result after sanitization means the input was rejected by the
  // allowlist — surface this as a clean xurl-failed response rather than
  // passing garbage to the CLI.
  const cleanPlayer = sanitizePlayerName(player);
  if (!cleanPlayer) {
    return {
      source: 'xurl-failed',
      error: `player name rejected by sanitizer (raw input length=${String(player || '').length})`,
      tweets: [],
      news: [],
      query: String(player || '')
    };
  }
  const cleanSport = sport ? sanitizePlayerName(sport) : '';
  const query = cleanSport && cleanSport !== 'Tennis' ? `${cleanPlayer} ${cleanSport}` : cleanPlayer;
  // xurl exits non-zero on 401/403/etc but still writes the JSON error body
  // to stdout. We need to capture stdout even on non-zero exit, which the
  // default cp.execFile error path doesn't do — it throws an Error with only
  // { code, killed, signal, cmd } on it. So we wrap cp.execFile directly.
  let stdout = '';
  let execErr = null;
  await new Promise((resolve) => {
    cp.execFile('xurl', ['search', query, '-n', String(maxResults)], { timeout: 15_000 }, (err, out) => {
      stdout = out || '';
      execErr = err || null;
      resolve();
    });
  });

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    if (execErr) {
      return {
        source: 'xurl-failed',
        error: `xurl exec failed: ${/** @type {Error} */ (execErr).message || String(execErr)}`,
        tweets: [],
        news: [],
        query
      };
    }
    return { source: 'xurl-failed', error: 'xurl returned non-JSON output', tweets: [], news: [], query };
  }

  // 401/403/etc from xurl (no auth, rate-limit, etc.) — surface a clean error
  if (parsed && typeof parsed === 'object' && parsed.status && parsed.status >= 400) {
    return {
      source: 'xurl-failed',
      error: `xurl HTTP ${parsed.status}: ${parsed.detail || parsed.title || 'auth likely missing'}. Run \`xurl auth oauth2\` to set up.`,
      tweets: [],
      news: [],
      query
    };
  }

  return { source: 'xurl', raw: parsed, query };
}

/**
 * Normalize xurl's v2 API response into the same { text, author, authorName, createdAt, ... }
 * shape that extractTweets produces. Returns [] on any shape mismatch (graceful).
 *
 * @param {Object} xurlResponse - The raw JSON response from the xurl CLI (X v2 API shape).
 * @param {Object} [xurlResponse.data] - Array of tweet data objects.
 * @param {Object} [xurlResponse.includes] - Includes object with users array.
 * @param {Array} [xurlResponse.includes.users] - Array of user objects keyed by id.
 * @returns {Array<Object>} Array of normalized tweet objects with fields:
 *   text, author, authorName, createdAt, favoriteCount, retweetCount, isRetweet, isVerified.
 */
function extractXurlTweets(xurlResponse) {
  if (!xurlResponse || typeof xurlResponse !== 'object') return [];
  const data = xurlResponse.data;
  if (!Array.isArray(data)) return [];

  // Build a username lookup from includes.users
  const userMap = new Map();
  if (Array.isArray(xurlResponse.includes?.users)) {
    for (const u of xurlResponse.includes.users) {
      userMap.set(u.id, { username: u.username || '', name: u.name || '' });
    }
  }

  return data.map((t) => {
    const user = userMap.get(t.author_id) || {};
    return {
      text: t.text || '',
      author: user.username || '',
      authorName: user.name || '',
      createdAt: t.created_at || '',
      favoriteCount: t.public_metrics?.like_count || 0,
      retweetCount: t.public_metrics?.retweet_count || 0,
      isRetweet: typeof t.text === 'string' && t.text.startsWith('RT '),
      isVerified: false // xurl v2 search doesn't include verified in default fields
    };
  });
}

const X_API_PATH = process.env.HOME + '/.hermes/skills/social-media/nitter-session-api/scripts/x-api.py';
const DEFAULT_COUNT = 30;
const NITTER_RSS_COUNT = 30;
const EXEC_TIMEOUT_MS = 15000;
const NEWS_TOP_N = 5;
const ESPN_FALLBACK_TOP_N = 10;

// Smart cache: 30-minute default TTL, 5-minute TTL when riskFlag is 'high' so
// the next call re-checks for a fast-changing injury. 200 entries is enough
// for ~all active players across a slate (NBA ~12, MLB ~15, Tennis ~20, plus
// football/soccer/other). Cron jobs hammering this won't bloat.
const _ctxCache = new LruCache(200);
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const HIGH_RISK_TTL_MS = 5 * 60 * 1000;

/**
 * Build a cache key for player context lookups. Normalizes player name and sport
 * to lowercase so variants like "Frances Tiafoe" and "frances tiafoe" hit the same entry.
 *
 * @param {string} player - Player full name.
 * @param {string} [sport] - Sport name (e.g. "NBA", "MLB").
 * @param {string} [gameTime] - ISO timestamp of the game start time.
 * @param {number} [maxAgeMinutes=60] - Maximum age of results to consider.
 * @returns {string} A pipe-delimited cache key string.
 */
function cacheKey(player, sport, gameTime, maxAgeMinutes) {
  // Lowercase the player name so "Frances Tiafoe" and "frances tiafoe" hit the same entry.
  // Sport is also lowercased to normalize case variants.
  return `${String(player || '').toLowerCase()}|${String(sport || '').toLowerCase()}|${gameTime || ''}|${maxAgeMinutes || 60}`;
}

/**
 * Drop every cached entry for a given player+sport (used by the cron pipeline
 * when a high-authority tweet surfaces — bust the cache so the next call
 * re-fetches and re-scores).
 *
 * @param {string} player - Player full name.
 * @param {string} [sport] - Sport name (e.g. "NBA", "MLB").
 * @returns {boolean} True if any cache entries were deleted, false otherwise.
 */
function invalidatePlayer(player, sport) {
  // @ts-expect-error
  return /** @type {boolean} */ (_ctxCache.deleteMatching(cacheKey(player, sport, '', 60)));
}

/**
 * Search X (Twitter) via the nitter-session-api Python script for recent tweets matching a query.
 *
 * @param {string} query - Search query string (e.g. player name, optionally with sport).
 * @param {number} [_count=DEFAULT_COUNT] - Maximum number of tweets to request (unused by the API,
 *   but passed to the Python script for reference).
 * @returns {Promise<{error: string|null, tweets: Array<Object>}>} Object with an error string
 *   (or null on success) and an array of tweet objects parsed by extractTweets.
 */
async function searchX(query, _count = DEFAULT_COUNT) {
  try {
    const { stdout } = await pExecFile('python3', [X_API_PATH, 'search', query], { timeout: EXEC_TIMEOUT_MS });
    const parsed = JSON.parse(stdout);
    if (parsed.error) {
      return { error: typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error), tweets: [] };
    }
    return { error: null, tweets: extractTweets(parsed) };
  } catch (err) {
    return { error: err.message || String(err), tweets: [] };
  }
}

/**
 * Extract tweet objects from a raw X GraphQL search response. Walks the nested
 * timeline instruction structure to pull out tweet text, author metadata, and engagement counts.
 *
 * @param {Object} searchResponse - Raw JSON response from the X GraphQL search_by_raw_query endpoint.
 * @param {Object} [searchResponse.data] - Top-level data container.
 * @param {Object} [searchResponse.data.search_by_raw_query] - Search results container.
 * @returns {Array<Object>} Array of normalized tweet objects with fields:
 *   text, author, authorName, createdAt, favoriteCount, retweetCount, isRetweet, isVerified.
 */
function extractTweets(searchResponse) {
  const tweets = [];
  if (!searchResponse || typeof searchResponse !== 'object') return tweets;
  const instructions = searchResponse?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
  for (const instr of instructions) {
    if (instr.type !== 'TimelineAddEntries') continue;
    for (const entry of instr.entries || []) {
      const result = entry?.content?.itemContent?.tweet_results?.result;
      if (!result) continue;
      const legacy = result.legacy || {};
      const userLegacy = result.core?.user_results?.result?.legacy || {};
      const userCore = result.core?.user_results?.result?.core || {};
      tweets.push({
        text: legacy.full_text || '',
        author: userLegacy.screen_name || userCore.screen_name || '',
        authorName: userLegacy.name || userCore.name || '',
        createdAt: legacy.created_at || '',
        favoriteCount: legacy.favorite_count || 0,
        retweetCount: legacy.retweet_count || 0,
        isRetweet: !!legacy.retweeted_status_result,
        isVerified: !!userLegacy.verified || !!userCore.verified || false
      });
    }
  }
  return tweets;
}

/**
 * Build a search query string from player name and optional sport.
 * Appends the sport name unless the sport is "Tennis" (where player name alone is preferred).
 *
 * @param {Object} params
 * @param {string} params.player - Player full name.
 * @param {string} [params.sport] - Sport name (e.g. "NBA", "MLB", "Tennis").
 * @returns {string} The constructed search query string, or empty string if no player provided.
 */
function buildQuery({ player, sport }) {
  if (!player) return '';
  return sport && sport !== 'Tennis' ? `${player} ${sport}` : player;
}

/**
 * Get full player context: recent tweets, news, and a computed risk flag.
 * This is the main entry point for player research. Supports an optional xurl
 * escalation path (useXurl=true) that bypasses the cache for real-time data.
 * Results are cached with a 30-minute TTL (5-minute TTL when riskFlag is 'high').
 *
 * @param {Object} options
 * @param {string} options.player - Player full name to search for.
 * @param {string} [options.sport] - Sport name (e.g. "NBA", "MLB", "Tennis"). Used to build query and score authority.
 * @param {string} [options.gameTime] - ISO timestamp of the game start time (included in result metadata).
 * @param {number} [options.maxAgeMinutes=60] - Max age of tweets/news to fetch (passed to RSS/news sources).
 * @param {boolean} [options.useXurl=false] - If true, use the paid xurl CLI for real-time X search (bypasses cache).
 * @param {boolean} [options._bypassCache=false] - Internal flag to skip cache lookup for a fresh fetch.
 * @returns {Promise<Object>} Player context object with fields:
 *   player, sport, gameTime, query, tweets (scored), news (scored), error, source,
 *   riskFlag, riskTrigger, cached, fetchedAt.
 */
async function getPlayerContext({
  player,
  sport,
  gameTime,
  maxAgeMinutes = 60,
  useXurl = false,
  _bypassCache = false
}) {
  // xurl escalation: opt-in, never the default. Bypasses the cache because
  // the whole point is real-time data when the cached/cheap path is stale.
  if (useXurl) {
    const xurlResult = await fetchViaXurl({ player, sport });
    if (xurlResult.source === 'xurl-failed') {
      return {
        player,
        sport: sport || null,
        gameTime: gameTime || null,
        query: xurlResult.query || null,
        tweets: [],
        news: [],
        error: xurlResult.error,
        source: 'xurl-failed',
        riskFlag: 'unknown',
        riskTrigger: null,
        cached: false,
        fetchedAt: new Date().toISOString()
      };
    }
    const tweets = extractXurlTweets(xurlResult.raw);
    const scoredTweets = tweets.map((t) => ({ ...t, authorityScore: scoreTweet(t, sport) }));
    const { riskFlag, riskTrigger } = assessRiskFlag(scoredTweets, []);
    return {
      player,
      sport: sport || null,
      gameTime: gameTime || null,
      query: xurlResult.query,
      tweets: scoredTweets,
      news: [],
      error: null,
      source: 'xurl',
      riskFlag,
      riskTrigger,
      cached: false,
      fetchedAt: new Date().toISOString()
    };
  }

  const key = cacheKey(player, sport, gameTime, maxAgeMinutes);
  if (!_bypassCache) {
    const cached = _ctxCache.get(key);
    if (cached) {
      return { ...cached, cached: true, fetchedAt: cached.fetchedAt };
    }
  }

  const query = buildQuery({ player, sport });

  // PRIORITY 1: Nitter RSS (fast, no auth, stable, local)
  const nitterTweets = await searchNitterRSS(query, NITTER_RSS_COUNT);

  let tweets;
  let news;
  let source;

  if (nitterTweets.length > 0) {
    tweets = nitterTweets;
    source = 'nitter-rss';
    // Also fetch a small news batch as a quality layer — beat-reporter articles
    // can surface context that X might miss. Don't downgrade the source if news
    // is empty, but upgrade to 'nitter-combined' when both succeed.
    // v2.1.9: Nitter and Google News are independent; race them in parallel
    // and pick whichever resolves first instead of waiting serially. Cuts
    // wall-clock by ~max(t_nitter, t_google) instead of t_nitter + t_google.
    const [googleNewsResult] = await Promise.allSettled([fetchGoogleNews(query, NEWS_TOP_N)]);
    news = googleNewsResult.status === 'fulfilled' ? googleNewsResult.value : [];
    if (news.length > 0) source = 'nitter-combined';
  } else {
    // PRIORITY 2: Fall back to X GraphQL (current path via nitter-session-api)
    const { tweets: xTweets } = await searchX(query);
    tweets = xTweets;

    if (tweets.length > 0) {
      source = 'x-direct';
      // v2.1.9: same parallelization — race X-tweets and Google News.
      const [googleNewsResult] = await Promise.allSettled([fetchGoogleNews(query, NEWS_TOP_N)]);
      news = googleNewsResult.status === 'fulfilled' ? googleNewsResult.value : [];
      if (news.length > 0) source = 'combined';
    } else {
      // PRIORITY 3/4: News fallbacks. v2.1.9: race Google News and ESPN in
      // parallel and take whichever returns non-empty first. The old code ran
      // them serially (Google, then ESPN if Google was empty) which doubled
      // wall-clock time on the worst-case path (no tweets at all).
      const [googleNewsResult, espnResult] = await Promise.allSettled([
        fetchGoogleNews(query, ESPN_FALLBACK_TOP_N),
        fetchEspnSearch(query)
      ]);
      const googleNews = googleNewsResult.status === 'fulfilled' ? googleNewsResult.value : [];
      const espnNews = espnResult.status === 'fulfilled' ? espnResult.value : [];
      news = googleNews.length > 0 ? googleNews : espnNews;
      source = news.length > 0 ? 'news-fallback' : 'empty';
    }
  }

  // Apply source authority scoring to each item
  const scoredTweets = tweets.map((t) => ({ ...t, authorityScore: scoreTweet(t, sport) }));
  const scoredNews = news.map((n) => ({ ...n, authorityScore: scoreNewsArticle(n, sport) }));
  const { riskFlag, riskTrigger } = assessRiskFlag(scoredTweets, scoredNews);

  const result = {
    player,
    sport: sport || null,
    gameTime: gameTime || null,
    query,
    tweets: scoredTweets,
    news: scoredNews,
    error: null,
    source,
    riskFlag,
    riskTrigger,
    fetchedAt: new Date().toISOString()
  };

  // Cache with smart TTL: short when risk is high (data may update fast),
  // normal 30 min otherwise. Note we cache BEFORE we know the next caller's
  // intent, so this is the call where risk was computed.
  const ttl = riskFlag === 'high' ? HIGH_RISK_TTL_MS : DEFAULT_TTL_MS;
  _ctxCache.set(key, result, ttl);

  return { ...result, cached: false };
}

module.exports = {
  getPlayerContext,
  searchX,
  extractTweets,
  buildQuery,
  fetchViaXurl,
  extractXurlTweets,
  invalidatePlayer,
  _ctxCache,
  sanitizePlayerName,
  cacheKey,
  DEFAULT_TTL_MS,
  HIGH_RISK_TTL_MS
};
