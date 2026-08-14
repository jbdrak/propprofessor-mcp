'use strict';

// lib/tennis-elo-data.js — manual, local, license-aware Elo snapshot importer
// and exact player resolver for the tennis-elo shadow model.
//
// Design rules (see docs/plans/2026-08-14-reliability-evaluation-tennis-elo.md):
// - No network access, no downloads, no bundled third-party data. The importer
//   only reads a user-supplied CSV and writes a JSON snapshot.
// - No implicit clocks: every timestamp in the manifest (importedAt, asOf) must
//   be supplied explicitly by the caller. This module never reads the clock.
// - Player resolution is exact: normalized full names or explicitly declared
//   unique aliases only. No fuzzy matching, no guessed surnames.
//
// Engine contract (lib/tennis-elo.js, built in parallel):
//   buildRatings(rows, { asOf, modelVersion }) -> {
//     players: { ATP: { "<normalized name>": { name, aliases?, overall?, ... } }, WTA: {...} },
//     constants?: {...},
//     matchCount?: number
//   }
// The real engine's native output ({ pools: { atp, wta }, config, summary }) is
// auto-adapted by normalizeBuiltResult(); injected builders may use either
// shape, or the compact contract above.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const REQUIRED_COLUMNS = ['date', 'tour', 'surface', 'winner', 'loser', 'status'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize a player name for exact matching: NFKD (splits combining marks),
 * strip diacritics, collapse whitespace, uppercase.
 */
function normalizeName(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function normalizeTour(value) {
  return String(value).trim().toUpperCase();
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`importMatchData: ${name} is required (non-empty string).`);
  }
}

// --- CSV -------------------------------------------------------------------

/**
 * Parse CSV text into rows of { cells, line }. RFC-4180-ish: quoted fields with
 * "" escapes, embedded commas/newlines inside quotes, CRLF / CR / LF endings.
 */
function parseCsvRows(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let quoteStartLine = 0;
  let line = 1;
  let currentRowLine = 1;
  let i = 0;
  const n = text.length;
  const pushRow = () => {
    rows.push({ cells: row, line: currentRowLine });
    row = [];
    field = '';
  };
  const endLine = () => {
    pushRow();
    line += 1;
    currentRowLine = line;
  };
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1;
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field.length > 0) {
        throw new Error(`CSV line ${line}: quote character inside an unquoted field`);
      }
      inQuotes = true;
      quoteStartLine = line;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      row.push(field);
      const isCrlf = text[i + 1] === '\n';
      endLine();
      i += isCrlf ? 2 : 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      endLine();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) {
    throw new Error(`CSV: unterminated quoted field starting at line ${quoteStartLine}`);
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push({ cells: row, line: currentRowLine });
  }
  return rows;
}

/**
 * Parse match CSV text into row objects. A header row with the required columns
 * is mandatory. Malformed input (bad quoting, wrong field counts, empty required
 * cells, winner == loser) is rejected with line-numbered, actionable errors.
 */
function parseMatchCsv(text, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const requiredColumns = options.requiredColumns || REQUIRED_COLUMNS;
  if (!Array.isArray(requiredColumns) || requiredColumns.length === 0) {
    throw new TypeError('parseMatchCsv: requiredColumns must be a non-empty array of column names');
  }
  if (text == null) {
    throw new TypeError('parseMatchCsv: CSV text is required');
  }
  const source = typeof text === 'string' ? text : String(text);
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const rows = parseCsvRows(withoutBom);
  if (rows.length === 0) {
    throw new Error(`CSV is empty: a header row with columns ${requiredColumns.join(', ')} is required`);
  }

  const header = rows[0].cells.map((cell) => cell.trim().toLowerCase());
  if (new Set(header).size !== header.length) {
    throw new Error(`CSV header contains duplicate column name(s): ${header.join(', ')}`);
  }
  const missing = requiredColumns.filter((col) => !header.includes(col));
  if (missing.length > 0) {
    throw new Error(
      `CSV header is missing required column(s): ${missing.join(', ')}. Expected columns: ${requiredColumns.join(', ')}.`
    );
  }

  const columnIndex = {};
  for (const col of requiredColumns) columnIndex[col] = header.indexOf(col);

  const matches = [];
  for (let r = 1; r < rows.length; r += 1) {
    const { cells, line } = rows[r];
    if (cells.every((cell) => cell.trim() === '')) continue;
    if (cells.length !== header.length) {
      throw new Error(
        `CSV line ${line}: expected ${header.length} fields but found ${cells.length}. Fix or remove this row.`
      );
    }
    const values = {};
    for (const col of requiredColumns) values[col] = cells[columnIndex[col]];
    for (const col of requiredColumns) {
      if (values[col].trim() === '') {
        throw new Error(`CSV line ${line}: required column "${col}" is empty.`);
      }
    }
    if (normalizeName(values.winner) === normalizeName(values.loser)) {
      throw new Error(`CSV line ${line}: winner and loser are the same player ("${values.winner}").`);
    }
    matches.push({
      date: values.date,
      tour: values.tour,
      surface: values.surface,
      winner: values.winner,
      loser: values.loser,
      status: values.status,
      rowNumber: line
    });
  }
  return matches;
}

