#!/usr/bin/env node
'use strict';

/**
 * Outcome-resolution pipeline for REAL backtest metrics.
 *
 * Reads data/snapshots.jsonl, and for each unresolved play (no `result`
 * field) determines the actual settled outcome (win | loss | push) and writes
 * it back into the snapshot line, in place.
 *
 * Two resolution paths:
 *
 *   1. CSV fallback (RELIABLE, default when no live resolver is wired):
 *      `node scripts/resolve-outcomes.js --csv results.csv`
 *      The CSV has columns `playId,result` (plus optional `odds`,`stake`).
 *      This guarantees the pipeline works WITHOUT depending on a flaky live
 *      settlement endpoint. This is the path the unit test exercises.
 *
 *   2. Live settlement (OPTIONAL hook):
 *      Pass `--live` to call an injected/optional `getPlayResult(play)` resolver.
 *      The PropProfessor API does NOT currently expose a settled-results feed,
 *      so there is no built-in client method — `liveGetPlayResult` is `null`
 *      by default and must be supplied by the caller (e.g. a future sports-data
 *      adapter). The live path is only attempted when `--live` is passed AND a
 *      resolver is provided; otherwise it falls back to CSV if one is supplied,
 *      then no-ops.
 *
 *   3. ESPN auto-resolution (BUILT-IN, no manual input):
 *      `node scripts/resolve-outcomes.js --espn`
 *      Fetches settled scores from ESPN's public scoreboard API (NBA, MLB,
 *      Tennis, UFC) and resolves Moneyline outcomes automatically. No API key
 *      or manual CSV input needed.
 *
 * Resolution order: CSV wins if a playId match exists, then ESPN/live.
 *
 * Result vocabulary: the snapshot stores the canonical `win | loss | push`
 * form. Because the metrics engine (computeBacktestMetrics) expects
 * `won | lost | push`, downstream consumers map `win`->`won`, `loss`->`lost`
 * when feeding the engine. A helper `toEngineResult` is exported for that.
 *
 * Usage (CLI):
 *   node scripts/resolve-outcomes.js --csv results.csv
 *   node scripts/resolve-outcomes.js --csv results.csv --in data/snapshots.jsonl
 *   node scripts/resolve-outcomes.js --live            # requires liveGetPlayResult
 *   node scripts/resolve-outcomes.js --espn             # automated ESPN resolution
 *
 * Library:
 *   const { resolveOutcomes } = require('./resolve-outcomes');
 *   await resolveOutcomes({ inFile, resultsCsv, liveGetPlayResult });
 */

const fs = require('node:fs');

const { SNAPSHOT_FILE } = require('./daily-snapshot');

const VALID = new Set(['win', 'loss', 'push']);

/** Map snapshot canonical result -> metrics-engine result. */
function toEngineResult(result) {
  if (result === 'win') return 'won';
  if (result === 'loss') return 'lost';
  return 'push';
}

/**
 * Parse a minimal CSV (header row + lines). Supports comma and simple quote
 * handling. Returns array of row objects keyed by header columns.
 */
function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length < headers.length && cells.every((c) => c.trim() === '')) continue;
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cells[idx] != null ? cells[idx].trim() : '';
    });
    rows.push(obj);
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Build a lookup map playId -> { result, odds?, stake? } from CSV text.
 */
function csvToResultMap(text) {
  const rows = parseCsv(text);
  const map = new Map();
  for (const r of rows) {
    const id = String(r.playid || r.play_id || r.id || '').trim();
    const res = String(r.result || '')
      .trim()
      .toLowerCase();
    if (!id || !VALID.has(res)) continue;
    const entry = { result: res };
    if (r.odds !== undefined && r.odds !== '') entry.odds = Number(r.odds);
    if (r.stake !== undefined && r.stake !== '') entry.stake = Number(r.stake);
    map.set(id, entry);
  }
  return map;
}

/**
 * Resolve outcomes for a snapshot ledger.
 *
 * @param {Object} [opts]
 * @param {string}   [opts.inFile]          - jsonl path (default data/snapshots.jsonl)
 * @param {string}   [opts.resultsCsv]      - path to CSV (playId,result[,odds,stake])
 * @param {Function} [opts.liveGetPlayResult] - async (play)=> 'win'|'loss'|'push'|null
 * @param {boolean}  [opts.live]            - attempt live resolution
 * @param {boolean}  [opts.dryRun]          - don't write back
 * @returns {Promise<{resolved:number, alreadyResolved:number, unresolved:number, rows:Array}>}
 */
