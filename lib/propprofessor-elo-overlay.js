'use strict';

// lib/propprofessor-elo-overlay.js — CLI scan elo overlay.
//
// Attaches shadow-Elo context to Tennis Moneyline plays in scan results so
// the CLI can show "elo vs market" at a glance. Pure enrichment: never
// changes ranking, movement, verdict, or edge — it only ADDS `play.elo`.
//
// Why this exists: the MCP server path (runResearchOnTopRows / record
// candidates) already overlays elo, but the CLI scan calls quick_screen
// with includeResearch:false, so scan output never carries it. This module
// is the CLI-side seam.
//
// Name resolution is deliberately conservative:
//  - Scan rows carry short names ("Bucsa"); the snapshot stores full names
//    ("CRISTINA BUCSA"). We match on normalized full name or any single
//    token, and require a UNIQUE match. Ambiguous short names (e.g.
//    "Harris" when LLOYD HARRIS and RYAN HARRIS both exist) fall back to
//    the player with the most total matches, but only when that player's
//    match count is >= 3x the runner-up — otherwise the name is genuinely
//    ambiguous and elo is reported unavailable. No guessed surnames.
//  - Tour is detected by trying ATP first, then WTA, requiring BOTH players
//    to resolve inside the same pool.
//  - marketFairProbability is derived from the play's American odds (the
//    scanned book is no-vig, so implied ~ fair). disagreement =
//    elo(selection) - market(selection); positive means elo is MORE
//    confident than the market on the bet side.
//
// No I/O at module load. Snapshot loading is delegated to the injected
// loadSnapshot (default: tennis-elo-data's loadSnapshot, safe-unavailable)
// and only happens when a Tennis Moneyline play needs it.

const { getTennisEloContext } = require('./propprofessor-tennis-context');
const { normalizeName, loadSnapshot: defaultLoadSnapshot } = require('./tennis-elo-data');

const ML_RE = /moneyline|money line|^ml$/i;
const VS_RE = /\s+vs\.?\s+/i;
const AT_RE = /\s+@\s+/i;

/** American odds -> implied probability (0..1). Null for non-finite/0. */
function americanToProb(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  return o > 0 ? 100 / (o + 100) : -o / (-o + 100);
}

