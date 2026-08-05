#!/usr/bin/env node
'use strict';

// CLI: node scripts/backtest.js [league] [market] [days]
// Defaults: MLB Moneyline 30
//
// SNAPSHOT-BASED TIER BACKTEST SYSTEM
//
// The PropProfessor API doesn't serve historical resolved results, so this
// script takes a snapshot-based approach:
//
//   1. `backtest --snapshot [league] [market] --live` — fetches current
//      screen data, classifies each row by confidence tier, and saves to
//      backtest-data/YYYY-MM-DD-league-market.json. The `--live` flag is
//      required: PropProfessor is manual-only, and snapshot capture calls
//      live PropProfessor endpoints. There is no scheduled/unattended path.
//
//   2. `backtest [league] [market] [days]` — loads saved snapshots from
//      the last N days and reports aggregate tier distribution (no outcome
//      data available yet — requires manual result entry or future API)
//
//   3. `backtest --resolve <snapshot-file> --wins=N --losses=M --pushes=P`
//      — attach outcomes to a saved snapshot for hit-rate calculation.
//
// Build a history of snapshots, then resolve them as games settle.

const fs = require('node:fs');
const path = require('node:path');
const { createPropProfessorClient } = require('../lib/propprofessor-api');
const { extractScreenRows } = require('../lib/screen-parser');
const { getConfidenceTier } = require('../lib/propprofessor-risk-score');
const { DEFAULT_LEAGUES } = require('../lib/propprofessor-shared-utils');
const { computeBacktestMetrics } = require('../lib/propprofessor-backtest-metrics');

// Defense-in-depth league guard. PropProfessor is manual-only — snapshot
// capture requires an explicit `--live` acknowledgment (see takeSnapshot)
// and must never run unattended. Anyone calling takeSnapshot() directly —
// e.g. via `pp-query backtest` or as a library — hits the same gates.
// Keep this in sync with DEFAULT_LEAGUES (single source of truth).
const SUPPORTED_LEAGUES = new Set(DEFAULT_LEAGUES.map((l) => l.toUpperCase()));

const DATA_DIR = path.join(__dirname, '..', 'backtest-data');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayTag() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function snapshotFilename(league, market, tag) {
  return `${tag || todayTag()}-${league.toLowerCase()}-${market.toLowerCase()}.json`;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Parse CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const [k, v] = args[i].split(/=(.+)/);
      if (v !== undefined) {
        flags[k.replace('--', '')] = v;
      } else {
        // Bare boolean flag: consume the next token ONLY if it is a value
        // (not another flag), so `--snapshot --live` parses both flags.
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[k.replace('--', '')] = next;
          i += 1;
        } else {
          flags[k.replace('--', '')] = true;
        }
      }
    } else {
      positional.push(args[i]);
    }
  }

  return {
    league: positional[0] || 'MLB',
    market: positional[1] || 'Moneyline',
    days: parseInt(positional[2], 10) || 30,
    snapshot:
      flags.snapshot !== undefined ? (flags.snapshot === true || flags.snapshot === '' ? true : flags.snapshot) : false,
    resolve: flags.resolve || null,
    metrics: flags.metrics || null,
    wins: parseInt(flags.wins, 10) || 0,
    losses: parseInt(flags.losses, 10) || 0,
    pushes: parseInt(flags.pushes, 10) || 0,
    live: flags.live !== undefined
  };
}

// ---------------------------------------------------------------------------
// Core: fetch + classify + save snapshot
// ---------------------------------------------------------------------------

