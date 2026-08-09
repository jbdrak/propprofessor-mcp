'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const pathModule = require('node:path');

const COLLECTIONS = ['scans', 'candidates', 'bets', 'settlements'];

function defaultLedgerPath() {
  return process.env.PP_RECORD_LEDGER || pathModule.join(os.homedir(), '.propprofessor', 'tracker', 'ledger.json');
}

function createLedger() {
  return { version: 2, scans: [], candidates: [], bets: [], settlements: [] };
}

function redact(text) {
  return String(text).replace(
    /(["']?)([a-z][\w-]*(?:api|token|key|secret|password|cookie|auth|credential)[\w-]*)(\1)\s*[:=]\s*([^,}\s]+)/gi,
    '$1$2$3: [REDACTED]'
  );
}

function errorMessage(action, error) {
  return redact(`${action}: ${error && error.code ? error.code : 'operation failed'}`);
}

function validateLedger(ledger) {
  const errors = [];
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return { ok: false, errors: ['ledger must be an object'] };
  }
  if (ledger.version !== 2) errors.push('version must be 2');
  for (const collection of COLLECTIONS) {
    if (!Array.isArray(ledger[collection])) errors.push(`${collection} must be an array`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

function validateLedgerIntegrity(ledger) {
  const errors = [];
  const duplicateIds = (records, field, label) => {
    const seen = new Set();
    for (const record of records || []) {
      const value = record && record[field];
      if (!value) continue;
      if (seen.has(value)) errors.push(`${label} contains duplicate ${field}: ${value}`);
      seen.add(value);
    }
  };
  duplicateIds(ledger && ledger.bets, 'id', 'bets');
  duplicateIds(ledger && ledger.settlements, 'betId', 'settlements');
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

function resolveOptions(opts = {}) {
  return { fs: opts.fs || fs, path: opts.path || defaultLedgerPath(), now: opts.now };
}

function loadLedger(opts = {}) {
  const options = resolveOptions(opts);
  let content;
  try {
    content = options.fs.readFileSync(options.path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, ledger: createLedger(), path: options.path };
    return { ok: false, error: errorMessage('Unable to read ledger', error) };
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: 'Unable to parse ledger: invalid JSON' };
  }
  const ledger = { ...createLedger(), ...parsed };
  const validation = validateLedger(ledger);
  if (!validation.ok) return { ok: false, error: `Invalid ledger schema: ${validation.errors.join('; ')}` };
  return { ok: true, ledger, path: options.path };
}

function saveLedger(ledger, opts = {}) {
  const options = resolveOptions(opts);
  const validation = validateLedger(ledger);
  if (!validation.ok) return { ok: false, error: `Invalid ledger schema: ${validation.errors.join('; ')}` };
  const directory = pathModule.dirname(options.path);
  const temporaryPath = `${options.path}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    options.fs.mkdirSync(directory, { recursive: true });
    options.fs.writeFileSync(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    if (
      typeof options.fs.openSync === 'function' &&
      typeof options.fs.fsyncSync === 'function' &&
      typeof options.fs.closeSync === 'function'
    ) {
      const handle = options.fs.openSync(temporaryPath, 'r');
      try {
        options.fs.fsyncSync(handle);
      } finally {
        options.fs.closeSync(handle);
      }
    }
    options.fs.renameSync(temporaryPath, options.path);
    return { ok: true, path: options.path };
  } catch (error) {
    try {
      if (
        typeof options.fs.existsSync === 'function' &&
        options.fs.existsSync(temporaryPath) &&
        typeof options.fs.unlinkSync === 'function'
      )
        options.fs.unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup must not hide the original save failure.
    }
    return { ok: false, error: errorMessage('Unable to save ledger', error) };
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object')
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  return value;
}

function addRecord(ledger, kind, record, opts = {}) {
  if (!COLLECTIONS.includes(kind)) return { ok: false, error: 'Invalid record collection' };
  const collection = ledger[kind];
  // Hash all own fields canonically, excluding generated fields, so key order cannot change the id.
  const source = { ...record };
  delete source.id;
  delete source.createdAt;
  const id =
    record.id ||
    crypto
      .createHash('sha256')
      .update(JSON.stringify(canonicalize(source)))
      .digest('hex');
  const existing = collection.find((item) => item && item.id === id);
  if (existing) return { ok: true, duplicate: true, id, record: clone(existing) };
  const createdAt = typeof opts.now === 'function' ? opts.now() : new Date().toISOString();
  const result = { ...record, id, createdAt };
  collection.push(result);
  return { ok: true, duplicate: false, id, record: clone(result) };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function findRecord(ledger, kind, id) {
  if (!COLLECTIONS.includes(kind)) return undefined;
  const record = ledger[kind].find((item) => item && item.id === id);
  return record === undefined ? undefined : clone(record);
}

module.exports = {
  defaultLedgerPath,
  createLedger,
  validateLedger,
  validateLedgerIntegrity,
  loadLedger,
  saveLedger,
  addRecord,
  findRecord
};
