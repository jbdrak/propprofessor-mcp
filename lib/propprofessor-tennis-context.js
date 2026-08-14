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
// Tennis Elo shadow context (Moneyline only)
// ---------------------------------------------------------------------------
// Lazy-loaded defaults — no I/O at module load time. The snapshot is read
// only when a Tennis Moneyline context call actually happens.

/**
 * Lazy default: load snapshot from tennis-elo-data (local file, safe unavailable).
 * Memoized by path+mtime so repeated Tennis Moneyline context calls never
 * re-read and re-parse a (potentially MB-scale) snapshot synchronously.
 */
const _snapshotMemo = new Map(); // path -> { mtimeMs, size, result }
function defaultLoadSnapshot(pathOverride) {
  const { loadSnapshot } = require('./tennis-elo-data');
  const snapshotPath = pathOverride || process.env.PP_TENNIS_ELO_SNAPSHOT || '';
  try {
    const { statSync } = require('node:fs');
    const stat = statSync(snapshotPath);
    const memoKey = snapshotPath || '<default>';
    const memo = _snapshotMemo.get(memoKey);
    if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.result;
    const result = loadSnapshot(pathOverride);
    _snapshotMemo.set(memoKey, { mtimeMs: stat.mtimeMs, size: stat.size, result });
    return result;
  } catch {
    // Missing/inaccessible path (or the default homedir path) — fall through
    // to the safe loadSnapshot which returns a not_found result without throwing.
    return loadSnapshot(pathOverride);
  }
}

/** Lazy default: resolve a player via tennis-elo-data exact resolver. */
function defaultResolvePlayer(snapshot, options) {
  const { resolvePlayer } = require('./tennis-elo-data');
  return resolvePlayer(snapshot, options);
}

/**
 * Adapter for predictMatch that handles both engine-format snapshots
 * (from buildRatings: {matches, pools, config, modelVersion}) and
 * data-format snapshots (from loadSnapshot: {players, aliasIndex, manifest}).
 */
function defaultPredictMatch(snapshot, args) {
  // Engine-format: has matches array and pools → use real predictMatch
  if (Array.isArray(snapshot.matches) && snapshot.pools && typeof snapshot.modelVersion === 'string') {
    const { predictMatch } = require('./tennis-elo');
    return predictMatch(snapshot, args);
  }
  // Data-format: compute from final ratings using engine blend rules
  return predictFromDataSnapshot(snapshot, args);
}

/**
 * Compute prediction from a data-format snapshot's final player ratings.
 * Uses the same blend rules as the engine (surfaceWeight 0.5 default,
 * minSurfaceMatches 5 default) but operates on persisted final ratings
 * instead of replaying match history. This is honest: the data snapshot
 * only contains matches up to manifest.asOf, so there is no future
 * leakage.
 */