async function takeSnapshot({ league, market, tag, live }) {
  if (!SUPPORTED_LEAGUES.has(String(league || '').toUpperCase())) {
    throw new Error(`Unsupported league: "${league}". Supported: ${[...SUPPORTED_LEAGUES].sort().join(', ')}`);
  }
  // Manual-only gate: snapshot capture always calls live PropProfessor
  // endpoints (createPropProfessorClient → queryScreenOdds). Require an
  // explicit --live acknowledgment on every invocation; there is no
  // unattended/scheduled path.
  if (!live) {
    throw new Error(
      'manual-only: PropProfessor is manual-only — pass --live to acknowledge this snapshot calls live PropProfessor endpoints'
    );
  }
  ensureDataDir();
  const client = createPropProfessorClient();
  tag = tag || todayTag();

  console.log(`Taking snapshot: ${league} ${market} (${tag})...`);

  const payload = await client.queryScreenOdds({ league, market });
  const rows = extractScreenRows(payload);

  const classified = rows.map((row) => {
    const tier = getConfidenceTier(row);
    const participant = row.participant || row.team || row.name || '?';
    const odds = row.odds ?? row.americanOdds ?? row.price ?? '?';
    return { participant, odds, tier, raw: row };
  });

  // Group by tier
  const byTier = {};
  for (const c of classified) {
    if (!byTier[c.tier]) byTier[c.tier] = [];
    byTier[c.tier].push({ participant: c.participant, odds: c.odds });
  }

  const snapshot = {
    meta: { league, market, date: tag, capturedAt: new Date().toISOString(), totalRows: rows.length },
    summary: Object.fromEntries(Object.entries(byTier).map(([tier, picks]) => [tier, picks.length])),
    byTier,
    resolved: null // placeholder for manual outcome entry
  };

  const fname = snapshotFilename(league, market, tag);
  const fpath = path.join(DATA_DIR, fname);
  fs.writeFileSync(fpath, JSON.stringify(snapshot, null, 2), 'utf8');

  console.log(`\nSaved ${rows.length} rows across ${Object.keys(byTier).length} tiers`);
  for (const [tier, picks] of Object.entries(byTier).sort()) {
    console.log(`  ${tier}: ${picks.length} plays`);
  }
  console.log(`\nSnapshot → ${fpath}`);
  return { ok: true, file: fpath, rows: rows.length };
}

// ---------------------------------------------------------------------------
// Outcome resolution
// ---------------------------------------------------------------------------

function resolveSnapshot(file, { wins, losses, pushes }) {
  const fpath = path.isAbsolute(file) ? file : path.join(DATA_DIR, file);
  if (!fs.existsSync(fpath)) {
    console.error(`Snapshot not found: ${fpath}`);
    return { ok: false, error: 'file_not_found' };
  }

  const snapshot = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  const totalPicks = Object.values(snapshot.byTier).reduce((s, a) => s + a.length, 0);
  const decidable = wins + losses;

  console.log(`Resolving: ${path.basename(fpath)}`);
  console.log(`  ${snapshot.meta.league} ${snapshot.meta.market} — ${snapshot.meta.date}`);
  console.log(`  Total picks in snapshot: ${totalPicks}`);
  console.log(`  Reported outcomes: ${wins}W / ${losses}L / ${pushes}P`);

  if (decidable === 0) {
    console.log('  No decidable outcomes — nothing to calculate.');
    return { ok: false, reason: 'no_outcomes' };
  }

  const hitRate = ((wins / decidable) * 100).toFixed(1);
  console.log(`  Hit rate: ${hitRate}% (${wins}/${decidable})`);

  // Write resolved data back into the snapshot file
  snapshot.resolved = { wins, losses, pushes, hitRate, resolvedAt: new Date().toISOString() };
  fs.writeFileSync(fpath, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`  Resolution saved to snapshot file.`);

  return { ok: true, hitRate, wins, losses, pushes, totalPicks };
}

// ---------------------------------------------------------------------------
// Aggregate: load recent snapshots and report
// ---------------------------------------------------------------------------

