'use strict';

/**
 * Signal calibration — tracks which pre-game signals actually predict outcomes.
 *
 * Every resolved bet feeds into a per-signal hit-rate tracker under
 * ~/.propprofessor/signal-calibration.json. Aggregate enough data and you
 * know which tiers/movement grades/leagues actually win.
 *
 * Key format: `${tier}:${movementGrade}:${league}:${market}`
 * Each key has: { wins, losses, pushes, lastUpdated }
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CALIBRATION_FILE =
  process.env.PP_SIGNAL_CALIBRATION_FILE || path.join(os.homedir(), '.propprofessor', 'signal-calibration.json');

function load() {
  try {
    const raw = fs.readFileSync(CALIBRATION_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(CALIBRATION_FILE), { recursive: true });
  fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Record a resolved pick outcome against its pre-game signals.
 * @param {Object} pick - The resolved pick
 * @param {'won'|'lost'|'push'} pick.status - Outcome
 * @param {string} [pick.confidenceTier] - e.g. 'TIER 1'
 * @param {string} [pick.movementGrade] - e.g. 'green', 'yellow', 'red'
 * @param {string} [pick.league] - e.g. 'NBA'
 * @param {string} [pick.market] - e.g. 'Moneyline'
 */
// @ts-expect-error
function recordResolution(pick = {}) {
  const data = load();

  const key = [
    pick.confidenceTier || 'TIER 4',
    pick.movementGrade || 'unknown',
    pick.league || '?',
    pick.market || '?'
  ].join(':');

  if (!data[key]) {
    data[key] = { wins: 0, losses: 0, pushes: 0, lastUpdated: new Date().toISOString() };
  }

  if (pick.status === 'won') data[key].wins++;
  else if (pick.status === 'lost') data[key].losses++;
  else if (pick.status === 'push') data[key].pushes++;

  data[key].lastUpdated = new Date().toISOString();
  save(data);
}

/**
 * Get current calibration summary.
 * @returns {Object<string, { wins: number, losses: number, pushes: number, total: number, hitRate: string }>}
 */
function getCalibration() {
  const data = load();
  const summary = {};
  for (const [key, counts] of Object.entries(data)) {
    const total = (counts.wins || 0) + (counts.losses || 0);
    summary[key] = {
      ...counts,
      total,
      hitRate: total > 0 ? ((counts.wins / total) * 100).toFixed(1) : 'N/A'
    };
  }
  // @ts-expect-error
  return summary;
}

module.exports = { recordResolution, getCalibration, load, save };