/** Normalize a name for matching: strip apostrophes, diacritics, collapse. */
function normName(value) {
  return normalizeName(String(value).replace(/['\u2019]/g, ''));
}

/**
 * Resolve a short scan name to a unique snapshot pool key.
 * @param {object} pool - snapshot.players[TOUR] map (key -> player record)
 * @param {string} shortName - e.g. "Bucsa" or "Novak Djokovic"
 * @returns {string|null} pool key, or null when unresolvable/ambiguous.
 */
function resolvePoolKey(pool, shortName) {
  const needle = normName(shortName);
  if (!needle || typeof pool !== 'object' || pool === null) return null;

  const matches = [];
  for (const [key, player] of Object.entries(pool)) {
    if (!player || typeof player !== 'object') continue;
    const full = normName(player.name || key);
    if (!full) continue;
    const tokens = full.split(' ');
    if (full === needle || tokens.includes(needle)) matches.push({ key, matches: player.totalMatches || 0 });
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].key;

  // Ambiguous: prefer the most active player, but only when clearly dominant
  // (>= 3x the runner-up). Otherwise the short name is genuinely ambiguous.
  matches.sort((a, b) => b.matches - a.matches);
  const [top, second] = matches;
  if (top.matches >= 3 * (second ? second.matches : 0) && top.matches > 0) return top.key;
  return null;
}

/**
 * Determine which resolved side a play's selection refers to.
 * @returns {string|null} display name of the matched side, or null.
 */
function matchSelectionSide(poolKey1, poolKey2, pool, selection) {
  if (!selection) return null;
  const needle = normName(selection);
  if (!needle) return null;

  for (const key of [poolKey1, poolKey2]) {
    const player = pool[key];
    const full = normName(player && (player.name || key));
    if (full && (full === needle || full.split(' ').includes(needle))) {
      return (player && player.name) || key;
    }
  }
  return null;
}

/**
 * Enrich scan result buckets in place: attach `play.elo` for Tennis
 * Moneyline plays that resolve against the snapshot. Never throws.
 *
 * @param {Array} results - scan result buckets ({ league, market, plays })
 * @param {object} [opts]
 * @param {Function} [opts.loadSnapshot] - injectable loader (default real)
 * @returns {Array} the same results array (mutated in place)
 */
function enrichScanElo(results, opts) {
  if (!Array.isArray(results)) return results;
  const loadSnapshot = (opts && opts.loadSnapshot) || defaultLoadSnapshot;

  let snapshotResult = null;
  for (const bucket of results) {
    if (!bucket || String(bucket.league || '').toLowerCase() !== 'tennis') continue;
    const plays = Array.isArray(bucket.plays) ? bucket.plays : Array.isArray(bucket.candidates) ? bucket.candidates : [];
    for (const play of plays) {
      try {
        if (!play || !ML_RE.test(String(play.market || ''))) continue;
        // Never clobber elo the upstream path already attached (e.g. the
        // MCP server overlay or a pre-enriched candidate row).
        if (play.elo !== undefined && play.elo !== null) continue;
        // Lazy-load snapshot once, only when a tennis ML play needs it.
        if (snapshotResult === null) {
          snapshotResult = loadSnapshot();
        }
        if (!snapshotResult || !snapshotResult.available || !snapshotResult.snapshot) {
          play.elo = {
            available: false,
            coverage: 'snapshot_unavailable',
            reason: snapshotResult ? snapshotResult.reason || 'snapshot_unavailable' : 'snapshot_unavailable'
          };
          continue;
        }
        const { snapshot } = snapshotResult;

        const game = play.game || play.matchup || '';
        const parts = game.split(VS_RE);
        const pair = parts.length >= 2 ? parts : game.split(AT_RE);
        if (pair.length < 2 || !pair[0] || !pair[1]) {
          play.elo = { available: false, coverage: 'matchup_unparsed', reason: 'matchup_unparsed' };
          continue;
        }

        const pools = (snapshot.players && snapshot.players) || {};
        let tour = null;
        let pool = null;
        let k1 = null;
        let k2 = null;
        for (const t of ['atp', 'wta']) {
          const p = pools[t.toUpperCase()];
          if (!p) continue;
          const r1 = resolvePoolKey(p, pair[0].trim());
          const r2 = resolvePoolKey(p, pair[1].trim());
          if (r1 && r2) {
            tour = t;
            pool = p;
            k1 = r1;
            k2 = r2;
            break;
          }
        }

        if (!tour || !pool || !k1 || !k2) {
          const wtaEmpty = pools.WTA && Object.keys(pools.WTA).length === 0;
          play.elo = {
            available: false,
            coverage: wtaEmpty && !(pools.ATP && Object.keys(pools.ATP).length) ? 'no_snapshot_pool' : 'player_unresolved',
            reason: 'player_unresolved'
          };
          continue;
        }

        const marketProb = americanToProb(play.odds);
        if (marketProb === null) {
          play.elo = { available: false, coverage: 'odds_unparsed', reason: 'odds_unparsed' };
          continue;
        }

        const selectionName = matchSelectionSide(k1, k2, pool, play.selection);
        play.elo = getTennisEloContext({
          snapshot,
          tour,
          player1: (pool[k1] && pool[k1].name) || k1,
          player2: (pool[k2] && pool[k2].name) || k2,
          surface: null,
          selection: selectionName || null,
          marketFairProbability: marketProb
        });
      } catch (err) {
        // Never break the scan for elo enrichment.
        play.elo = {
          available: false,
          coverage: 'overlay_error',
          reason: err && err.message ? err.message : 'overlay_error'
        };
      }
    }
  }
  return results;
}

module.exports = { enrichScanElo, americanToProb, resolvePoolKey, matchSelectionSide };
