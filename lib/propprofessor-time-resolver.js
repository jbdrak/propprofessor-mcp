'use strict';

/**
 * PropProfessor Time Resolver
 *
 * Multi-source tennis match time correction.
 *
 * Sources (in priority order):
 *   1. ESPN API — ATP/WTA main tour (handled by correctTennisTimes in tennis.js)
 *   2. Sofascore via Python cloudscraper — bypasses Cloudflare, covers live/scheduled
 *   3. Tennis.com direct page scraping — fallback for specific matches
 *
 * Wired into correctTennisTimes() so every tennis screen has corrected times.
 */

const cp = require('child_process');
const path = require('path');
const { localDateKey } = require('./mcp-runtime-config');

// Successful (non-empty) Sofascore day cache TTL.
const CACHE_TTL_MS = 10 * 60 * 1000;
// Short TTL for empty/no-result Sofascore fetches (zero-result day, helper or
// dependency failure). Prevents each player pair from respawning Python and
// retrying the network when there is nothing to fetch.
const EMPTY_RESULT_CACHE_TTL_MS = 60 * 1000;

const _cache = new Map();
const _sofascoreCache = { data: null, ts: 0 };
const _sofascoreEmptyCache = { ts: 0 };

let _reportedSofascoreHelperUnavailable = false;

/**
 * One-time concise stderr diagnostic when the Sofascore Python helper cannot
 * produce data (script/python3 missing, or a dependency such as cloudscraper
 * is missing). Matches the existing [time-resolver] stderr convention;
 * reported once per process so the per-match fallback path stays quiet.
 */
function _reportSofascoreHelperUnavailable(reason) {
  if (_reportedSofascoreHelperUnavailable) return;
  _reportedSofascoreHelperUnavailable = true;
  if (typeof process !== 'undefined' && process.stderr) {
    process.stderr.write(
      `[time-resolver] Sofascore helper unavailable: ${reason} — install scripts/fetch-sofascore.py (python3 + cloudscraper) to enable Sofascore times\n`
    );
  }
}

// ─── Source 2: Sofascore via Python cloudscraper ─────────────────────────

/**
 * Run the Sofascore Python helper asynchronously.
 *
 * Mirrors the fresh-promise cp.execFile(...) wrapper used elsewhere in lib/
 * (player-context, tennis-context, ...): never blocks the event loop, and
 * tests can stub child_process via Module._load or by reassigning cp.execFile.
 *
 * @param {string} scriptPath - Absolute path to scripts/fetch-sofascore.py
 * @param {string} today - YYYY-MM-DD local date key for the Sofascore endpoint
 * @returns {Promise<string>} stdout on success
 */
function runSofascoreHelper(scriptPath, today) {
  return new Promise((resolve, reject) => {
    cp.execFile(
      'python3',
      [scriptPath, today],
      { timeout: 20000, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      }
    );
  });
}

/**
 * Fetch all tennis matches from Sofascore via the cloudscraper Python helper.
 *
 * Non-empty results are cached for CACHE_TTL_MS (10 min). An empty result —
 * a legitimate zero-match day, malformed output, or a helper/dependency
 * failure — is honored for EMPTY_RESULT_CACHE_TTL_MS (60 s) so a batch of
 * player pairs does not respawn Python or retry the network once per pair.
 * Never throws: callers fall back to cached data or an empty match list.
 *
 * @returns {Promise<Array<Object>>} Sofascore match list (possibly empty)
 */
