'use strict';

const cp = require('child_process');
// Note: we cannot capture promisify(execFile) at module load time because
// tests mock cp.execFile by reassignment, and the promisified wrapper would
// hold the original reference. Instead we re-create the promise on each call.
const pExecFile = (...args) =>
  new Promise((resolve, reject) => {
    const execFile = /** @type {*} */ (cp.execFile);
    execFile(...args, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });

const CURL_TIMEOUT_MS = 10000;
const DEFAULT_NEWS_RESULTS = 10;
const NITTER_BASE = process.env.NITTER_BASE || 'http://localhost:8080';
const NITTER_RSS_COUNT = 30;

/**
 * Build a Google News RSS search URL for the given query.
 * Uses the legacy public RSS endpoint — no API key required, no rate limit.
 * @param {string} query - The search query string.
 * @returns {string} Fully qualified Google News RSS URL.
 */
function buildGoogleNewsUrl(query) {
  // Google News legacy public RSS — no API key, no rate limit.
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

/**
 * Build an ESPN search URL for the given query.
 * @param {string} query - The search query string.
 * @returns {string} Fully qualified ESPN search URL.
 */
function buildEspnSearchUrl(query) {
  return `https://www.espn.com/search/_/q/${encodeURIComponent(query)}`;
}

/**
 * Strip CDATA wrapper from a string, if present.
 * @param {*} s - The value to process (non-strings are coerced to '').
 * @returns {string} The string with CDATA markers removed.
 */
function stripCdata(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/**
 * Parse a Google News RSS XML blob into a flat array of { title, link, pubDate, source }.
 * Returns an empty array on any parse failure (graceful degradation).
 * Also handles Nitter RSS format which uses <dc:creator> for author.
 * @param {string} xml - The raw RSS XML string to parse.
 * @returns {Array<{title: string, link: string, pubDate: string, source: string}>} Parsed RSS items.
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
    // Try standard <source> (Google News), then <dc:creator> (Nitter), then extract from title
    let source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    if (!source) {
      // Nitter uses <dc:creator>@handle</dc:creator>
      source = (block.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/) || [])[1] || '';
    }
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
 * Parse ESPN search HTML for relevant article links.
 * Looks for <a href="https://*.espn.com/...">TITLE</a> patterns.
 * Returns at most 10 results.
 * @param {string} html - The raw ESPN search HTML to parse.
 * @returns {Array<{title: string, link: string, pubDate: string, source: string}>} Parsed article items.
 */
function parseEspnSearch(html) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const items = [];
  const re = /<a[^>]*href="(https:\/\/(?:www\.)?espn\.com\/[^"]+)"[^>]*>([^<]{10,300})<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    items.push({
      title: m[2].trim(),
      link: m[1],
      pubDate: '',
      source: 'ESPN'
    });
    if (items.length >= 10) break;
  }
  return items;
}

/**
 * Fetch recent news articles for a query from Google News RSS.
 * Returns up to maxResults items. Empty array on any error.
 * @param {string} query - The search query string.
 * @param {number} [maxResults=10] - Maximum number of results to return.
 * @returns {Promise<Array<{title: string, link: string, pubDate: string, source: string}>>} Array of news article objects.
 */
async function fetchGoogleNews(query, maxResults = DEFAULT_NEWS_RESULTS) {
  try {
    const url = buildGoogleNewsUrl(query);
    const { stdout } = await pExecFile('curl', ['-sL', '--max-time', String(CURL_TIMEOUT_MS / 1000), url], {
      timeout: CURL_TIMEOUT_MS
    });
    return parseRss(stdout).slice(0, maxResults);
  } catch {
    return [];
  }
}

/**
 * Fetch ESPN search results for a query. Used as a secondary fallback when
 * Google News returns nothing. Empty array on any error.
 * @param {string} query - The search query string.
 * @returns {Promise<Array<{title: string, link: string, pubDate: string, source: string}>>} Array of article objects.
 */
async function fetchEspnSearch(query) {
  try {
    const url = buildEspnSearchUrl(query);
    const { stdout } = await pExecFile('curl', ['-sL', '--max-time', String(CURL_TIMEOUT_MS / 1000), url], {
      timeout: CURL_TIMEOUT_MS
    });
    return parseEspnSearch(stdout);
  } catch {
    return [];
  }
}

/**
 * Fetch tweets from Nitter's RSS search endpoint.
 * Nitter's /search/rss?f=tweets&q=query returns tweet items with title (full text),
 * link (tweet URL), pubDate, and source (author @handle). No auth required.
 * Returns normalized tweets: { text, author, authorName, createdAt, favoriteCount, retweetCount, isRetweet, isVerified, link }
 * @param {string} query - The search query string for finding relevant tweets.
 * @param {number} [maxResults=30] - Maximum number of tweet results to return.
 * @returns {Promise<Array<{text: string, author: string, authorName: string, createdAt: string, favoriteCount: number, retweetCount: number, isRetweet: boolean, isVerified: boolean, link: string, tweetId: (string|null)}>>} Array of normalized tweet objects.
 */
async function searchNitterRSS(query, maxResults = NITTER_RSS_COUNT) {
  try {
    const url = `${NITTER_BASE}/search/rss?f=tweets&q=${encodeURIComponent(query)}`;
    const { stdout } = await pExecFile('curl', ['-sL', '--max-time', String(CURL_TIMEOUT_MS / 1000), url], {
      timeout: CURL_TIMEOUT_MS
    });
    const items = parseRss(stdout).slice(0, maxResults);

    // Convert RSS items to tweet shape matching extractTweets output
    return items.map((item) => {
      // Extract author from source field (format: "@handle" or "handle")
      const sourceAuthor = item.source?.replace(/^@/, '') || 'unknown';
      // Try to extract tweet ID from link for potential deduplication
      const tweetIdMatch = item.link?.match(/\/status\/(\d+)/);

      return {
        text: item.title || '',
        author: sourceAuthor,
        authorName: sourceAuthor,
        createdAt: item.pubDate || '',
        favoriteCount: 0,
        retweetCount: 0,
        isRetweet: item.title?.startsWith('RT @') || false,
        isVerified: false,
        link: item.link || '',
        tweetId: tweetIdMatch ? tweetIdMatch[1] : null
      };
    });
  } catch {
    return [];
  }
}

module.exports = {
  fetchGoogleNews,
  fetchEspnSearch,
  searchNitterRSS,
  parseRss,
  parseEspnSearch,
  buildGoogleNewsUrl,
  buildEspnSearchUrl,
  stripCdata
};
