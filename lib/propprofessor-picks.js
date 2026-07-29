'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PICKS_DIR = path.join(require('node:os').homedir(), '.propprofessor');
const PICKS_FILE = process.env.PP_PICKS_FILE || path.join(PICKS_DIR, 'picks.json');
const CHECKPOINT_FILE = process.env.PP_CHECKPOINT_FILE || path.join(PICKS_DIR, 'alerts-checkpoint.json');

/**
 * Current on-disk schema version. Bump this when the pick shape changes in
 * a way that requires migration. `readPicks` accepts versions <= CURRENT
 * and will run any registered migration; missing/older versions are coerced
 * to v0 and warned about on stderr once per process.
 */
const CURRENT_PICKS_SCHEMA_VERSION = 1;

/**
 * Return the picks schema version of an existing on-disk file, or `null` if
 * the file is missing / unreadable. Exposed for tests and future migration
 * tooling.
 * @param {string} [filePath] - Override the picks file path (defaults to
 *   `PICKS_FILE`).
 * @returns {number|null} The version number, or null if not present.
 */
function getPicksSchemaVersion(filePath = PICKS_FILE) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.schemaVersion === 'number' && Number.isFinite(data.schemaVersion)) {
      return data.schemaVersion;
    }
    return 0; // legacy v0: no schemaVersion key
  } catch {
    return null;
  }
}

let warnedAboutLegacySchema = false;

/**
 * Read picks from disk. Returns empty array on first use or corrupt file.
 * Handles forward-compatible schema versions: v0 (no version key) and
 * any version <= CURRENT_PICKS_SCHEMA_VERSION are accepted. Future versions
 * (> CURRENT) trigger a stderr warning and an empty return — the file is
 * left untouched, so a downgrade can still read it.
 * @returns {Array<Object>}
 */
function readPicks() {
  try {
    const raw = fs.readFileSync(PICKS_FILE, 'utf8');
    const data = JSON.parse(raw);

    // Schema version handling. v0 = legacy file with no schemaVersion key.
    const version = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;
    if (version > CURRENT_PICKS_SCHEMA_VERSION && !warnedAboutLegacySchema) {
      process.stderr.write(
        `[propprofessor-picks] WARNING: picks.json was written by a newer version of the MCP server ` +
          `(schema v${version}); this build supports up to v${CURRENT_PICKS_SCHEMA_VERSION}. ` +
          `Returning empty list to avoid data loss — please upgrade or migrate the file manually.\n`
      );
      warnedAboutLegacySchema = true;
      return [];
    }
    if (version === 0 && !warnedAboutLegacySchema) {
      // One-time informational notice. v0 has the same shape as v1 today,
      // so this is informational only — no data loss.
      process.stderr.write(
        `[propprofessor-picks] INFO: picks.json has no schemaVersion — treating as v0. ` +
          `The file will be rewritten at v${CURRENT_PICKS_SCHEMA_VERSION} on the next write.\n`
      );
      warnedAboutLegacySchema = true;
    }

    return Array.isArray(data.picks) ? data.picks : [];
  } catch {
    return [];
  }
}

/**
 * Write picks to disk, creating directory if needed. The file is written
 * with the current schema version so future versions can detect the shape.
 * @param {Array<Object>} picks
 */
function writePicks(picks) {
  fs.mkdirSync(PICKS_DIR, { recursive: true });
  fs.writeFileSync(PICKS_FILE, JSON.stringify({ schemaVersion: CURRENT_PICKS_SCHEMA_VERSION, picks }, null, 2), 'utf8');
}

/**
 * @param {string} game
 * @param {string} league
 * @param {string} market
 * @param {string} selection
 * @param {number} odds
 * @param {Object} [options]
 * @param {number} [options.stake]
 * @param {string} [options.confidenceTier]
 * @param {string} [options.kaiCall]
 * @param {string} [options.rationale]
 * @param {string} [options.notes]
 * @returns {Object} The logged pick
 */