async function resolveOutcomes(opts = {}) {
  const inFile = opts.inFile || SNAPSHOT_FILE;
  if (!fs.existsSync(inFile)) {
    throw new Error(`Snapshot file not found: ${inFile}`);
  }

  const lines = fs
    .readFileSync(inFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const csvMap = opts.resultsCsv ? csvToResultMap(fs.readFileSync(opts.resultsCsv, 'utf8')) : null;
  const useLive = Boolean(opts.live) && typeof opts.liveGetPlayResult === 'function';
  const useEspn = Boolean(opts.espn);

  // Lazy-load the ESPN resolver only when --espn is passed
  let espnResolver = null;
  if (useEspn) {
    espnResolver = require('../lib/propprofessor-espn-resolver');
  }

  const rows = [];
  let resolved = 0;
  let alreadyResolved = 0;
  let unresolved = 0;

  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      rows.push(line);
      continue;
    }

    if (rec.result && VALID.has(String(rec.result).toLowerCase())) {
      alreadyResolved++;
      rows.push(JSON.stringify(rec));
      continue;
    }

    let outcome = null;
    // 1) CSV lookup
    if (csvMap && csvMap.has(rec.playId)) {
      outcome = csvMap.get(rec.playId);
    }
    // 2) Live lookup
    if (!outcome && useLive) {
      const live = await opts.liveGetPlayResult(rec);
      if (live && VALID.has(String(live).toLowerCase())) {
        outcome = { result: String(live).toLowerCase() };
      }
    }
    // 3) ESPN auto-resolution
    if (!outcome && useEspn && espnResolver) {
      const espnResult = await espnResolver.getPlayResult(rec);
      if (espnResult && VALID.has(String(espnResult).toLowerCase())) {
        outcome = { result: String(espnResult).toLowerCase() };
      }
    }

    if (outcome) {
      rec.result = outcome.result;
      rec.resolvedAt = new Date().toISOString();
      if (outcome.odds != null && rec.odds == null) rec.odds = outcome.odds;
      if (outcome.stake != null && rec.stake == null) rec.stake = outcome.stake;
      resolved++;
    } else {
      unresolved++;
    }
    rows.push(JSON.stringify(rec));
  }

  if (!opts.dryRun) {
    fs.writeFileSync(inFile, rows.join('\n') + (rows.length ? '\n' : ''), 'utf8');
  }

  return { resolved, alreadyResolved, unresolved, rows: rows.map((r) => JSON.parse(r)) };
}

/**
 * Convert a resolved snapshot ledger into the play array the metrics engine
 * expects: [{ odds, stake, result: 'won'|'lost'|'push' }], filtered to plays
 * that have a result.
 */
function ledgerToPlays(rows) {
  return rows
    .filter((r) => r && r.result && VALID.has(String(r.result).toLowerCase()))
    .map((r) => ({
      odds: r.odds != null ? Number(r.odds) : -110,
      stake: r.stake != null ? Number(r.stake) : 100,
      result: toEngineResult(String(r.result).toLowerCase())
    }));
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
  const csvPath = typeof flags.csv === 'string' ? flags.csv : null;
  const useEspn = Boolean(flags.espn);
  if (!csvPath && !flags.live && !useEspn) {
    console.error('resolve-outcomes: provide --csv <path.csv>, --live, or --espn.');
    process.exit(2);
  }
  const result = await resolveOutcomes({
    inFile: typeof flags.in === 'string' ? flags.in : undefined,
    resultsCsv: csvPath,
    live: Boolean(flags.live),
    espn: useEspn
  });
  console.log(
    `resolve-outcomes: resolved ${result.resolved}, already resolved ${result.alreadyResolved}, ` +
      `unresolved ${result.unresolved}.`
  );
  return result;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`resolve-outcomes failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  resolveOutcomes,
  ledgerToPlays,
  toEngineResult,
  parseCsv,
  csvToResultMap
};
