#!/usr/bin/env node
'use strict';

/**
 * Local-only settlement CLI (Task 5).
 *
 * Settles official bets recorded in the tracker ledger (PP_RECORD_LEDGER,
 * default ~/.propprofessor/tracker/ledger.json) against SUPPLIED result
 * data. There is NO network code in this script or in lib/record-settlement:
 * the caller must already have fetched results (e.g. an ESPN scoreboard
 * dump) and hand them over as a JSON file. PropProfessor is never touched.
 *
 * Result file contract (required shape):
 *   { "provider": "<non-empty string>", "sourceUrl": "<non-empty string>",
 *     "events": [...] }
 * Bare arrays of events are no longer accepted: settlement requires
 * non-empty top-level provider and sourceUrl provenance so every settled
 * record is traceable. Each event may be a flat object ({ eventId,
 * homeTeam, homeScore, awayTeam, awayScore, status: 'final', date }) or an
 * ESPN-style payload ({ id, date, status, competitions: [...] }).
 *
 * Usage:
 *   PP_RECORD_LEDGER=/path/to/ledger.json node scripts/settle-record.js \
 *     --results results.json [--date 2026-08-04] [--dry-run] [--force] [--json]
 *
 *   --results <file>   required — local JSON result data (no network fetch)
 *   --date YYYY-MM-DD  only settle bets whose scheduled start falls on that
 *                      America/Chicago calendar day
 *   --dry-run          report what would be settled without writing anything
 *   --force            re-settle bets that already have a settled status
 *   --json             machine-readable JSON on stdout
 *
 * Exit codes: 0 success, 2 usage/input errors, 1 ledger read/save errors.
 * Malformed or missing inputs are rejected before the ledger is touched.
 */

const fs = require('node:fs');

const ledgerApi = require('../lib/record-ledger');
const settlement = require('../lib/record-settlement');

// Start resolution is centralized in lib/record-settlement.betStart so direct
// library calls and the CLI agree: bet.start, bet.scheduledStart, then the
// candidate snapshot fields (card-promoted bets keep the schedule there).
const betStart = settlement.betStart;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs(argv) {
  const args = (Array.isArray(argv) ? argv : []).slice(2);
  const options = { results: null, date: null, dryRun: false, force: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run' || arg === '--dryRun') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--results' || arg === '--date') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ...options, parseError: `missing value for ${arg}` };
      }
      if (arg === '--results') options.results = value;
      else options.date = value;
      i += 1;
    } else if (arg.startsWith('--results=')) {
      options.results = arg.slice('--results='.length);
    } else if (arg.startsWith('--date=')) {
      options.date = arg.slice('--date='.length);
    } else {
      return { ...options, parseError: `unknown argument: ${arg}` };
    }
  }
  return options;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The America/Chicago calendar day (YYYY-MM-DD) an ISO timestamp falls on. */