// --- Snapshot building ------------------------------------------------------

function buildAliasIndex(pool) {
  const index = {};
  for (const [key, player] of Object.entries(pool)) {
    const aliases = Array.isArray(player.aliases) ? player.aliases : [];
    for (const alias of aliases) {
      if (typeof alias !== 'string' || alias.trim() === '') continue;
      const normalized = normalizeName(alias);
      if (!index[normalized]) index[normalized] = [];
      if (!index[normalized].includes(key)) index[normalized].push(key);
    }
  }
  return index;
}

function mergeOptionAliases(players, aliasIndex, aliases) {
  if (aliases == null) return;
  if (typeof aliases !== 'object' || Array.isArray(aliases)) {
    throw new Error(
      'importMatchData: aliases must be an object keyed by tour (e.g. { ATP: { "Nole": "Novak Djokovic" } })'
    );
  }
  for (const [rawTour, tourAliases] of Object.entries(aliases)) {
    if (tourAliases == null) continue;
    if (typeof tourAliases !== 'object' || Array.isArray(tourAliases)) {
      throw new Error(`importMatchData: aliases for tour "${rawTour}" must be an object mapping alias -> player name.`);
    }
    const tour = normalizeTour(rawTour);
    const pool = players[tour];
    const index = (aliasIndex[tour] = aliasIndex[tour] || {});
    for (const [alias, target] of Object.entries(tourAliases)) {
      const normalized = normalizeName(alias);
      const targetKey = normalizeName(target);
      if (!pool || !pool[targetKey]) {
        throw new Error(
          `importMatchData: alias "${alias}" (tour ${tour}) points to unknown player "${target}". ` +
            'Alias targets must exactly match a player name present in the built ratings.'
        );
      }
      if (!index[normalized]) index[normalized] = [];
      if (!index[normalized].includes(targetKey)) index[normalized].push(targetKey);
    }
  }
}

function buildSnapshot(rows, built, meta) {
  if (!built || typeof built !== 'object' || !built.players || typeof built.players !== 'object') {
    throw new Error(
      'importMatchData: buildRatingsImpl must return { players: { ATP: {...}, WTA: {...} }, constants? }'
    );
  }
  const players = {};
  const aliasIndex = {};
  let playerCount = 0;
  for (const [rawTour, pool] of Object.entries(built.players)) {
    if (!pool || typeof pool !== 'object') continue;
    const tour = normalizeTour(rawTour);
    const normalizedPool = (players[tour] = players[tour] || {});
    for (const [rawKey, rawPlayer] of Object.entries(pool)) {
      if (!rawPlayer || typeof rawPlayer !== 'object' || Array.isArray(rawPlayer)) continue;
      const displayName = typeof rawPlayer.name === 'string' && rawPlayer.name.length > 0 ? rawPlayer.name : rawKey;
      const key = normalizeName(displayName);
      if (!key) {
        throw new Error(`importMatchData: engine returned a player with an empty name (tour ${tour}).`);
      }
      if (normalizedPool[key]) {
        throw new Error(
          `importMatchData: two ${tour} players normalize to the same name "${displayName}" — add an alias instead of duplicating the name.`
        );
      }
      normalizedPool[key] = { ...rawPlayer, name: displayName };
      playerCount += 1;
    }
    aliasIndex[tour] = buildAliasIndex(normalizedPool);
  }

  mergeOptionAliases(players, aliasIndex, meta.aliases);

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    generator: 'propprofessor-mcp/lib/tennis-elo-data.js',
    sourcePath: meta.inputPath,
    sourceUrl: meta.sourceUrl == null ? null : String(meta.sourceUrl),
    license: meta.license,
    asOf: meta.asOf,
    importedAt: meta.importedAt,
    modelVersion: meta.modelVersion,
    sha256: meta.sha256,
    rowCount: rows.length,
    matchCount: built.matchCount == null ? rows.length : built.matchCount,
    playerCount
  };

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    modelVersion: meta.modelVersion,
    manifest,
    players,
    aliasIndex
  };
  if (built.constants !== undefined) snapshot.engine = { constants: built.constants };
  return snapshot;
}