function logPick(
  game,
  league,
  market,
  selection,
  odds,
  options = /** @type {{ stake?: number, confidenceTier?: string, kaiCall?: string, rationale?: string, notes?: string, movementGrade?: string, movementLabel?: string }} */ ({})
) {
  if (!game || !league || !market || !selection) {
    throw new Error('game, league, market, and selection are required');
  }
  if (!Number.isFinite(odds)) {
    throw new Error('odds must be a finite number');
  }

  const picks = readPicks();
  const pick = {
    id: crypto.randomUUID(),
    loggedAt: new Date().toISOString(),
    game: String(game).trim(),
    league: String(league).trim(),
    market: String(market).trim(),
    selection: String(selection).trim(),
    odds: Number(odds),
    stake: Number.isFinite(options.stake) ? Number(options.stake) : null,
    confidenceTier: options.confidenceTier || null,
    kaiCall: options.kaiCall || null,
    // @ts-expect-error
    movementGrade: options.movementGrade || null,
    // @ts-expect-error
    movementLabel: options.movementLabel || null,
    rationale: options.rationale || null,
    status: 'pending',
    resolvedAt: null,
    notes: options.notes || null
  };
  picks.push(pick);
  writePicks(picks);
  return { ok: true, pick };
}

/**
 * Get pick history with optional filters.
 * @param {Object} [filters]
 * @param {string} [filters.status] - 'pending', 'won', 'lost', 'push', or 'all'
 * @param {string} [filters.league] - Filter by league
 * @param {number} [filters.days] - Only picks from last N days
 * @param {number} [filters.limit] - Max results
 * @returns {Object} { picks, total, filtered }
 */
function getPickHistory(filters = {}) {
  let picks = readPicks();

  // Sort most recent first
  picks.sort((a, b) => new Date(b.loggedAt).getTime() - new Date(a.loggedAt).getTime());

  const status = String(filters.status || '').toLowerCase();
  if (status && status !== 'all') {
    picks = picks.filter((p) => p.status === status);
  }
  if (filters.league) {
    const league = String(filters.league).trim().toLowerCase();
    picks = picks.filter((p) => String(p.league).toLowerCase() === league);
  }
  if (filters.days) {
    const cutoff = Date.now() - Number(filters.days) * 86400000;
    picks = picks.filter((p) => new Date(p.loggedAt).getTime() >= cutoff);
  }

  const total = picks.length;
  const limit = Number.isFinite(Number(filters.limit)) ? Number(filters.limit) : 50;
  const result = picks.slice(0, limit);

  return { ok: true, picks: result, total, returned: result.length };
}

/**
 * Resolve a pick (mark as won/lost/push).
 * @param {string} id - Pick UUID
 * @param {'won'|'lost'|'push'} result - Outcome
 * @returns {Object}
 */
function resolvePick(id, result) {
  if (!id) throw new Error('pick id is required');
  if (!['won', 'lost', 'push'].includes(result)) {
    throw new Error('result must be "won", "lost", or "push"');
  }

  const picks = readPicks();
  const idx = picks.findIndex((p) => p.id === id);
  if (idx === -1) {
    return { ok: false, error: `Pick not found: ${id}` };
  }

  picks[idx].status = result;
  picks[idx].resolvedAt = new Date().toISOString();
  writePicks(picks);

  // Feed into signal calibration
  try {
    const { recordResolution } = require('./propprofessor-signal-calibration');
    recordResolution(picks[idx]);
  } catch {
    // calibration is best-effort — never block pick resolution on it
  }

  return { ok: true, pick: picks[idx] };
}

/**
 * Get pick statistics: win rate, profit/loss, breakdown by league and tier.
 * @param {Object} [filters]
 * @param {number} [filters.days] - Only picks from last N days
 * @returns {Object} Stats object
 */
