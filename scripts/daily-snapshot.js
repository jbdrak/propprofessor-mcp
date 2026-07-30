#!/usr/bin/env node
'use strict';

/**
 * Daily snapshot pipeline for REAL backtest metrics.
 *
 * Captures the current recommended plays (from handlers.quick_screen with
 * mode='recommended') into a JSONL ledger at data/snapshots.jsonl — one
 * JSON object per line. Each line is a stable, idempotent record of a single
 * play at capture time: gameId, selection, market, league, book, odds, tier,
 * kaiCall, screenScore, timestamp (ISO), and a stable playId (sha256 of
 * gameId+selection+market+book, truncated).
 *
 * Idempotency: plays already snapshotted for the *current UTC day* are skipped
 * (a playId present in today's lines is not re-appended). Re-running the
 * script within the same UTC day does not duplicate rows.
 *
 * Mock-friendly: the play source is injectable via `getPlays`, so the script
 * is fully testable without network access or a live API client. When no
 * `getPlays` is supplied, the default provider calls the real MCP handlers
 * (recommended_bets) through a live PropProfessor client.
 *
 * Usage (CLI):
 *   node scripts/daily-snapshot.js                 # default provider, data/snapshots.jsonl
 *   node scripts/daily-snapshot.js --out /tmp/x.jsonl --leagues NBA,MLB
 *
 * Library:
 *   const { takeDailySnapshot } = require('./daily-snapshot');
 *   await takeDailySnapshot({ getPlays: async () => [...plays], outFile });
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshots.jsonl');

/**
 * Stable play identity: sha256 of gameId+selection+market+book (each trimmed).
 * @returns {string} 16-char hex id
 */
function buildPlayId({ gameId, selection, market, book } = {}) {
  const raw = [gameId, selection, market, book].map((v) => String(v == null ? '' : v).trim()).join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** UTC calendar day (YYYY-MM-DD) for an ISO timestamp. */
function utcDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Normalize a candidate play (from quick_screen / recommended_bets) into the
 * snapshot record shape.
 * @param {Object} play - candidate row
 * @param {Object} [ctx] - { league } fallback league
 */
function normalizePlay(play = {}, ctx = {}) {
  const gameId = play.gameId || null;
  const selection = play.selection || play.participant || play.pick || null;
  const market = play.market || 'Moneyline';
  const book = play.book || null;
  const playId = play.playId ? String(play.playId) : buildPlayId({ gameId, selection, market, book });
  return {
    playId,
    gameId,
    selection,
    market,
    league: play.league || ctx.league || null,
    book,
    odds: play.odds == null ? null : Number(play.odds),
    tier: play.confidenceTier || play.finalConfidenceTier || null,
    kaiCall: play.kaiCall || play.finalVerdict || null,
    screenScore: play.screenScore == null ? null : Number(play.screenScore),
    timestamp: new Date().toISOString()
  };
}

/**
 * Flatten a recommended_bets / quick_screen handler result into an array of
 * normalized plays.
 */
function playsFromHandlerResult(result, { source } = {}) {
  const plays = [];
  if (!result || result.ok === false) return plays;
  if (source === 'quick_screen') {
    // quick_screen returns { results: [{ league, market, candidates: [...] }] }
    for (const entry of Array.isArray(result.results) ? result.results : []) {
      for (const p of Array.isArray(entry.candidates) ? entry.candidates : []) {
        plays.push(normalizePlay(p, { league: entry.league }));
      }
    }
    return plays;
  }
  // recommended_bets shape: { leagues: [{ league, plays: [...] }] }
  for (const league of Array.isArray(result.leagues) ? result.leagues : []) {
    for (const p of Array.isArray(league.plays) ? league.plays : []) {
      plays.push(normalizePlay(p, { league: league.league }));
    }
  }
  return plays;
}

/**
 * Default live provider: builds the real MCP handlers + client and pulls the
 * recommended plays. Lazily required so the module can be loaded (and tested)
 * without pulling in the full handler graph.
 */
async function defaultGetPlays({ leagues, market } = {}) {
  // eslint-disable-next-line global-require
  const { createMcpHandlers } = require('../scripts/server/handlers');
  // eslint-disable-next-line global-require
  const { createPropProfessorClient } = require('../lib/propprofessor-api');
  const handlers = createMcpHandlers({ client: createPropProfessorClient() });
  const res = await handlers.quick_screen({
    mode: 'recommended',
    leagues: Array.isArray(leagues) && leagues.length ? leagues : undefined,
    market: market || undefined,
    limit: 50,
    validate: false,
    includeResearch: false
  });
  return playsFromHandlerResult(res, { source: 'quick_screen' });
}

/**
 * Take a daily snapshot.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.getPlays] - async ()=>Array<normalized|raw play> source
 * @param {string}   [opts.outFile]  - jsonl path (default data/snapshots.jsonl)
 * @param {string[]} [opts.leagues]  - leagues for default provider
 * @param {string}   [opts.market]   - market for default provider
 * @returns {Promise<{written:number, skipped:number, totalPlays:number, outFile:string}>}
 */
async function takeDailySnapshot(opts = {}) {
  const outFile = opts.outFile || SNAPSHOT_FILE;
  const dir = path.dirname(outFile);
  fs.mkdirSync(dir, { recursive: true });

  // Load existing ledger.
  let existing = [];
  if (fs.existsSync(outFile)) {
    existing = fs
      .readFileSync(outFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  const today = new Date().toISOString().slice(0, 10);
  const todaysIds = new Set(existing.filter((p) => utcDay(p.timestamp) === today).map((p) => p.playId));

  const getPlays = opts.getPlays || defaultGetPlays;
  const rawPlays = await getPlays({ leagues: opts.leagues, market: opts.market });

  // Ensure normalized shape and drop anything already snapshotted today.
  const newPlays = [];
  for (const p of rawPlays) {
    const norm = p.playId && p.timestamp ? p : normalizePlay(p, { league: opts.league });
    if (!norm.playId) continue;
    if (todaysIds.has(norm.playId)) continue;
    newPlays.push(norm);
  }

  if (newPlays.length) {
    const chunk = newPlays.map((p) => JSON.stringify(p)).join('\n') + '\n';
    fs.appendFileSync(outFile, chunk);
  }

  return {
    written: newPlays.length,
    skipped: rawPlays.length - newPlays.length,
    totalPlays: rawPlays.length,
    outFile
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split(/=(.+)/);
      flags[k.replace(/^--/, '')] = v === undefined ? true : v;
    }
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv);
  const leagues = typeof flags.leagues === 'string' ? flags.leagues.split(',') : undefined;
  const result = await takeDailySnapshot({
    outFile: flags.out || undefined,
    leagues,
    market: typeof flags.market === 'string' ? flags.market : undefined
  });
  console.log(
    `daily-snapshot: wrote ${result.written} new play(s), skipped ${result.skipped} ` +
      `(already present today). -> ${result.outFile}`
  );
  return result;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`daily-snapshot failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  takeDailySnapshot,
  buildPlayId,
  normalizePlay,
  playsFromHandlerResult,
  SNAPSHOT_FILE,
  utcDay
};
