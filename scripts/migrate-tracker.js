#!/usr/bin/env node
'use strict';

/**
 * One-time legacy tracker migration (Task 7).
 *
 * Imports settled bets from the old Python tracker
 * (~/.propprofessor/tracker/bets.json by default) into the v2 local ledger
 * (PP_RECORD_LEDGER, default ~/.propprofessor/tracker/ledger.json) without
 * double-counting. The legacy file is READ-ONLY input: it is never
 * overwritten, and the script refuses to run when source and ledger resolve
 * to the same path.
 *
 * Legacy records carry no event date (only loggedAt/settledAt), so migrated
 * bets get `eventDate: "unknown"` rather than a guessed date. Unknown-date
 * records can never appear in strict date-filtered reviews. The full
 * original record is preserved verbatim in each bet's `legacy` metadata,
 * along with the legacy id, status, and P&L (plUnits).
 *
 * Usage:
 *   node scripts/migrate-tracker.js [--source bets.json] [--ledger ledger.json]
 *                                   [--apply] [--json]
 *
 *   --source <file>  legacy tracker file (default ~/.propprofessor/tracker/bets.json)
 *   --ledger <file>  destination v2 ledger (default PP_RECORD_LEDGER or
 *                    ~/.propprofessor/tracker/ledger.json)
 *   --apply          actually write. DRY-RUN IS THE DEFAULT: without --apply
 *                    nothing is read or written except the source file.
 *   --json           machine-readable JSON on stdout
 *
 * Before --apply writes, the existing destination ledger (if any) is copied
 * to <ledger>.bak-<timestamp> so the pre-import state is recoverable. The
 * legacy source is never touched.
 *
 * Exit codes: 0 success, 2 usage/input errors, 1 ledger read/save/backup
 * errors. Malformed input and invalid records fail BEFORE any write.
 */

const fs = require('node:fs');
const os = require('node:os');
const pathModule = require('node:path');

const ledgerApi = require('../lib/record-ledger');

const LEGACY_STATUSES = ['win', 'loss', 'push', 'void', 'cashout', 'pending', 'unresolved'];
// Explicit date fields a future legacy record may carry. loggedAt/settledAt
// are deliberately NOT included: they are record-keeping timestamps, not
// event dates, and using them would be guessing.
const EVENT_DATE_FIELDS = ['eventDate', 'start', 'startTime', 'startAt', 'gameTime', 'scheduledStart', 'date'];
const MIGRATION_SOURCE = 'legacy_tracker_bets_json';

function defaultSourcePath() {
  return pathModule.join(os.homedir(), '.propprofessor', 'tracker', 'bets.json');
}

function parseArgs(argv) {
  const args = (Array.isArray(argv) ? argv : []).slice(2);
  const options = { source: null, ledger: null, apply: false, dryRun: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run' || arg === '--dryRun') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--source' || arg === '--ledger') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ...options, parseError: `missing value for ${arg}` };
      }
      if (arg === '--source') options.source = value;
      else options.ledger = value;
      i += 1;
    } else if (arg.startsWith('--source=')) {
      options.source = arg.slice('--source='.length);
    } else if (arg.startsWith('--ledger=')) {
      options.ledger = arg.slice('--ledger='.length);
    } else {
      return { ...options, parseError: `unknown argument: ${arg}` };
    }
  }
  if (options.apply && options.dryRun) {
    return { ...options, parseError: 'cannot combine --apply with --dry-run' };
  }
  return options;
}

/**
 * Validate the legacy tracker file shape. Returns the bets array on success.
 * A record is valid when it has a non-empty string id, a known status, and a
 * non-empty selection. Duplicate legacy ids in the same file are rejected.
 */