function chicagoDay(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (type) => {
    const part = parts.find((item) => item.type === type);
    return part ? part.value : '';
  };
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Core settlement run. Reads the results file, loads the ledger, filters by
 * --date, settles through lib/record-settlement, and (unless dry-run) saves
 * atomically. Never writes when --dry-run, when no bets were processed, or
 * when any input is malformed.
 */
function runSettleRecord(opts = {}) {
  const fsModule = opts.fs || fs;
  const ledgerPath = opts.path || ledgerApi.defaultLedgerPath();
  const options = {
    results: opts.results || null,
    date: opts.date || null,
    dryRun: opts.dryRun === true,
    force: opts.force === true
  };
  const fail = (error, exitCode = 2) => ({
    ok: false,
    error,
    exitCode,
    path: ledgerPath,
    dryRun: options.dryRun,
    force: options.force,
    date: options.date,
    settled: [],
    pending: [],
    skipped: []
  });

  if (!options.results) return fail('--results <json-file> is required (local result data, no network)');
  if (options.date && !isValidDate(options.date)) {
    return fail(`--date must be a real YYYY-MM-DD date (got '${options.date}')`);
  }

  let raw;
  try {
    raw = fsModule.readFileSync(options.results, 'utf8');
  } catch (error) {
    const code = error && error.code ? error.code : 'operation failed';
    return fail(`cannot read results file: ${code}`);
  }
  let resultData;
  try {
    resultData = JSON.parse(raw);
  } catch {
    return fail(`results file contains invalid JSON: ${options.results}`);
  }
  if (!resultData || typeof resultData !== 'object' || Array.isArray(resultData)) {
    return fail(
      'results file must contain an object with non-empty top-level provider and sourceUrl (bare event arrays are no longer accepted)'
    );
  }
  if (typeof resultData.provider !== 'string' || resultData.provider.trim() === '') {
    return fail('results file missing a non-empty top-level provider (settlement provenance required)');
  }
  if (typeof resultData.sourceUrl !== 'string' || resultData.sourceUrl.trim() === '') {
    return fail('results file missing a non-empty top-level sourceUrl (settlement provenance required)');
  }

  const loaded = ledgerApi.loadLedger({ fs: fsModule, path: ledgerPath });
  if (!loaded.ok) return fail(loaded.error, 1);
  const ledger = loaded.ledger;

  let bets = Array.isArray(ledger.bets) ? ledger.bets.filter(Boolean) : [];
  if (options.date) bets = bets.filter((bet) => chicagoDay(betStart(bet)) === options.date);

  const result = settlement.solve(ledger, {
    bets,
    resultData,
    force: options.force,
    now: opts.now
  });

  // Only persist when the run actually produced new/updated settlement or
  // pending records; a run where every bet was already settled (or filtered
  // out) must not rewrite the ledger or report wrote:true.
  const changed = result.settled.length > 0 || result.pending.length > 0;
  let wrote = false;
  if (!options.dryRun && changed) {
    const saved = ledgerApi.saveLedger(ledger, { fs: fsModule, path: ledgerPath });
    if (!saved.ok) {
      return {
        ok: false,
        error: saved.error,
        exitCode: 1,
        path: ledgerPath,
        dryRun: options.dryRun,
        force: options.force,
        date: options.date,
        settled: result.settled,
        pending: result.pending,
        skipped: result.skipped
      };
    }
    wrote = true;
  }

  return {
    ok: true,
    path: ledgerPath,
    dryRun: options.dryRun,
    force: options.force,
    date: options.date,
    wrote,
    settled: result.settled,
    pending: result.pending,
    skipped: result.skipped
  };
}

/** Concise human-readable status lines (no JSON). */
function formatSummary(result) {
  const tag = result.dryRun ? '[dry-run] ' : '';
  const lines = [
    `${tag}settle-record: ${result.settled.length} settled, ${result.pending.length} pending, ` +
      `${result.skipped.length} skipped${result.dryRun ? ' (nothing written)' : ''}`
  ];
  for (const record of result.settled) {
    lines.push(
      `  ${record.status}  ${record.betId || '(unknown bet)'}  ${record.league || '?'}  ` +
        `${record.market || '?'}  ${record.selection || '?'}  -> ${record.reason}`
    );
  }
  for (const record of result.pending) {
    lines.push(`  pending  ${record.betId || '(unknown bet)'}  ${record.reason}`);
  }
  for (const item of result.skipped) {
    lines.push(`  skipped  ${item.betId || '(unknown bet)'}  ${item.reason}`);
  }
  return lines.join('\n');
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.parseError) {
    console.error(`settle-record: ${options.parseError}`);
    process.exitCode = 2;
    return { ok: false, error: options.parseError, exitCode: 2 };
  }
  const result = runSettleRecord(options);
  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (!result.ok) {
    console.error(`settle-record: ${result.error}`);
  } else {
    console.log(formatSummary(result));
  }
  if (!result.ok) process.exitCode = result.exitCode || 1;
  return result;
}

if (require.main === module) {
  main(process.argv).catch((error) => {
    console.error(`settle-record failed: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, isValidDate, betStart, chicagoDay, runSettleRecord, formatSummary, main };
