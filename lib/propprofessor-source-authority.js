'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Optional watchlist file. Override via env var; otherwise resolve under the
// user's real home directory (never a hardcoded author-machine path). A missing
// file degrades safely — loadWatchlists() returns an empty map.
const WATCHLIST_PATH =
  process.env.PP_SPORTS_WATCHLIST_PATH ||
  path.join(os.homedir(), '.hermes/skills/pp-sports/references/beat-reporter-watchlists.md');

let _cache = null;
let _cacheMtimeMs = 0;

/**
 * Load and parse the watchlist markdown file.
 *
 * Cached by file mtime so the watchlist can be edited without restart.
 * Re-parses on each call if the file changed.
 *
 * @returns {Object<string, {handles: Set<string>, outlets: Set<string>}>}
 *   Map of sport names to objects containing sets of beat-reporter handles
 *   and outlet domains. Returns empty object when the watchlist file does not
 *   exist.
 */
function loadWatchlists() {
  if (!fs.existsSync(WATCHLIST_PATH)) {
    return {};
  }
  const stat = fs.statSync(WATCHLIST_PATH);
  if (_cache && stat.mtimeMs === _cacheMtimeMs) {
    return _cache;
  }

  const text = fs.readFileSync(WATCHLIST_PATH, 'utf-8');
  const sections = {};
  let current = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();

    // Section header: ## Sport Name
    const headerMatch = line.match(/^##\s+([A-Za-z0-9 /&-]+?)\s*$/);
    if (headerMatch) {
      const name = headerMatch[1].trim();
      sections[name] = { handles: new Set(), outlets: new Set() };
      current = name;
      continue;
    }

    if (!current) continue;

    // Beat reporter line: - @handle
    const handleMatch = line.match(/^-\s+@(\w+)\b/);
    if (handleMatch) {
      sections[current].handles.add(handleMatch[1].toLowerCase());
      continue;
    }

    // Outlet line: - example.com or - subdomain.example.com/path
    const outletMatch = line.match(/^-\s+([a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?)/i);
    if (outletMatch) {
      sections[current].outlets.add(outletMatch[1].toLowerCase());
    }
  }

  _cache = sections;
  _cacheMtimeMs = stat.mtimeMs;
  // @ts-expect-error
  return sections;
}

/**
 * Score a tweet 0-100 based on source authority.
 *
 * Base scoring:
 * - Anyone: 30
 * - Verified account: +10
 * - Beat reporter on watchlist: +50
 * - Major outlet domain in author name: +30-40
 * - High engagement (soft signal): +5 each for >1000 likes, >500 RTs
 *
 * @param {object}  tweet  Tweet object with `author`, `isVerified`,
 *                         `favoriteCount`, and `retweetCount` properties.
 * @param {string}  sport  Sport name used to look up the watchlist section
 *                         (e.g. "NBA", "MLB").
 * @returns {number} Authority score between 0 and 100.
 */
function scoreTweet(tweet, sport) {
  if (!tweet || typeof tweet !== 'object') return 0;
  const watchlists = loadWatchlists();
  const wl = watchlists[sport] || { handles: new Set(), outlets: new Set() };
  const author = String(tweet.author || '')
    .toLowerCase()
    .replace(/^@/, '');

  let score = 30; // base

  if (wl.handles.has(author)) score += 50;
  if (author.includes('espn')) score += 40;
  else if (author.includes('athletic')) score += 35;
  else if (author.includes('bleacher') || author.includes('shersport') || author.includes('rotoworld')) score += 30;

  if (tweet.isVerified) score += 10;
  if (Number(tweet.favoriteCount) > 1000) score += 5;
  if (Number(tweet.retweetCount) > 500) score += 5;

  return Math.min(Math.max(score, 0), 100);
}

/**
 * Score a news article 0-100 based on source domain.
 *
 * @param {object}  article  Article object with `source` and `link`
 *                           properties.
 * @param {string}  sport    Sport name used to look up the watchlist section
 *                           (e.g. "NBA", "MLB").
 * @returns {number} Authority score between 0 and 100.
 */
function scoreNewsArticle(article, sport) {
  if (!article || typeof article !== 'object') return 0;
  const watchlists = loadWatchlists();
  const wl = watchlists[sport] || { handles: new Set(), outlets: new Set() };
  const source = String(article.source || '').toLowerCase();
  const link = String(article.link || '').toLowerCase();

  let score = 30;

  if (Array.from(wl.outlets).some((o) => link.includes(o) || source.includes(o))) {
    score += 50;
  }
  if (source.includes('espn')) score += 40;
  else if (source.includes('athletic')) score += 35;
  else if (source.includes('bleacher') || source.includes('shersport') || source.includes('rotoworld')) score += 30;

  return Math.min(Math.max(score, 0), 100);
}

const INJURY_KEYWORDS =
  /\b(injur(?:y|ed|ies)?|out for|withdrew|withdrawal|surgery|illness|concussion|strain|sprain|tear|broken|fracture|suspended|DNP|day-to-day|ruled out)\b/i;
const HIGH_AUTHORITY_THRESHOLD = 70;
const RECENT_WINDOW_MS = 120 * 60 * 1000; // 2 hours

/**
 * Convert a tweet created_at string to age in minutes. X format: "Mon Jun 02 12:00:00 +0000 2026".
 * Returns Infinity when the date is unparseable (treated as "old" for risk-flagging purposes).
 */
function tweetAgeMinutes(tweet) {
  if (!tweet || !tweet.createdAt) return Infinity;
  const t = Date.parse(tweet.createdAt);
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, (Date.now() - t) / (60 * 1000));
}