function predictFromDataSnapshot(snapshot, args) {
  const {
    expectedScore,
    normalizeSurface,
    DEFAULT_SURFACE_WEIGHT,
    DEFAULT_MIN_SURFACE_MATCHES
  } = require('./tennis-elo');

  const tour = typeof args.tour === 'string' ? args.tour.trim().toLowerCase() : null;
  const surface = normalizeSurface(args.surface);
  const asOf = args.asOf || null;
  const modelVersion = snapshot.modelVersion || null;

  const base = {
    available: false,
    reason: null,
    tour: tour || null,
    surface,
    asOf,
    modelVersion,
    blend: { used: false, surfaceWeight: DEFAULT_SURFACE_WEIGHT, minSurfaceMatches: DEFAULT_MIN_SURFACE_MATCHES },
    players: null,
    probability: null,
    expectedScore: null,
    matchCounts: { player1: 0, player2: 0 },
    lastMatchDate: { player1: null, player2: null }
  };

  if (!tour || (tour !== 'atp' && tour !== 'wta')) return { ...base, reason: 'missing_tour' };

  const tourKey = tour.toUpperCase();
  const pool = snapshot.players && snapshot.players[tourKey];
  if (!pool) return { ...base, reason: 'unknown_tour' };

  const p1Id = args.player1;
  const p2Id = args.player2;
  if (!p1Id || !p2Id) return { ...base, reason: 'missing_players' };
  if (p1Id === p2Id) return { ...base, reason: 'same_player' };

  const p1 = pool[p1Id];
  const p2 = pool[p2Id];
  if (!p1) {
    return {
      ...base,
      reason: 'player1_unseen',
      matchCounts: { player1: 0, player2: p2 ? p2.totalMatches || 0 : 0 },
      lastMatchDate: { player1: null, player2: p2 ? p2.lastMatchDate || null : null }
    };
  }
  if (!p2) {
    return {
      ...base,
      reason: 'player2_unseen',
      matchCounts: { player1: p1.totalMatches || 0, player2: 0 },
      lastMatchDate: { player1: p1.lastMatchDate || null, player2: null }
    };
  }

  // As-of boundary: reject if decision time is before snapshot cutoff
  if (asOf && snapshot.manifest && snapshot.manifest.asOf) {
    const asOfNorm = String(asOf).trim();
    const cutoff = String(snapshot.manifest.asOf).trim();
    if (asOfNorm < cutoff) {
      return { ...base, reason: 'asof_before_snapshot' };
    }
  }

  // Blend config from snapshot engine constants or engine defaults (single source)
  const ec = snapshot.engine && snapshot.engine.constants;
  const surfaceWeight = ec && typeof ec.surfaceWeight === 'number' ? ec.surfaceWeight : DEFAULT_SURFACE_WEIGHT;
  const minSurfaceMatches =
    ec && Number.isInteger(ec.minSurfaceMatches) ? ec.minSurfaceMatches : DEFAULT_MIN_SURFACE_MATCHES;

  const p1Surf = p1.surfaces && surface ? p1.surfaces[surface] : null;
  const p2Surf = p2.surfaces && surface ? p2.surfaces[surface] : null;
  const blendUsed =
    surface !== null && p1Surf && p1Surf.matches >= minSurfaceMatches && p2Surf && p2Surf.matches >= minSurfaceMatches;

  const effective1 = blendUsed
    ? p1.overall + surfaceWeight * ((p1Surf ? p1Surf.rating : p1.overall) - p1.overall)
    : p1.overall;
  const effective2 = blendUsed
    ? p2.overall + surfaceWeight * ((p2Surf ? p2Surf.rating : p2.overall) - p2.overall)
    : p2.overall;

  const prob1 = expectedScore(effective1, effective2);
  const prob2 = 1 - prob1;

  return {
    ...base,
    available: true,
    reason: null,
    tour,
    asOf: asOf || (snapshot.manifest && snapshot.manifest.asOf) || null,
    blend: { used: !!blendUsed, surfaceWeight, minSurfaceMatches },
    players: {
      player1: {
        name: p1.name || p1Id,
        overall: p1.overall,
        surface: surface !== null && p1Surf ? p1Surf.rating : null,
        surfaceMatches: surface !== null && p1Surf ? p1Surf.matches : null,
        effective: effective1,
        blended: !!blendUsed,
        matchCount: p1.totalMatches || 0,
        lastMatchDate: p1.lastMatchDate || null
      },
      player2: {
        name: p2.name || p2Id,
        overall: p2.overall,
        surface: surface !== null && p2Surf ? p2Surf.rating : null,
        surfaceMatches: surface !== null && p2Surf ? p2Surf.matches : null,
        effective: effective2,
        blended: !!blendUsed,
        matchCount: p2.totalMatches || 0,
        lastMatchDate: p2.lastMatchDate || null
      }
    },
    probability: { player1: prob1, player2: prob2 },
    expectedScore: { player1: prob1, player2: prob2 },
    matchCounts: { player1: p1.totalMatches || 0, player2: p2.totalMatches || 0 },
    lastMatchDate: { player1: p1.lastMatchDate || null, player2: p2.lastMatchDate || null }
  };
}

/**
 * Map context surface (from guessSurfaceFromTournament / schedule) to
 * the engine's normalized surface key ('hard'|'clay'|'grass'|null).
 */
function contextSurfaceToEloSurface(surface) {
  if (!surface || surface === 'unknown') return null;
  const { normalizeSurface } = require('./tennis-elo');
  return normalizeSurface(surface);
}