async function aggregate({ league, market, days }) {
  ensureDataDir();

  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !league || f.includes(league.toLowerCase()))
    .filter((f) => !market || f.includes(market.toLowerCase()))
    .sort()
    .slice(-days);

  if (!files.length) {
    console.log('No snapshot files found.');
    console.log(`Run \`node scripts/backtest.js --snapshot ${league} ${market}\` first.`);
    return { ok: false, reason: 'no_snapshots' };
  }

  console.log(`Aggregating ${files.length} snapshot(s) for ${league} ${market} (last ${days}d):\n`);

  let totalRows = 0;
  const tierTotals = {};
  let resolvedWins = 0;
  let resolvedLosses = 0;
  let resolvedPushes = 0;

  for (const f of files) {
    const snap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    totalRows += snap.meta.totalRows || 0;
    for (const [tier, picks] of Object.entries(snap.byTier || {})) {
      if (!tierTotals[tier]) tierTotals[tier] = 0;
      tierTotals[tier] += picks.length;
    }
    if (snap.resolved) {
      resolvedWins += snap.resolved.wins || 0;
      resolvedLosses += snap.resolved.losses || 0;
      resolvedPushes += snap.resolved.pushes || 0;
    }
  }

  // Tier distribution
  console.log('Tier Distribution (all snapshots):');
  console.log('  Tier\t\tPicks');
  console.log('  ----\t\t-----');
  for (const [tier, count] of Object.entries(tierTotals).sort()) {
    console.log(`  ${tier}\t\t${count}`);
  }
  console.log(`\n  Total rows scanned: ${totalRows}`);

  // Resolved outcomes
  const decidable = resolvedWins + resolvedLosses;
  if (decidable > 0) {
    const hitRate = ((resolvedWins / decidable) * 100).toFixed(1);
    console.log(`\nResolved Outcomes:`);
    console.log(`  ${resolvedWins}W / ${resolvedLosses}L / ${resolvedPushes}P`);
    console.log(`  Hit rate: ${hitRate}% (${resolvedWins}/${decidable})`);
  } else {
    console.log(`\nNo resolved outcomes yet.`);
    console.log(`Use \`node scripts/backtest.js --resolve <file> --wins=... --losses=...\``);
    console.log(`to record outcomes for individual snapshots.`);
  }

  return { ok: true, files: files.length, totalRows, tierTotals };
}

// ---------------------------------------------------------------------------
// Metrics: P&L / ROI / Sharpe / drawdown from a resolved snapshot's plays
// ---------------------------------------------------------------------------

function reportMetrics(file) {
  const fpath = path.isAbsolute(file) ? file : path.join(DATA_DIR, file);
  if (!fs.existsSync(fpath)) {
    console.error(`Snapshot not found: ${fpath}`);
    return { ok: false, error: 'file_not_found' };
  }
  const snapshot = JSON.parse(fs.readFileSync(fpath, 'utf8'));
  const plays = snapshot.resolved && snapshot.resolved.plays;
  if (!Array.isArray(plays) || plays.length === 0) {
    console.error(`Snapshot ${path.basename(fpath)} has no per-play outcomes to score.`);
    console.error('Resolve with per-play outcomes first (set resolved.plays = [{odds, stake, result}]).');
    return { ok: false, error: 'no_plays' };
  }

  const m = computeBacktestMetrics(plays);
  console.log(`\\nBacktest Metrics — ${path.basename(fpath)}`);
  console.log(`  Bets:      ${m.bets} (${m.wins}W / ${m.losses}L / ${m.pushes}P)`);
  console.log(`  Win rate:  ${m.winRate === null ? 'n/a' : m.winRate + '%'}`);
  console.log(`  P&L:       $${m.profit.toFixed(2)}`);
  console.log(`  ROI:       ${m.roi === null ? 'n/a' : m.roi.toFixed(1) + '%'}`);
  console.log(`  Sharpe:    ${m.sharpe === null ? 'n/a' : m.sharpe}`);
  console.log(`  Max DD:    $${m.maxDrawdown.toFixed(2)}`);
  return { ok: true, metrics: m };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(opts, deps = {}) {
  if (opts.metrics) {
    return reportMetrics(opts.metrics);
  }
  if (opts.resolve) {
    return resolveSnapshot(opts.resolve, { wins: opts.wins, losses: opts.losses, pushes: opts.pushes });
  }
  if (opts.snapshot) {
    const leagueOpt = typeof opts.snapshot === 'string' ? opts.snapshot : opts.league;
    const marketOpt = opts.market;
    const snapshot = deps.takeSnapshot || takeSnapshot;
    return snapshot({ league: leagueOpt, market: marketOpt, tag: opts.tag, live: opts.live });
  }
  return aggregate({ league: opts.league, market: opts.market, days: opts.days });
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  main(opts).then((result) => {
    process.exit(result.ok ? 0 : 1);
  });
}

module.exports = { backtest: main, parseArgs, takeSnapshot, resolveSnapshot, aggregate };