async function fetchSofascoreMatches() {
  const now = Date.now();

  // 1. Fresh successful (non-empty) day cache wins.
  if (_sofascoreCache.data && now - _sofascoreCache.ts < CACHE_TTL_MS) {
    return _sofascoreCache.data;
  }

  // 2. Recent empty/no-result fetch (zero-result day, malformed output, or
  //    helper failure) short-TTL guard: do not respawn Python per pair.
  if (now - _sofascoreEmptyCache.ts < EMPTY_RESULT_CACHE_TTL_MS) {
    return [];
  }

  const scriptPath = path.join(__dirname, '..', 'scripts', 'fetch-sofascore.py');
  const today = localDateKey(Date.now(), 'America/Chicago');

  let stdout;
  try {
    stdout = await runSofascoreHelper(scriptPath, today);
  } catch (err) {
    // Helper unavailable (ENOENT/ENOTDIR) or dependency failure (non-zero
    // exit, e.g. missing cloudscraper): report once per process, then fall
    // back to cached data or an empty list. Never throw.
    if (_sofascoreCache.data) return _sofascoreCache.data;
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      _reportSofascoreHelperUnavailable(`${scriptPath} not found (ENOENT)`);
    } else if (err && typeof err.code === 'number' && err.code !== 0) {
      _reportSofascoreHelperUnavailable(`python3 exited ${err.code} (missing cloudscraper?)`);
    }
    _sofascoreEmptyCache.ts = Date.now();
    return [];
  }

  let matches;
  try {
    matches = JSON.parse(stdout.trim());
  } catch {
    // Malformed helper output: treat as no results for the short TTL.
    _sofascoreEmptyCache.ts = Date.now();
    return [];
  }

  if (!Array.isArray(matches)) {
    // Unexpected output shape: treat as no results for the short TTL.
    _sofascoreEmptyCache.ts = Date.now();
    return [];
  }

  if (matches.length > 0) {
    _sofascoreCache.data = matches;
    _sofascoreCache.ts = Date.now();
    if (typeof process !== 'undefined' && process.stderr) {
      process.stderr.write(`[time-resolver] Sofascore: ${matches.length} matches via cloudscraper\n`);
    }
  } else {
    _sofascoreEmptyCache.ts = Date.now();
  }
  return matches;
}

/**
 * Find a match in Sofascore data by player names.
 */
function findSofascoreMatch(matches, player1, player2) {
  const p1 = player1.toLowerCase().trim();
  const p2 = player2.toLowerCase().trim();

  for (const m of matches) {
    const h = (m.homeTeam || '').toLowerCase().trim();
    const a = (m.awayTeam || '').toLowerCase().trim();

    // Check both orderings (home/away can be swapped in tennis)
    const matchOrder1 = (h.includes(p1) || p1.includes(h)) && (a.includes(p2) || p2.includes(a));
    const matchOrder2 = (h.includes(p2) || p2.includes(h)) && (a.includes(p1) || p1.includes(a));

    if (matchOrder1 || matchOrder2) {
      return {
        time: m.startTime,
        confidence: 0.85,
        source: 'sofascore'
      };
    }
  }
  return null;
}

// ─── Source 3: Tennis.com (direct page scraping) ─────────────────────────

async function httpGet(url, timeoutMs = 6000) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Accept: 'text/html'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function searchTennisCom(player1, player2) {
  try {
    const html = await httpGet(
      `https://www.tennis.com/search?q=${encodeURIComponent(player1 + ' ' + player2 + ' tennis')}`,
      8000
    );
    const paths = [...new Set(html.match(/\/tournaments\/[^"']+\/matches\/[^"']+/g) || [])];
    for (const p of paths.slice(0, 5)) {
      try {
        const mh = await httpGet(`https://www.tennis.com${p}`, 6000);
        const sd = mh.match(/"startDate":"([^"]+)"/);
        if (sd) {
          const time = new Date(sd[1]);
          if (!isNaN(time.getTime()) && time.getTime() > Date.now() - 3 * 86400000) {
            return { time: time.toISOString(), confidence: 0.9, source: 'tennis.com' };
          }
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* search failed */
  }
  return null;
}

// ─── Main API ────────────────────────────────────────────────────────────

function normalize(name) {
  return name.toLowerCase().trim().replace(/-/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Resolve a match time from fallback sources.
 * Called by correctTennisTimes after ESPN fails to find the match.
 *
 * Sources tried in order: Sofascore (via cloudscraper) → Tennis.com
 *
 * @param {string} player1 - Player name
 * @param {string} player2 - Player name
 * @returns {Promise<{time: string, confidence: number, source: string}|null>}
 */
async function resolveMatchTime(player1, player2) {
  const key = `${normalize(player1)}::${normalize(player2)}`;
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  // Source 2: Sofascore via Python cloudscraper
  const sofascoreMatches = await fetchSofascoreMatches();
  let result = findSofascoreMatch(sofascoreMatches, player1, player2);

  // Source 3: Tennis.com
  if (!result) {
    result = await searchTennisCom(player1, player2);
  }

  if (result) {
    _cache.set(key, { ts: Date.now(), result });
  }
  return result;
}

module.exports = { resolveMatchTime };