/** Normalize a market string to a canonical lowercase form for gating. */
function normalizeMarket(market) {
  if (!market || typeof market !== 'string') return null;
  return market
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

/**
 * Pure helper: produce Tennis Elo context for Moneyline.
 *
 * Accepts explicit snapshot/load/resolve/predict dependencies so tests can
 * inject a buildRatings() output and the real predictMatch without any I/O.
 *
 * Runtime defaults:
 *   loadSnapshot  — tennis-elo-data local file reader (safe unavailable on missing file)
 *   resolvePlayer — tennis-elo-data exact player resolver
 *   predictMatch  — adapter that handles both engine and data snapshot formats
 *
 * @param {Object} opts
 * @param {string} opts.tour - 'atp' | 'wta' (required)
 * @param {string} opts.player1 - Player name (will be resolved)
 * @param {string} opts.player2 - Player name (will be resolved)
 * @param {string|null} opts.surface - 'hard'|'clay'|'grass'|null
 * @param {string|null} [opts.asOf] - ISO datetime decision boundary
 * @param {string|null} [opts.selection] - Exact selection for selectedProbability
 * @param {number|null} [opts.marketFairProbability] - Explicit fair prob 0..1
 * @param {Object} [opts.snapshot] - Pre-loaded snapshot (engine or data format)
 * @param {Function} [opts.loadSnapshot] - () => { available, snapshot }
 * @param {Function} [opts.resolvePlayer] - (snapshot, {tour, name}) => resolve result
 * @param {Function} [opts.predictMatch] - (snapshot, args) => prediction
 * @param {number} [opts.now] - Injected timestamp (default Date.now())
 * @returns {Object} Elo context object
 */
function getTennisEloContext(opts) {
  if (!opts || typeof opts !== 'object') {
    return { available: false, coverage: 'missing_opts', reason: 'missing_opts' };
  }
  const {
    tour,
    player1,
    player2,
    surface,
    asOf,
    selection,
    marketFairProbability,
    snapshot: injectedSnapshot,
    loadSnapshot: injectLoadSnapshot,
    resolvePlayer: injectResolvePlayer,
    predictMatch: injectPredictMatch,
    now
  } = opts;

  const ts = typeof now === 'number' ? now : Date.now();

  // Resolve snapshot
  let loadSnapshotFn = injectLoadSnapshot || defaultLoadSnapshot;
  let snapshotResult;
  if (injectedSnapshot && typeof injectedSnapshot === 'object') {
    // Caller provided a pre-loaded snapshot directly
    snapshotResult = { available: true, snapshot: injectedSnapshot, path: null };
  } else {
    try {
      snapshotResult = loadSnapshotFn();
    } catch {
      return { available: false, coverage: 'snapshot_load_error', reason: 'snapshot_load_error' };
    }
  }

  if (!snapshotResult || !snapshotResult.available) {
    return {
      available: false,
      coverage: 'snapshot_unavailable',
      reason: snapshotResult ? snapshotResult.reason || 'snapshot_unavailable' : 'snapshot_unavailable'
    };
  }

  const snapshot = snapshotResult.snapshot;

  // Tour
  const eloTour = tour && typeof tour === 'string' ? tour.trim().toLowerCase() : null;
  if (!eloTour || (eloTour !== 'atp' && eloTour !== 'wta')) {
    return { available: false, coverage: 'tour_unknown', reason: 'tour_unknown', tour: eloTour || null };
  }

  // Surface for engine
  const eloSurface = contextSurfaceToEloSurface(surface);

  // Resolve players
  const resolveFn = injectResolvePlayer || defaultResolvePlayer;
  let resolved1;
  let resolved2;
  try {
    resolved1 = resolveFn(snapshot, { tour: eloTour, name: player1 });
  } catch {
    resolved1 = { available: false, reason: 'resolve_error' };
  }
  try {
    resolved2 = resolveFn(snapshot, { tour: eloTour, name: player2 });
  } catch {
    resolved2 = { available: false, reason: 'resolve_error' };
  }

  if (!resolved1 || !resolved1.available || !resolved2 || !resolved2.available) {
    const reason1 = !resolved1 ? 'missing' : resolved1.available ? 'ok' : resolved1.reason;
    const reason2 = !resolved2 ? 'missing' : resolved2.available ? 'ok' : resolved2.reason;
    const combined = !resolved1 || !resolved1.available ? `player1_${reason1}` : `player2_${reason2}`;
    return {
      available: false,
      coverage: 'player_unresolved',
      reason: combined,
      tour: eloTour,
      surface: eloSurface || null,
      player1:
        resolved1 && resolved1.available
          ? { name: resolved1.name || player1, id: resolved1.id, matchedBy: resolved1.matchedBy }
          : { resolved: false, reason: reason1 },
      player2:
        resolved2 && resolved2.available
          ? { name: resolved2.name || player2, id: resolved2.id, matchedBy: resolved2.matchedBy }
          : { resolved: false, reason: reason2 }
    };
  }

  // Predict
  const predictFn = injectPredictMatch || defaultPredictMatch;
  let prediction;
  try {
    prediction = predictFn(snapshot, {
      tour: eloTour,
      player1: resolved1.id,
      player2: resolved2.id,
      surface: eloSurface || undefined,
      asOf: asOf || undefined
    });
  } catch (err) {
    return {
      available: false,
      coverage: 'predict_error',
      reason: err && err.message ? err.message : 'predict_error',
      tour: eloTour,
      surface: eloSurface || null,
      player1: { name: resolved1.name || player1, id: resolved1.id, matchedBy: resolved1.matchedBy },
      player2: { name: resolved2.name || player2, id: resolved2.id, matchedBy: resolved2.matchedBy }
    };
  }

  if (!prediction || !prediction.available) {
    return {
      available: false,
      coverage: prediction ? prediction.reason || 'predict_unavailable' : 'predict_unavailable',
      reason: prediction ? prediction.reason || 'predict_unavailable' : 'predict_unavailable',
      tour: eloTour,
      surface: eloSurface || null,
      player1: { name: resolved1.name || player1, id: resolved1.id, matchedBy: resolved1.matchedBy },
      player2: { name: resolved2.name || player2, id: resolved2.id, matchedBy: resolved2.matchedBy },
      matchCounts: prediction ? prediction.matchCounts : { player1: 0, player2: 0 },
      lastMatchDate: prediction ? prediction.lastMatchDate : { player1: null, player2: null }
    };
  }

  // Snapshot provenance
  const manifest = snapshot.manifest || {};
  const manifestAsOf = manifest.asOf || null;
  const importedAtMs = manifest.importedAt ? new Date(manifest.importedAt).getTime() : NaN;
  const ageDays = manifestAsOf && Number.isFinite(importedAtMs) ? Math.round((ts - importedAtMs) / 86400000) : null;

  // Selected probability: exact match of selection against resolved player names
  let selectedProbability = null;
  if (selection && typeof selection === 'string' && prediction.players) {
    const normSelection = selection.trim();
    const p1Name = prediction.players.player1 && prediction.players.player1.name;
    const p2Name = prediction.players.player2 && prediction.players.player2.name;
    if (p1Name && normSelection === p1Name) {
      selectedProbability = prediction.probability.player1;
    } else if (p2Name && normSelection === p2Name) {
      selectedProbability = prediction.probability.player2;
    }
  }

  // Market fair probability and disagreement (only if explicit)
  const mfp =
    typeof marketFairProbability === 'number' &&
    Number.isFinite(marketFairProbability) &&
    marketFairProbability >= 0 &&
    marketFairProbability <= 1
      ? marketFairProbability
      : null;
  const disagreement =
    mfp !== null && selectedProbability !== null ? Math.round((selectedProbability - mfp) * 10000) / 10000 : null;

  return {
    available: true,
    coverage: 'full',
    reason: null,
    tour: eloTour,
    surface: eloSurface || null,
    player1: { name: prediction.players.player1.name, id: resolved1.id, matchedBy: resolved1.matchedBy },
    player2: { name: prediction.players.player2.name, id: resolved2.id, matchedBy: resolved2.matchedBy },
    ratings: {
      player1: {
        overall: prediction.players.player1.overall,
        surface: prediction.players.player1.surface,
        surfaceMatches: prediction.players.player1.surfaceMatches,
        effective: prediction.players.player1.effective,
        blended: prediction.players.player1.blended
      },
      player2: {
        overall: prediction.players.player2.overall,
        surface: prediction.players.player2.surface,
        surfaceMatches: prediction.players.player2.surfaceMatches,
        effective: prediction.players.player2.effective,
        blended: prediction.players.player2.blended
      }
    },
    probabilities: { player1: prediction.probability.player1, player2: prediction.probability.player2 },
    selectedProbability,
    matchCounts: prediction.matchCounts,
    lastMatchDate: prediction.lastMatchDate,
    asOf: prediction.asOf || asOf || null,
    modelVersion: prediction.modelVersion,
    blend: prediction.blend,
    snapshot: {
      asOf: manifestAsOf,
      importedAt: manifest.importedAt || null,
      sourceUrl: manifest.sourceUrl || null,
      license: manifest.license || null,
      sha256: manifest.sha256 || null,
      matchCount: manifest.matchCount != null ? manifest.matchCount : null,
      playerCount: manifest.playerCount != null ? manifest.playerCount : null,
      sourcePath: manifest.sourcePath || null,
      freshness: { ageDays, stale: ageDays !== null ? ageDays > 14 : null }
    },
    marketFairProbability: mfp,
    disagreement
  };
}

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
  {
    pattern: /\b(?:Canada(?:ian)?\s*Open|Rogers\s*Cup|National\s*Bank|Toronto|Montreal)\b/i,
    surface: 'Hardcourt'
  },
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

const MATCHUP_SEPARATOR = /\s+(?:vs|@|at)\s+/i;

/**
 * Heuristic: does this string look like a matchup rather than a
 * tournament name?
 * @param {string} s
 * @returns {boolean}
 */
function looksLikeMatchup(s) {
  if (!s || typeof s !== 'string') return false;
  if (!MATCHUP_SEPARATOR.test(s)) return false;
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
 * Resolve a matchup to a real tournament.
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
 * Get tennis context for a match: surface, level, optional matchup news count,
 * and Tennis Moneyline Elo shadow context.
 *
 * @param {Object} opts
 * @param {string} [opts.player1] - Name of the first player.
 * @param {string} [opts.player2] - Name of the second player.
 * @param {string} [opts.tournament] - Tournament name (used for surface/level detection).
 * @param {string} [opts.surface] - Explicit surface override (skips tournament guessing).
 * @param {string} [opts.start] - Game start ISO timestamp (used for matchup resolution and Elo asOf).
 * @param {string} [opts.market] - Market type. 'Moneyline' triggers Elo context. Absent → market_unknown.
 * @param {string} [opts.tour] - 'atp' | 'wta' explicit tour override for Elo.
 * @param {string} [opts.selection] - Exact selection name for Elo selectedProbability.
 * @param {number} [opts.marketFairProbability] - Explicit market fair probability (0..1) for Elo disagreement.
 * @param {Object} [opts.eloDeps] - Injected Elo dependencies { snapshot, loadSnapshot, resolvePlayer, predictMatch }.
 * @returns {Promise<Object>}
 */
async function getTennisContext(opts = {}) {
  const {
    player1,
    player2,
    tournament: rawTournament,
    surface: explicitSurface,
    start,
    market: rawMarket,
    tour: explicitTour,
    eloDeps,
    selection,
    marketFairProbability
  } = opts;

  let correctedStart = start;

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
      const fb = await searchTournamentFallback(player1, player2, correctedStart);
      if (fb.surface || fb.level) {
        resolvedSurface = fb.surface;
        resolvedLevel = fb.level;
      }
    }
  }

  let surface = explicitSurface || resolvedSurface || (tournament ? guessSurfaceFromTournament(tournament) : null);
  const level = resolvedLevel || (tournament ? guessMatchLevel(tournament) : null);

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

  let matchupNewsCount = 0;
  let matchupArticles = false;

  if (player1 && player2) {
    const articles = await fetchMatchupNews(player1, player2);
    matchupNewsCount = articles.length;
    matchupArticles = matchupNewsCount > 0;
  }

  // --- Tennis Elo shadow context (Moneyline only) ---
  // Gate: only Moneyline triggers Elo load/prediction. Callers without
  // market get a safe 'market_unknown' unavailable; non-ML markets get
  // 'unsupported_market'. No I/O unless Moneyline is confirmed.
  let elo = { available: false, coverage: 'unsupported_market', reason: null };
  const normalizedMarket = normalizeMarket(rawMarket);
  const isMoneyline =
    normalizedMarket === 'moneyline' || normalizedMarket === 'money line' || normalizedMarket === 'ml';

  if (isMoneyline) {
    // Derive tour for Elo from explicit override, matchup resolution, or level inference
    let eloTour = explicitTour || resolvedTour;
    if (!eloTour && level) {
      if (/\bATP\b/i.test(level)) eloTour = 'atp';
      else if (/\bWTA\b/i.test(level)) eloTour = 'wta';
    }

    if (!eloTour) {
      elo = { available: false, coverage: 'tour_unknown', reason: 'tour_unknown' };
    } else {
      elo = getTennisEloContext({
        snapshot: eloDeps && eloDeps.snapshot,
        loadSnapshot: eloDeps && eloDeps.loadSnapshot,
        resolvePlayer: eloDeps && eloDeps.resolvePlayer,
        predictMatch: eloDeps && eloDeps.predictMatch,
        tour: eloTour,
        player1,
        player2,
        surface: surface !== 'unknown' ? surface : null,
        asOf: start || null,
        selection: selection || null,
        marketFairProbability: marketFairProbability != null ? marketFairProbability : null
      });
    }
  } else if (normalizedMarket === null) {
    // No market provided — conservatively unavailable (never assume ML)
    elo = { available: false, coverage: 'market_unknown', reason: null };
  }
  // else: unsupported_market (default from top)

  const eloAvailable = elo.available === true;

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
      resolvedFromMatchup,
      eloAvailable
    },
    tournament: resolvedFromMatchup ? tournament : null,
    city: resolvedCity,
    tour: resolvedTour,
    cached: false,
    fetchedAt: new Date().toISOString(),
    elo
  };
}

module.exports = {
  getTennisContext,
  getTennisEloContext,
  contextSurfaceToEloSurface,
  normalizeMarket,
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