function validateLegacyFile(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['legacy tracker file must be a JSON object'] };
  }
  if (!Array.isArray(data.bets)) {
    return { ok: false, errors: ['legacy tracker file must contain a "bets" array'] };
  }
  const errors = [];
  const seenIds = new Set();
  for (let i = 0; i < data.bets.length; i++) {
    const bet = data.bets[i];
    const label = `bets[${i}]`;
    if (!bet || typeof bet !== 'object' || Array.isArray(bet)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof bet.id !== 'string' || bet.id.trim() === '') {
      errors.push(`${label}: id must be a non-empty string`);
    } else if (seenIds.has(bet.id)) {
      errors.push(`${label}: duplicate legacy id '${bet.id}'`);
    } else {
      seenIds.add(bet.id);
    }
    if (typeof bet.status !== 'string' || !LEGACY_STATUSES.includes(bet.status)) {
      errors.push(`${label}: status must be one of ${LEGACY_STATUSES.join(', ')} (got '${bet.status}')`);
    }
    if (typeof bet.selection !== 'string' || bet.selection.trim() === '') {
      errors.push(`${label}: selection must be a non-empty string`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, bets: data.bets };
}

/**
 * Resolve the event date from explicit legacy date fields only. Never
 * guesses from loggedAt/settledAt/gameId. Returns 'unknown' when absent or
 * unusable, with a warning for present-but-unparseable values.
 */
function extractEventDate(legacyBet) {
  for (const field of EVENT_DATE_FIELDS) {
    const raw = legacyBet[field];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string') {
      return {
        value: 'unknown',
        sourceField: null,
        warning: `field '${field}' is not a usable date string; treating event date as unknown`
      };
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      return {
        value: 'unknown',
        sourceField: null,
        warning: `field '${field}' ('${raw}') is not a parseable date; treating event date as unknown`
      };
    }
    return { value: parsed.toISOString(), sourceField: field, warning: null };
  }
  return { value: 'unknown', sourceField: null, warning: null };
}

const OPTIONAL_LEGACY_FIELDS = ['game', 'market', 'odds', 'stake', 'plUnits', 'loggedAt', 'settledAt'];

/**
 * Map one legacy bet to a v2 ledger bet record. Preserves the legacy id,
 * status, P&L (plUnits), and the complete original record under `legacy`.
 * Missing optional fields are reported as warnings, never guessed.
 */
function mapLegacyBet(legacyBet, { now, sourcePath, sourceVersion }) {
  const event = extractEventDate(legacyBet);
  const warnings = [];
  if (event.warning) warnings.push(event.warning);
  for (const field of OPTIONAL_LEGACY_FIELDS) {
    const value = legacyBet[field];
    if (value === undefined || value === null || value === '') warnings.push(`missing ${field}`);
  }
  const bet = {
    id: legacyBet.id,
    candidateId: null,
    gameId: legacyBet.gameId ?? null,
    game: legacyBet.game ?? null,
    league: legacyBet.league ?? null,
    market: legacyBet.market ?? null,
    selection: legacyBet.selection,
    oddsAtDecision: legacyBet.odds ?? null,
    stake: legacyBet.stake ?? null,
    status: legacyBet.status,
    plUnits: legacyBet.plUnits ?? null,
    eventDate: event.value,
    eventDateSource: event.sourceField,
    decisionAt: null,
    decisionSource: null,
    settlementId: null,
    migratedAt: now,
    createdAt: now,
    migration: {
      source: MIGRATION_SOURCE,
      sourcePath,
      sourceVersion,
      legacyId: legacyBet.id,
      eventDate: event.value,
      note:
        event.value === 'unknown'
          ? 'no event date recorded in the legacy tracker; treated as unknown and excluded from strict date-filtered reviews'
          : null
    },
    legacy: { ...legacyBet }
  };
  return { bet, warnings, eventDate: event.value };
}

function copyFile(fsModule, from, to) {
  if (typeof fsModule.copyFileSync === 'function') {
    fsModule.copyFileSync(from, to);
    return;
  }
  fsModule.writeFileSync(to, fsModule.readFileSync(from), { encoding: 'utf8', flag: 'w' });
}

