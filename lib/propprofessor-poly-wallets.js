'use strict';

// lib/propprofessor-poly-wallets.js — Polymarket wallet overlay for CLI scans.
//
// Attaches `play.polyWallet` context to scan plays when top Polymarket
// traders (leaderboard by P&L) currently hold a net position on the same
// matchup. Pure enrichment — never changes ranking, movement, verdict, or
// edge — mirroring the Elo overlay (propprofessor-elo-overlay.js).
//
// Why this exists: PolyGun's "smart wallets" marketing (weekly P&L cards)
// is a closed Telegram bot with no public API, and its headline numbers
// are survivorship-biased. The underlying DATA is public on Polymarket,
// free, zero auth:
//   GET https://data-api.polymarket.com/v1/leaderboard?limit=N  -> top wallets
//   GET https://data-api.polymarket.com/activity?user=ADDR      -> live trades
//
// The /positions endpoint is the authoritative live-holdings source. The
// /activity feed remains a compatibility fallback for API failures and tests.
//
// Matching is deliberately conservative (same philosophy as the Elo
// overlay):
//   - the play selection must appear in the position's market title
//     (normalized containment, min 3 chars — no guessed surnames)
//   - aligned = wallet holds the SAME side as the play selection
//   - against = wallet holds a DIFFERENT side of the same matchup
//   - ambiguous (Yes/No props, unresolved names) -> no claim
// No I/O at module load. fetch injectable for tests.

const { normalizeName } = require('./tennis-elo-data');

const DATA_API = 'https://data-api.polymarket.com';
const LEADERBOARD_URL = DATA_API + '/v1/leaderboard';
const POSITIONS_URL = DATA_API + '/positions';
const ACTIVITY_URL = DATA_API + '/activity';
const TTL_MS = 60 * 1000;
const MIN_SELECTION_CHARS = 3;
const MIN_STANCE_USDC = 100;
const DEFAULT_WALLET_LIMIT = 20;
const MAX_WALLET_LIMIT = 50;
const ACTIVITY_LIMIT = 500;
const MATCHUP_SPLIT_RE = /\s+vs\.?\s+|\s+@\s+/i;

// Date regex for eventSlug segments like `mlb-sea-hou-2026-08-16`.
const SLUG_DATE_RE = /(\d{4})-(\d{2})-(\d{2})$/;

/** True when the eventSlug's trailing YYYY-MM-DD is before today.
 *  A trailing date in the future or a missing/unparseable slug -> false (live),
 *  so we never false-drop a real position on a still-active market. */
function isSettledBySlug(eventSlug) {
  if (!eventSlug) return false;
  const m = String(eventSlug).match(SLUG_DATE_RE);
  if (!m) return false;
  const [, y, mo, d] = m;
  const dt = new Date(y + '-' + mo + '-' + d + 'T12:00:00Z');
  if (Number.isNaN(dt.getTime())) return false;
  const today = new Date();
  const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return dt < todayOnly;
}

// Module-level leaderboard cache (activity is fetched fresh every call —
// trades move faster than the leaderboard itself).
const defaultCache = { at: 0, value: null };

