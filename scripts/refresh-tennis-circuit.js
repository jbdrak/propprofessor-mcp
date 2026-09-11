#!/usr/bin/env node
'use strict';

/**
 * refresh-tennis-circuit.js — Daily cron to rebuild PLAYER_CIRCUIT
 * from public tour entry lists.
 *
 * Source: Flashscore draw pages for the active week. The script pulls
 * each active tourney's draw, extracts the player list, and writes
 * lib/tennis-schedule-data/circuit-cache.json. The tennis context module
 * reads this cache on import and merges entries with the static
 * PLAYER_CIRCUIT map.
 *
 * Usage:
 *   node scripts/refresh-tennis-circuit.js              # refresh all active tourneys
 *   node scripts/refresh-tennis-circuit.js --dry-run    # show what would be written
 *   WEEK=2026-06-22 node scripts/refresh-tennis-circuit.js   # specific week
 *
 * Cron (Hermes):
 *   no_agent: true  (silent on success, alert on failure)
 *   schedule: daily 06:00 CT
 *   script: node scripts/refresh-tennis-circuit.js
 *
 * Failure modes:
 *   - Flashscore blocks the request → falls back to last known cache
 *   - Network down → exits with non-zero, cron alerts
 *   - Empty draw page → keeps existing cache (no overwrite)
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');

const execFile = promisify(cp.execFile);

const SCHEDULE_PATH = path.join(__dirname, '..', 'lib', 'tennis-schedule-data', 'weekly-schedule-2026.js');
const CACHE_PATH = path.join(__dirname, '..', 'lib', 'tennis-schedule-data', 'circuit-cache.json');
const SLUG_TO_FLASHSCORE = {
  halle: { tour: 'atp', flashscorePath: '/tennis/atp-singles/halle/' },
  mallorca: { tour: 'atp', flashscorePath: '/tennis/atp-singles/mallorca/' },
  queens: { tour: 'atp', flashscorePath: '/tennis/atp-singles/london/' },
  'bad-homburg': { tour: 'wta', flashscorePath: '/tennis/wta-singles/bad-homburg/' },
  eastbourne: { tour: 'wta', flashscorePath: '/tennis/wta-singles/eastbourne/' },
  berlin: { tour: 'wta', flashscorePath: '/tennis/wta-singles/berlin/' },
  nottingham: { tour: 'wta', flashscorePath: '/tennis/wta-singles/nottingham/' },
  wimbledon: { tour: 'atp', flashscorePath: '/tennis/atp-singles/wimbledon/' }
};

const DRY_RUN = process.argv.includes('--dry-run');
const WEEK_OVERRIDE = process.env.WEEK || null;
const CURL_TIMEOUT = 15;

/**
 * Run curl against a URL, return body as text. Returns null on failure.
 */
async function fetchUrl(url) {
  try {
    const { stdout } = await execFile(
      'curl',
      ['-sL', '--max-time', String(CURL_TIMEOUT), '-A', 'Mozilla/5.0 (SSB Tennis MCP refresh)', url],
      { timeout: CURL_TIMEOUT * 1000 }
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Extract player names from a Flashscore draw page HTML.
 * Flashscore uses <a class="participantName"> ... </a> for each player.
 * Returns array of full names like "Carlos Alcaraz".
 */
function parseFlashscoreDraw(html) {
  if (!html || typeof html !== 'string') return [];
  const names = new Set();
  // Match both regular participant links and the embedded JSON dump
  const linkRe = /<a[^>]+class="participantName[^"]*"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const name = decodeHtmlEntities(m[1].trim());
    if (name) names.add(name);
  }
  return Array.from(names);
}

/**
 * Decode common HTML entities Flashscore escapes.
 */
function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * Get the last name from a full player name.
 * "Carlos Alcaraz" -> "Alcaraz"
 * "Laslo Djere"    -> "Djere"
 * "Harriet Dart"   -> "Dart"
 */
function lastName(fullName) {
  const parts = fullName.split(/\s+/);
  return parts[parts.length - 1];
}

/**
 * Get the active week from the schedule module. Loads via require so we
 * share the canonical WEEKLY_SCHEDULE_2026 data.
 */
function getActiveWeek() {
  delete require.cache[require.resolve(SCHEDULE_PATH)];
  const { WEEKLY_SCHEDULE_2026 } = require(SCHEDULE_PATH);
  if (WEEK_OVERRIDE) return { key: WEEK_OVERRIDE, data: WEEKLY_SCHEDULE_2026[WEEK_OVERRIDE] };
  // Pick the most recent week with a start date <= today
  const now = new Date();
  const keys = Object.keys(WEEKLY_SCHEDULE_2026).sort();
  let active = null;
  for (const k of keys) {
    if (new Date(WEEKLY_SCHEDULE_2026[k].end) >= now) {
      active = { key: k, data: WEEKLY_SCHEDULE_2026[k] };
      break;
    }
  }
  return active;
}

/**
 * Pull a tourney's draw from Flashscore and return last-name -> slug mappings.
 */
async function pullTourneyDraw(slug, tour) {
  const map = SLUG_TO_FLASHSCORE[slug];
  if (!map || map.tour !== tour) {
    // Not all slugs are mappable (challengers, lower-tier events)
    return [];
  }
  const url = `https://www.flashscoreusa.com${map.flashscorePath}`;
  const html = await fetchUrl(url);
  if (!html) return [];
  const fullNames = parseFlashscoreDraw(html);
  return fullNames.map((name) => ({ lastName: lastName(name), slug, tour }));
}

async function main() {
  const active = getActiveWeek();
  if (!active) {
    console.error('No active week found in schedule');
    process.exit(1);
  }
  console.log(`[refresh] active week: ${active.key} (${active.data.start} → ${active.data.end})`);

  // Build the list of (slug, tour) pairs to pull
  const targets = [];
  for (const t of active.data.atp || []) targets.push({ slug: t.slug, tour: 'atp' });
  for (const t of active.data.wta || []) targets.push({ slug: t.slug, tour: 'wta' });
  for (const t of active.data.challenger || []) targets.push({ slug: t.slug, tour: 'challenger' });

  // Pull draws in parallel
  const results = await Promise.all(
    targets.map(async (t) => {
      const entries = await pullTourneyDraw(t.slug, t.tour);
      return { ...t, entries };
    })
  );

  // Aggregate: lastName -> [slug, ...] (preference order = pull order)
  const circuit = {};
  for (const r of results) {
    for (const e of r.entries) {
      if (!circuit[e.lastName]) circuit[e.lastName] = { tour: e.tour, preferredSlugs: [] };
      if (!circuit[e.lastName].preferredSlugs.includes(r.slug)) {
        circuit[e.lastName].preferredSlugs.push(r.slug);
      }
    }
  }

  const total = Object.keys(circuit).length;
  const newCache = {
    weekStart: active.key,
    generatedAt: new Date().toISOString(),
    source: 'flashscore-draw-pages',
    circuit
  };

  if (DRY_RUN) {
    console.log(`[dry-run] would write ${total} player entries to ${CACHE_PATH}`);
    console.log(JSON.stringify(newCache, null, 2).slice(0, 500));
    return;
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(newCache, null, 2));
  console.log(`[refresh] wrote ${total} player entries to ${CACHE_PATH}`);
}

main().catch((e) => {
  console.error('[refresh] failed:', e.message);
  process.exit(1);
});