function failResult(options, error, exitCode) {
  return {
    ok: false,
    error,
    exitCode,
    source: options.source,
    path: options.ledger,
    apply: options.apply,
    dryRun: !options.apply,
    wrote: false,
    alreadyMigrated: false,
    backupPath: null,
    imported: [],
    duplicates: [],
    warnings: [],
    summary: { total: 0, new: 0, duplicates: 0, unknownDates: 0, pnlUnitsImported: 0 }
  };
}

/**
 * Read and validate the legacy tracker file. Returns parsed data plus the
 * validated bets, or a fail-shaped result (exitCode 2) for bad input.
 */
function readLegacySource(fsModule, source) {
  let raw;
  try {
    raw = fsModule.readFileSync(source, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: `cannot read legacy tracker file: ${error && error.code ? error.code : 'operation failed'}`,
      exitCode: 2
    };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: `legacy tracker file contains invalid JSON: ${source}`, exitCode: 2 };
  }
  const validation = validateLegacyFile(data);
  if (!validation.ok) {
    return { ok: false, error: `invalid legacy tracker file: ${validation.errors.join('; ')}`, exitCode: 2 };
  }
  return { ok: true, data, bets: validation.bets };
}

/**
 * Partition mapped records into new imports and already-present duplicates,
 * keyed by the preserved legacy id so re-running never double-counts.
 */
function partitionMapped(mapped, destination) {
  const existingIds = new Set((destination.bets || []).map((bet) => bet && bet.id).filter(Boolean));
  const imported = [];
  const duplicates = [];
  for (const item of mapped) {
    if (existingIds.has(item.bet.id)) {
      duplicates.push({ id: item.bet.id, status: item.bet.status, eventDate: item.eventDate });
    } else {
      existingIds.add(item.bet.id);
      imported.push(item);
    }
  }
  return { imported, duplicates };
}

/** Aggregate warnings and the numeric summary for the report. */
function buildSummary(mapped, imported, duplicates) {
  const warnings = [];
  for (const item of imported) {
    for (const warning of item.warnings) warnings.push(`${item.bet.id}: ${warning}`);
  }
  const pnlUnitsImported = imported.reduce(
    (sum, item) => sum + (typeof item.bet.plUnits === 'number' ? item.bet.plUnits : 0),
    0
  );
  const summary = {
    total: mapped.length,
    new: imported.length,
    duplicates: duplicates.length,
    unknownDates: imported.filter((item) => item.eventDate === 'unknown').length,
    pnlUnitsImported: Math.round(pnlUnitsImported * 1000) / 1000
  };
  return { warnings, summary };
}

/**
 * Core migration run. Reads the legacy source, validates every record,
 * maps to v2 bets, dedupes against the destination ledger by legacy id, and
 * (only with apply=true) backs up the destination ledger and writes.
 * Never writes on malformed input, on dry-run, or when nothing is new.
 */