function writeJsonAtomic(outputPath, value) {
  const directory = path.dirname(outputPath);
  fs.mkdirSync(directory, { recursive: true });
  const tmpPath = path.join(
    directory,
    `.${path.basename(outputPath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  );
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o644);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, outputPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* temp never created or already moved */
    }
    throw err;
  }
}

function loadDefaultEngine(rows, options) {
  let engine;
  try {
    // @ts-ignore — lib/tennis-elo.js is built in parallel; resolved lazily at import time.
    engine = require('./tennis-elo');
  } catch (err) {
    throw new Error(
      `importMatchData: tennis-elo engine (lib/tennis-elo.js) is not available — pass buildRatingsImpl or implement the engine: ${err.message}`,
      { cause: err }
    );
  }
  if (typeof engine.buildRatings !== 'function') {
    throw new Error('importMatchData: lib/tennis-elo.js must export buildRatings(rows, options).');
  }
  return engine.buildRatings(rows, options);
}

/**
 * Accept the compact injected-builder contract ({ players, constants?,
 * matchCount? }) or the real engine's native buildRatings() output
 * ({ pools: { atp, wta }, config, summary }) and normalize to one shape.
 */
function normalizeBuiltResult(built) {
  if (!built || typeof built !== 'object') return built;
  if (built.players && typeof built.players === 'object') return built;
  if (built.pools && typeof built.pools === 'object') {
    const players = {};
    for (const [rawTour, pool] of Object.entries(built.pools)) {
      if (pool && typeof pool === 'object') players[normalizeTour(rawTour)] = pool;
    }
    return {
      players,
      constants: built.config,
      matchCount: built.summary && Number.isFinite(built.summary.processed) ? built.summary.processed : undefined
    };
  }
  return built;
}

/**
 * Import a user-supplied match CSV into a versioned, license-aware JSON snapshot.
 * The input file's exact bytes are SHA-256-hashed into the manifest. The output
 * is written atomically (temp file + rename) with parent directories created.
 * Every manifest timestamp (asOf, importedAt) must be supplied by the caller;
 * this function never reads the clock. No network or bundled data is involved.
 */
function importMatchData(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('importMatchData requires an options object');
  }
  const {
    inputPath,
    outputPath,
    sourceUrl = null,
    license,
    asOf,
    importedAt,
    modelVersion,
    buildRatingsImpl,
    aliases
  } = options;

  requireText(inputPath, 'inputPath');
  requireText(outputPath, 'outputPath');
  requireText(license, 'license');
  requireText(asOf, 'asOf');
  requireText(importedAt, 'importedAt');
  requireText(modelVersion, 'modelVersion');

  const asOfDate = asOf.slice(0, 10);
  if (!DATE_RE.test(asOfDate)) {
    throw new Error(`importMatchData: asOf must be an ISO date (YYYY-MM-DD), got "${asOf}".`);
  }

  const inputBuffer = fs.readFileSync(inputPath);
  const sha256 = crypto.createHash('sha256').update(inputBuffer).digest('hex');
  const rows = parseMatchCsv(inputBuffer.toString('utf8'));

  for (const row of rows) {
    if (!DATE_RE.test(row.date)) {
      throw new Error(`CSV line ${row.rowNumber}: date "${row.date}" is not YYYY-MM-DD.`);
    }
    if (row.date > asOfDate) {
      throw new Error(
        `CSV line ${row.rowNumber}: date "${row.date}" is after asOf "${asOfDate}" (future-leaking row).`
      );
    }
  }

  const builder = typeof buildRatingsImpl === 'function' ? buildRatingsImpl : loadDefaultEngine;
  const built = normalizeBuiltResult(builder(rows, { asOf: asOfDate, modelVersion }));

  const snapshot = buildSnapshot(rows, built, {
    inputPath,
    sourceUrl,
    license,
    asOf: asOfDate,
    importedAt,
    modelVersion,
    sha256,
    aliases
  });

  writeJsonAtomic(outputPath, snapshot);
  return snapshot;
}

// --- Runtime lookup ---------------------------------------------------------

function resolveSnapshotPath(override) {
  if (override !== undefined && override !== null) {
    if (typeof override !== 'string') {
      throw new TypeError('loadSnapshot pathOverride must be a string');
    }
    return override;
  }
  const envPath = process.env.PP_TENNIS_ELO_SNAPSHOT;
  if (typeof envPath === 'string' && envPath.length > 0) return envPath;
  return path.join(os.homedir(), '.propprofessor', 'tennis-elo-snapshot.json');
}

/**
 * Load a snapshot for runtime lookup. Missing or invalid files degrade to a
 * safe { available: false } result instead of throwing.
 */
function loadSnapshot(pathOverride) {
  const snapshotPath = resolveSnapshotPath(pathOverride);
  let raw;
  try {
    raw = fs.readFileSync(snapshotPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { available: false, reason: 'not_found', path: snapshotPath };
    }
    return { available: false, reason: 'invalid', path: snapshotPath, error: err.message };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { available: false, reason: 'invalid', path: snapshotPath, error: `invalid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.players || typeof parsed.players !== 'object') {
    return { available: false, reason: 'invalid', path: snapshotPath, error: 'snapshot is missing its players map' };
  }
  return { available: true, path: snapshotPath, snapshot: parsed };
}