/** Strip punctuation/diacritics and normalize for matching (UPPERCASE). */
function normForMatch(value) {
  return normalizeName(String(value))
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The other side of a matchup market whose title contains `selectionNorm`.
 * Splits on " vs " / " vs. " / " @ ", finds the segment containing the
 * selection, and returns a different segment if one exists. Returns null
 * when the title isn't a matchup or the selection resolves nowhere.
 */
function otherSideOfMatchup(title, selectionNorm) {
  const normTitle = normForMatch(title);
  if (!normTitle.includes(selectionNorm)) return null;
  const rawParts = String(title || '').split(MATCHUP_SPLIT_RE);
  if (rawParts.length < 2) return null;
  for (let i = 0; i < rawParts.length; i++) {
    if (normForMatch(rawParts[i]).includes(selectionNorm)) {
      const others = rawParts.filter((_, j) => j !== i).map(normForMatch);
      return others.length ? others[others.length - 1] : null;
    }
  }
  return null;
}

/** Classify one wallet stance against a play. Returns null when unclaimable.
 *
 * Deliberately does NOT use leagueFromSlug: the scan overlay matches on
 * title containment (same philosophy as the Elo overlay — "did a top wallet
 * bet on this exact play?"). The `pp wallets` command uses leagueFromSlug via
 * resolveStance — that path was broken for ATP/WTA/ITF until 2026-08-17 when
 * SLUG_LEAGUE_MAP was extended. Keeping the two paths separate means the
 * overlay keeps working even if the slug map regresses.
 */
function classifyPosition(play, stance) {
  const selectionNorm = normForMatch(play.selection || play.participant || '');
  if (selectionNorm.length < MIN_SELECTION_CHARS) return null;

  const title = String(stance.title || '');
  const outcomeNorm = normForMatch(stance.outcome || '');
  const normTitle = normForMatch(title);
  if (!outcomeNorm) return null;

  // TOTAL (O/U) markets: title like 'A vs B: O/U 8.5' with outcome 'Over' or
  // 'Under'. The play's selection is 'Over 8.5'/'Under 8.5' (or bare
  // 'Over'/'Under') — the numeric line never appears in the title, so match
  // the leading direction only. Titled with a literal '/', which
  // normForMatch strips, so test the RAW title. Ambiguous combos fall
  // through to the moneyline path and stay null there.
  if (/o\/u/i.test(title)) {
    const selDir = /^(OVER|UNDER)\b/.exec(selectionNorm);
    const outDir = /^(OVER|UNDER)\b/.exec(outcomeNorm);
    if (selDir && outDir) return selDir[1] === outDir[1] ? 'aligned' : 'against';
  }

  // SPREAD/handicap markets: title like 'Spread: A (-1.5)' with outcome 'A'.
  // The play's selection carries the line ('A -1.5'), which normalizes to a
  // superset of the outcome team — containment on the normalized team names
  // decides aligned. For against, reuse otherSideOfMatchup when the title
  // names both sides; otherwise the matchup is unresolvable -> null.
  if (/^spread\s*:/i.test(title)) {
    if (selectionNorm.includes(outcomeNorm)) return 'aligned';
    const other = otherSideOfMatchup(title, selectionNorm);
    if (other && other.includes(outcomeNorm)) return 'against';
    return null;
  }

  // Moneyline path (unchanged): the play's selection must appear in the
  // market title before we claim anything.
  if (!normTitle.includes(selectionNorm)) return null;

  // Aligned: wallet stance outcome IS the play's selection.
  if (outcomeNorm === selectionNorm) return 'aligned';

  // Against: same matchup title, wallet stance outcome is some other side.
  if (outcomeNorm !== selectionNorm && normTitle.includes(outcomeNorm)) return 'against';

  return null;
}

/**
 * Fetch top traders by P&L. Cached TTL_MS. Returns [] on any failure —
 * enrichment swallows errors, never throws to the caller.
 */
async function fetchLeaderboard(limit, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (typeof fetchImpl !== 'function') return [];
  const cacheStore = o.leaderboardCache || defaultCache;
  const ttl = o.ttlMs == null ? TTL_MS : o.ttlMs;
  const take = Math.max(1, Math.min(limit || DEFAULT_WALLET_LIMIT, MAX_WALLET_LIMIT));

  const now = Date.now();
  if (cacheStore.value && now - cacheStore.at < ttl) {
    return cacheStore.value.slice(0, take);
  }

  try {
    const res = await fetchImpl(LEADERBOARD_URL + '?limit=' + MAX_WALLET_LIMIT, {
      headers: { Accept: 'application/json' }
    });
    if (!res || !res.ok) return [];
    const data = await res.json();
    const rows = Array.isArray(data)
      ? data
          .filter((r) => r && r.proxyWallet)
          .map((r) => ({
            proxyWallet: String(r.proxyWallet),
            userName: String(r.userName || r.proxyWallet.slice(0, 10) || 'wallet'),
            pnl: Number(r.pnl) || 0
          }))
      : [];
    cacheStore.at = now;
    cacheStore.value = rows;
    return rows.slice(0, take);
  } catch {
    return [];
  }
}

/**
 * Derive a wallet's current stances from its recent activity feed.
 * Nets BUY vs SELL usdc per (conditionId, outcome): positive net means
 * the wallet still holds that side. Returns [] on failure.
 *
 * Stances on settled markets are dropped: a losing position generates no
 * REDEEM row, so without this a settled-loss shows as a stale "live"
 * position. Settled-ness is derived from the market's `eventSlug` date
 * (e.g. `mlb-sea-hou-2026-08-16`) — a free, authoritative signal that
 * needs no extra API call and degrades cleanly when the slug is absent
 * or unparseable (treats unknown as live rather than false-dropping).
 *
 * @param {string} userAddr
 * @returns {Promise<Array<{conditionId, title, outcome, dollar, eventSlug}>>}
 */
async function fetchWalletStances(userAddr, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (typeof fetchImpl !== 'function' || !userAddr) return [];

  // Prefer the current-position snapshot. It avoids false negatives caused by
  // trying to reconstruct holdings from only the latest activity page.
  try {
    const positionsUrl =
      POSITIONS_URL +
      '?user=' +
      encodeURIComponent(userAddr) +
      '&sizeThreshold=0&limit=500&offset=0&sortBy=CURRENT&sortDirection=DESC';
    const positionsRes = await fetchImpl(positionsUrl, { headers: { Accept: 'application/json' } });
    if (positionsRes && positionsRes.ok) {
      const data = await positionsRes.json();
      if (
        Array.isArray(data) &&
        (data.length === 0 ||
          data.some(
            (p) => p && p.conditionId && p.title && p.outcome && ('size' in p || 'currentValue' in p || 'initialValue' in p)
          ))
      ) {
        return data
          .filter((p) => p && p.conditionId && p.title && p.outcome && Number(p.size) > 0)
          .map((p) => {
            const currentValue = Number(p.currentValue) || 0;
            const initialValue = Number(p.initialValue) || 0;
            const size = Number(p.size) || 0;
            return {
              conditionId: String(p.conditionId),
              title: String(p.title),
              outcome: String(p.outcome),
              dollar: Math.round(currentValue > 0 ? currentValue : initialValue > 0 ? initialValue : size),
              eventSlug: String(p.eventSlug || p.slug || '')
            };
          })
          .filter((p) => p.dollar >= MIN_STANCE_USDC)
          .filter((p) => !isSettledBySlug(p.eventSlug));
      }
    }
  } catch {
    // Fall back to activity reconstruction below.
  }

  // Compatibility fallback for older/API-degraded environments. This path is
  // intentionally retained, but it is no longer the normal source of truth.
  try {
    const res = await fetchImpl(ACTIVITY_URL + '?user=' + encodeURIComponent(userAddr) + '&limit=' + ACTIVITY_LIMIT, {
      headers: { Accept: 'application/json' }
    });
    if (!res || !res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    const net = new Map(); // key: conditionId|outcome -> { conditionId, title, outcome, dollar, ts, eventSlug }
    for (const t of data) {
      if (!t || t.type !== 'TRADE') continue;
      const side = String(t.side || '').toUpperCase();
      if (side !== 'BUY' && side !== 'SELL') continue;
      const conditionId = String(t.conditionId || '');
      const outcome = String(t.outcome || '');
      const title = String(t.title || t.slug || '');
      const eventSlug = String(t.eventSlug || t.slug || '');
      if (!conditionId || !outcome || !title) continue;
      const usdc = Number(t.usdcSize) || 0;
      if (usdc <= 0) continue;
      const key = conditionId + '|' + outcome;
      const prev = net.get(key) || { conditionId, title, outcome, dollar: 0, ts: 0, eventSlug };
      prev.dollar += side === 'BUY' ? usdc : -usdc;
      const ts = Number(t.timestamp) || 0;
      // Carry eventSlug through the merge; the latest row's value wins and
      // untimestamped rows never clobber a timestamped one.
      if (ts >= prev.ts || !prev.eventSlug) prev.eventSlug = eventSlug;
      prev.ts = Math.max(prev.ts, ts);
      net.set(key, prev);
    }
    // A REDEEM row collapses the stance to zero (they cashed out).
    for (const t of data) {
      if (!t || t.type !== 'REDEEM') continue;
      const conditionId = String(t.conditionId || '');
      const outcome = String(t.outcome || '');
      if (!conditionId || !outcome) continue;
      const key = conditionId + '|' + outcome;
      if (net.has(key)) net.delete(key);
    }
    return [...net.values()]
      .filter((s) => s.dollar >= MIN_STANCE_USDC)
      .filter((s) => !isSettledBySlug(s.eventSlug))
      .map((s) => ({
        conditionId: s.conditionId,
        title: s.title,
        outcome: s.outcome,
        dollar: Math.round(s.dollar),
        eventSlug: s.eventSlug
      }));
  } catch {
    return [];
  }
}

/** Fetch stances for many wallets in parallel; individual failures degrade to []. */
async function fetchWalletStancesAll(wallets, opts) {
  const settled = await Promise.all(
    wallets.map(async (w) => ({ wallet: w, stances: await fetchWalletStances(w.proxyWallet, opts) }))
  );
  return settled.filter((s) => s.stances.length > 0);
}

/**
 * Match a single play against every wallet's stances.
 * @returns {{ available: boolean, coverage: string, aligned: object|null, against: object|null }}
 */
function matchPlayToWallet(play, walletRows) {
  const aligned = new Map(); // proxyWallet -> { userName, dollar, lifetimePnl }
  const against = new Map();

  for (const row of walletRows || []) {
    if (!row || !row.wallet || !Array.isArray(row.stances)) continue;
    const { wallet, stances } = row;
    for (const stance of stances) {
      let side;
      try {
        side = classifyPosition(play, stance);
      } catch {
        side = null;
      }
      if (!side) continue;
      const bucket = side === 'aligned' ? aligned : against;
      const prev = bucket.get(wallet.proxyWallet) || { userName: wallet.userName, dollar: 0, lifetimePnl: wallet.pnl };
      prev.dollar += stance.dollar;
      bucket.set(wallet.proxyWallet, prev);
    }
  }

  const summarize = (map) =>
    map.size === 0
      ? null
      : {
          walletCount: map.size,
          totalDollars: [...map.values()].reduce((s, v) => s + v.dollar, 0),
          wallets: [...map.values()].map((v) => ({
            userName: v.userName,
            dollar: Math.round(v.dollar),
            lifetimePnl: Math.round(v.lifetimePnl)
          }))
        };

  return {
    available: true,
    coverage: aligned.size || against.size ? 'matched' : 'no_match',
    aligned: summarize(aligned),
    against: summarize(against)
  };
}

/**
 * Enrich scan result buckets in place: attach `play.polyWallet` for plays
 * with a resolvable wallet stance. Pure enrichment — never throws, never
 * breaks the scan. On a fetch-level failure the scan passes through
 * untouched (silent no-op, same as a missing Elo snapshot).
 *
 * @param {Array} results - scan result buckets ({ league, market, plays })
 * @param {object} [opts]
 * @param {number} [opts.limit=20] - top-N wallets to scan
 * @param {Function} [opts.fetchImpl] - injectable fetch for tests
 * @param {object} [opts.leaderboardCache] - injectable cache store for tests
 * @returns {Promise<Array>} the same results array (mutated in place)
 */
async function enrichScanPolyWallets(results, opts) {
  if (!Array.isArray(results)) return results;
  const o = opts || {};

  const wallets = await fetchLeaderboard(o.limit || DEFAULT_WALLET_LIMIT, o);
  if (wallets.length === 0) return results;
  const walletRows = await fetchWalletStancesAll(wallets, o);
  if (walletRows.length === 0) return results;

  for (const bucket of results) {
    if (!bucket) continue;
    const plays = Array.isArray(bucket.plays)
      ? bucket.plays
      : Array.isArray(bucket.candidates)
        ? bucket.candidates
        : [];
    for (const play of plays) {
      try {
        if (!play || (play.polyWallet !== undefined && play.polyWallet !== null)) continue;
        play.polyWallet = matchPlayToWallet(play, walletRows);
      } catch {
        play.polyWallet = { available: false, coverage: 'overlay_error', aligned: null, against: null };
      }
    }
  }
  return results;
}

module.exports = {
  isSettledBySlug,
  enrichScanPolyWallets,
  fetchLeaderboard,
  fetchWalletStances,
  fetchWalletStancesAll,
  matchPlayToWallet,
  classifyPosition,
  otherSideOfMatchup,
  normForMatch,
  DEFAULT_WALLET_LIMIT,
  MIN_STANCE_USDC
};