function runMigration(opts = {}) {
  const fsModule = opts.fs || fs;
  const source = opts.source || defaultSourcePath();
  const ledger = opts.ledger || ledgerApi.defaultLedgerPath();
  const apply = opts.apply === true;
  const now = typeof opts.now === 'function' ? opts.now() : new Date().toISOString();
  const options = { source, ledger, apply };
  const base = {
    source,
    path: ledger,
    apply,
    dryRun: !apply,
    wrote: false,
    alreadyMigrated: false,
    backupPath: null,
    imported: [],
    duplicates: [],
    warnings: []
  };

  if (pathModule.resolve(source) === pathModule.resolve(ledger)) {
    return failResult(
      options,
      'refusing to migrate: source and ledger paths are the same file (bets.json is never overwritten)',
      2
    );
  }

  const read = readLegacySource(fsModule, source);
  if (!read.ok) return failResult(options, read.error, read.exitCode);

  const loaded = ledgerApi.loadLedger({ fs: fsModule, path: ledger });
  if (!loaded.ok) return failResult(options, loaded.error, 1);
  const destination = loaded.ledger;

  const sourceVersion = read.data && read.data.version !== undefined ? read.data.version : 1;
  const mapped = read.bets.map((legacyBet) => mapLegacyBet(legacyBet, { now, sourcePath: source, sourceVersion }));

  const { imported, duplicates } = partitionMapped(mapped, destination);
  const { warnings, summary } = buildSummary(mapped, imported, duplicates);

  if (!apply) {
    return {
      ...base,
      ok: true,
      summary,
      imported: imported.map((item) => item.bet),
      duplicates,
      warnings
    };
  }

  if (imported.length === 0) {
    return { ...base, ok: true, alreadyMigrated: true, summary, duplicates, warnings };
  }

  let backupPath = null;
  if (fsModule.existsSync(ledger)) {
    backupPath = `${ledger}.bak-${now.replace(/[:.]/g, '-')}`;
    try {
      copyFile(fsModule, ledger, backupPath);
    } catch (error) {
      return {
        ...failResult(
          options,
          `unable to back up ledger before apply: ${error && error.code ? error.code : 'operation failed'}`,
          1
        ),
        backupPath
      };
    }
  }

  for (const item of imported) {
    ledgerApi.addRecord(destination, 'bets', item.bet, { now: () => now });
  }
  const saved = ledgerApi.saveLedger(destination, { fs: fsModule, path: ledger });
  if (!saved.ok) {
    return { ...failResult(options, saved.error, 1), backupPath };
  }

  return {
    ...base,
    ok: true,
    wrote: true,
    backupPath,
    summary,
    imported: imported.map((item) => item.bet),
    duplicates,
    warnings
  };
}

/** Concise human-readable status lines (no JSON). */
function formatSummary(result) {
  const tag = result.dryRun ? '[dry-run] ' : '';
  const lines = [
    `${tag}migrate-tracker: ${result.summary.total} legacy records -> ${result.summary.new} new, ` +
      `${result.summary.duplicates} already present, ${result.summary.unknownDates} unknown-date` +
      `${result.dryRun ? ' (nothing written; use --apply to migrate)' : ''}`
  ];
  if (result.alreadyMigrated) {
    lines.push('already migrated: no new records to import');
    return lines.join('\n');
  }
  for (const bet of result.imported) {
    const pnl = typeof bet.plUnits === 'number' ? `${bet.plUnits >= 0 ? '+' : ''}${bet.plUnits}u` : 'n/a';
    lines.push(
      `  import  ${bet.status}  ${bet.id}  ${bet.league || '?'}  ${bet.market || '?'}  ${bet.selection}  ${pnl}`
    );
  }
  for (const item of result.duplicates) {
    lines.push(`  skip    ${item.status}  ${item.id}  already present`);
  }
  for (const warning of result.warnings) {
    lines.push(`  warn    ${warning}`);
  }
  if (result.summary.unknownDates > 0) {
    lines.push('note: unknown-date records cannot appear in strict date-filtered reviews');
  }
  if (result.backupPath) lines.push(`backup: ${result.backupPath}`);
  if (result.wrote) lines.push(`wrote: ${result.path}`);
  return lines.join('\n');
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.parseError) {
    console.error(`migrate-tracker: ${options.parseError}`);
    process.exitCode = 2;
    return { ok: false, error: options.parseError, exitCode: 2 };
  }
  const result = runMigration(options);
  if (options.json) {
    console.log(JSON.stringify(result));
  } else if (!result.ok) {
    console.error(`migrate-tracker: ${result.error}`);
  } else {
    console.log(formatSummary(result));
  }
  if (!result.ok) process.exitCode = result.exitCode || 1;
  return result;
}

if (require.main === module) {
  main(process.argv).catch((error) => {
    console.error(`migrate-tracker failed: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  defaultSourcePath,
  parseArgs,
  validateLegacyFile,
  extractEventDate,
  mapLegacyBet,
  runMigration,
  formatSummary,
  main
};