/**
 * Resolve a player name to a snapshot identity. Exact normalized full name
 * first, then a unique explicit alias. Ambiguous aliases, unknown players,
 * unknown tours, and missing snapshots all return explicit unavailable results.
 * Last-name-only queries never resolve unless an explicit unique alias exists.
 */
function resolvePlayer(snapshot, options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('resolvePlayer requires an options object { tour, name }');
  }
  const { tour, name } = options;
  const tourKey = normalizeTour(tour);
  const normalizedName = normalizeName(name);
  const unavailable = (reason, extra) =>
    Object.assign({ available: false, reason, tour: tourKey, name: normalizedName }, extra);

  if (!snapshot || typeof snapshot !== 'object' || !snapshot.players || typeof snapshot.players !== 'object') {
    return unavailable('missing_snapshot');
  }
  if (!tourKey || !snapshot.players[tourKey] || typeof snapshot.players[tourKey] !== 'object') {
    return unavailable('unknown_tour');
  }
  if (!normalizedName) return unavailable('unknown_player');

  const players = snapshot.players[tourKey];
  if (Object.prototype.hasOwnProperty.call(players, normalizedName)) {
    const player = players[normalizedName];
    return {
      available: true,
      tour: tourKey,
      id: normalizedName,
      name: player && typeof player.name === 'string' ? player.name : normalizedName,
      player,
      matchedBy: 'exact_name'
    };
  }

  const index = snapshot.aliasIndex && snapshot.aliasIndex[tourKey];
  const hit = index ? index[normalizedName] : undefined;
  const ids = hit === undefined ? [] : Array.isArray(hit) ? hit : [hit];
  if (ids.length === 0) return unavailable('unknown_player');
  if (ids.length > 1) return unavailable('ambiguous', { candidates: ids.slice() });

  const player = players[ids[0]];
  return {
    available: true,
    tour: tourKey,
    id: ids[0],
    name: player && typeof player.name === 'string' ? player.name : ids[0],
    player,
    matchedBy: 'alias'
  };
}

module.exports = {
  parseMatchCsv,
  importMatchData,
  loadSnapshot,
  resolvePlayer,
  normalizeName
};