function newsAgeMinutes(article) {
  if (!article || !article.pubDate) return Infinity;
  const t = Date.parse(article.pubDate);
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, (Date.now() - t) / (60 * 1000));
}

/**
 * Assess risk flag from a list of tweets and news articles.
 *
 * Rules:
 * - 'high': any item with score >= HIGH_AUTHORITY_THRESHOLD AND injury keyword
 *   AND age < 2 hours
 * - 'monitor': any item with score >= 40 AND injury keyword AND age < 60 min,
 *   OR any item with injury keyword at any score AND age < 60 min
 * - 'clean': no injury keywords anywhere
 *
 * @param {Array<object>} [tweets=[]]  Array of tweet objects, each expected to
 *   have `text` and `authorityScore` properties.
 * @param {Array<object>} [news=[]]    Array of news article objects, each
 *   expected to have `title` and `authorityScore` properties.
 * @returns {{ riskFlag: 'clean'|'monitor'|'high', riskTrigger: string|null }}
 *   Risk assessment result with a flag and a human-readable trigger message.
 */
function assessRiskFlag(tweets = [], news = []) {
  const allItems = [
    ...tweets.map((t) => ({ text: t.text || '', score: t.authorityScore || 0, ageMin: tweetAgeMinutes(t) })),
    ...news.map((n) => ({ text: n.title || '', score: n.authorityScore || 0, ageMin: newsAgeMinutes(n) }))
  ];

  for (const item of allItems) {
    if (
      item.score >= HIGH_AUTHORITY_THRESHOLD &&
      INJURY_KEYWORDS.test(item.text) &&
      item.ageMin < RECENT_WINDOW_MS / 60000
    ) {
      return {
        riskFlag: 'high',
        riskTrigger: `High-authority (${Math.round(item.score)}) + injury: "${item.text.slice(0, 200)}"`
      };
    }
  }

  for (const item of allItems) {
    if (INJURY_KEYWORDS.test(item.text) && item.ageMin < 60) {
      return { riskFlag: 'monitor', riskTrigger: `Injury keyword in last hour: "${item.text.slice(0, 200)}"` };
    }
  }

  return { riskFlag: 'clean', riskTrigger: null };
}

module.exports = {
  loadWatchlists,
  scoreTweet,
  scoreNewsArticle,
  assessRiskFlag,
  INJURY_KEYWORDS,
  HIGH_AUTHORITY_THRESHOLD,
  WATCHLIST_PATH
};