function getPickStats(filters = {}) {
  let picks = readPicks();

  if (filters.days) {
    const cutoff = Date.now() - Number(filters.days) * 86400000;
    picks = picks.filter((p) => new Date(p.loggedAt).getTime() >= cutoff);
  }

  const total = picks.length;
  const pending = picks.filter((p) => p.status === 'pending').length;
  const resolved = picks.filter((p) => p.status !== 'pending');
  const wins = resolved.filter((p) => p.status === 'won').length;
  const losses = resolved.filter((p) => p.status === 'lost').length;
  const pushes = resolved.filter((p) => p.status === 'push').length;
  const decidable = wins + losses;
  const winRate = decidable > 0 ? ((wins / decidable) * 100).toFixed(1) : null;

  // Profit/loss
  const profit = resolved.reduce((sum, p) => {
    if (!Number.isFinite(p.stake)) return sum;
    if (p.status === 'won') {
      // American odds to profit: if positive odds, profit = stake * odds/100
      // if negative odds, profit = stake * 100/|odds|
      const odds = p.odds;
      const stake = p.stake;
      if (odds > 0) return sum + stake * (odds / 100);
      return sum + stake * (100 / Math.abs(odds));
    }
    if (p.status === 'lost') return sum - p.stake;
    return sum; // push = no profit/loss
  }, 0);

  // By league
  const byLeague = {};
  for (const pick of resolved) {
    const league = pick.league || 'Unknown';
    if (!byLeague[league]) byLeague[league] = { wins: 0, losses: 0, pushes: 0, picks: 0 };
    byLeague[league].picks++;
    if (pick.status === 'won') byLeague[league].wins++;
    else if (pick.status === 'lost') byLeague[league].losses++;
    else byLeague[league].pushes++;
  }
  for (const stats of Object.values(byLeague)) {
    const dec = stats.wins + stats.losses;
    stats.winRate = dec > 0 ? ((stats.wins / dec) * 100).toFixed(1) + '%' : null;
  }

  // By tier
  const byTier = {};
  for (const pick of resolved) {
    const tier = pick.confidenceTier || 'Unranked';
    if (!byTier[tier]) byTier[tier] = { wins: 0, losses: 0, pushes: 0, picks: 0, profit: 0, totalStake: 0 };
    byTier[tier].picks++;
    if (pick.status === 'won') byTier[tier].wins++;
    else if (pick.status === 'lost') byTier[tier].losses++;
    else byTier[tier].pushes++;
    // Per-tier P&L
    if (Number.isFinite(pick.stake)) {
      byTier[tier].totalStake += pick.stake;
      if (pick.status === 'won') {
        const odds = pick.odds;
        if (odds > 0) byTier[tier].profit += pick.stake * (odds / 100);
        else byTier[tier].profit += pick.stake * (100 / Math.abs(odds));
      } else if (pick.status === 'lost') {
        byTier[tier].profit -= pick.stake;
      }
    }
  }
  for (const stats of Object.values(byTier)) {
    const dec = stats.wins + stats.losses;
    stats.winRate = dec > 0 ? ((stats.wins / dec) * 100).toFixed(1) + '%' : null;
    stats.profit = Math.round(stats.profit * 100) / 100;
    stats.roi = stats.totalStake > 0 ? ((stats.profit / stats.totalStake) * 100).toFixed(1) + '%' : null;
  }

  return {
    ok: true,
    stats: {
      total,
      pending,
      resolved: resolved.length,
      wins,
      losses,
      pushes,
      winRate: winRate ? winRate + '%' : null,
      profit: Math.round(profit * 100) / 100,
      byLeague,
      byTier
    }
  };
}

/**
 * Summarize settled-pick performance for honest context in the daily briefing.
 * Reuses getPickStats but reports the sample size and an explicit note so
 * agents never imply ROI from an empty or tiny sample.
 * @param {Object} [filters]
 * @param {number} [filters.days] - Only picks from last N days
 * @returns {Object} { ok, sampleSize, settled, byTier, note }
 */
function getBacktestSummary(filters = {}) {
  const { stats } = getPickStats(filters);
  if (!stats) return { ok: false, stats: null };
  return {
    ok: true,
    sampleSize: stats.total,
    settled: stats.resolved,
    byTier: stats.byTier,
    note:
      stats.total === 0
        ? 'No settled picks yet — thresholds are heuristic, not backtest-derived.'
        : 'Reflects settled picks only.'
  };
}

/**
 * Read the alerts checkpoint.
 * @returns {{ lastCheckedAt: string|null, leagues: Object.<string,string> }}
 */
function readCheckpoint() {
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
  } catch {
    return { lastCheckedAt: null, leagues: {} };
  }
}

/**
 * Save the alerts checkpoint.
 * @param {{ lastCheckedAt: string, leagues: Object.<string,string> }} checkpoint
 */
function writeCheckpoint(checkpoint) {
  fs.mkdirSync(PICKS_DIR, { recursive: true });
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2), 'utf8');
}

module.exports = {
  CURRENT_PICKS_SCHEMA_VERSION,
  getPickHistory,
  getPickStats,
  getBacktestSummary,
  getPicksSchemaVersion,
  logPick,
  readCheckpoint,
  resolvePick,
  writeCheckpoint
};
