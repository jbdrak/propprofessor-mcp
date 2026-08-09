'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ledger = require('../lib/record-ledger');

function createFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const directories = new Set();
  const operations = [];

  return {
    files,
    directories,
    operations,
    existsSync(filePath) {
      return files.has(filePath);
    },
    readFileSync(filePath, encoding) {
      if (!files.has(filePath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const value = files.get(filePath);
      return encoding ? value : Buffer.from(value);
    },
    mkdirSync(directory, options) {
      directories.add(directory);
      operations.push(['mkdir', directory, options]);
    },
    writeFileSync(filePath, content) {
      files.set(filePath, String(content));
      operations.push(['write', filePath]);
    },
    openSync(filePath) {
      operations.push(['open', filePath]);
      return filePath;
    },
    fsyncSync(fileHandle) {
      operations.push(['fsync', fileHandle]);
    },
    closeSync(fileHandle) {
      operations.push(['close', fileHandle]);
    },
    renameSync(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
      operations.push(['rename', from, to]);
    }
  };
}

describe('record-ledger', () => {
  it('resolves the default path and honors PP_RECORD_LEDGER', () => {
    const original = process.env.PP_RECORD_LEDGER;
    try {
      delete process.env.PP_RECORD_LEDGER;
      assert.equal(
        ledger.defaultLedgerPath(),
        path.join(require('node:os').homedir(), '.propprofessor', 'tracker', 'ledger.json')
      );
      process.env.PP_RECORD_LEDGER = '/tmp/custom-ledger.json';
      assert.equal(ledger.defaultLedgerPath(), '/tmp/custom-ledger.json');
    } finally {
      if (original === undefined) delete process.env.PP_RECORD_LEDGER;
      else process.env.PP_RECORD_LEDGER = original;
    }
  });

  it('creates schema defaults as a fresh ledger', () => {
    const first = ledger.createLedger();
    const second = ledger.createLedger();
    assert.deepEqual(first, { version: 2, scans: [], candidates: [], bets: [], settlements: [] });
    assert.notStrictEqual(first.scans, second.scans);
  });

  it('validates valid and invalid ledger structures', () => {
    assert.deepEqual(ledger.validateLedger(ledger.createLedger()), { ok: true });
    const result = ledger.validateLedger({ version: 1, scans: {}, candidates: [], bets: null });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('version')));
    assert.ok(result.errors.some((error) => error.includes('scans')));
    assert.ok(result.errors.some((error) => error.includes('bets')));
    assert.ok(!result.errors.some((error) => error.includes('undefined')));
  });

  it('loads a first-run ledger when the file is missing', () => {
    const fs = createFakeFs();
    const result = ledger.loadLedger({ fs, path: '/virtual/ledger.json' });
    assert.deepEqual(result, { ok: true, ledger: ledger.createLedger(), path: '/virtual/ledger.json' });
  });

  it('round-trips a ledger through the injected filesystem', () => {
    const fs = createFakeFs();
    const filePath = '/virtual/tracker/ledger.json';
    const input = ledger.createLedger();
    input.scans.push({ id: 'scan-1', source: 'test' });
    assert.deepEqual(ledger.saveLedger(input, { fs, path: filePath }), { ok: true, path: filePath });
    const result = ledger.loadLedger({ fs, path: filePath });
    assert.deepEqual(result, { ok: true, ledger: input, path: filePath });
  });

  it('returns redacted errors for invalid JSON and invalid schemas', () => {
    const invalidJson = '{"apiKey":"sk-live-secret",';
    const fs = createFakeFs({
      '/virtual/bad.json': invalidJson,
      '/virtual/schema.json': JSON.stringify({ version: 1, apiKey: 'sk-live-secret' })
    });
    const jsonResult = ledger.loadLedger({ fs, path: '/virtual/bad.json' });
    assert.equal(jsonResult.ok, false);
    assert.ok(!jsonResult.error.includes(invalidJson));
    assert.ok(!jsonResult.error.includes('sk-live-secret'));
    const schemaResult = ledger.loadLedger({ fs, path: '/virtual/schema.json' });
    assert.equal(schemaResult.ok, false);
    assert.ok(!schemaResult.error.includes('sk-live-secret'));
  });

  it('saves atomically with a same-directory temporary file and no leftover', () => {
    const fs = createFakeFs();
    const filePath = '/virtual/tracker/ledger.json';
    const result = ledger.saveLedger(ledger.createLedger(), { fs, path: filePath });
    assert.equal(result.ok, true);
    assert.equal(fs.files.has(filePath), true);
    assert.equal(
      fs.operations.some(([operation]) => operation === 'rename'),
      true
    );
    const rename = fs.operations.find(([operation]) => operation === 'rename');
    assert.equal(path.dirname(rename[1]), path.dirname(filePath));
    assert.equal(fs.files.size, 1);
    assert.equal(
      fs.operations.some(([operation]) => operation === 'fsync'),
      true
    );
  });

  it('computes deterministic ids and detects duplicates', () => {
    const firstLedger = ledger.createLedger();
    const first = ledger.addRecord(
      firstLedger,
      'scans',
      { sport: 'soccer', count: 3 },
      { now: () => '2026-01-01T00:00:00.000Z' }
    );
    const second = ledger.addRecord(
      firstLedger,
      'scans',
      { sport: 'soccer', count: 3 },
      { now: () => '2026-01-02T00:00:00.000Z' }
    );
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.id, second.id);
    assert.equal(second.duplicate, true);
    assert.equal(firstLedger.scans.length, 1);
  });

  it('adds a record with an injected timestamp', () => {
    const result = ledger.addRecord(
      ledger.createLedger(),
      'bets',
      { selection: 'A' },
      { now: () => '2026-02-03T04:05:06.000Z' }
    );
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.record.createdAt, '2026-02-03T04:05:06.000Z');
    assert.equal(result.record.id, result.id);
  });

  it('finds a record using a safe copy', () => {
    const current = ledger.createLedger();
    const added = ledger.addRecord(current, 'candidates', { nested: { value: 1 } });
    const found = ledger.findRecord(current, 'candidates', added.id);
    found.nested.value = 9;
    assert.equal(current.candidates[0].nested.value, 1);
    assert.equal(ledger.findRecord(current, 'candidates', 'missing'), undefined);
  });

  it('reports duplicate official bet and settlement identities', () => {
    const current = ledger.createLedger();
    current.bets.push({ id: 'bet-1' }, { id: 'bet-1' });
    current.settlements.push({ betId: 'bet-1' }, { betId: 'bet-1' });
    const result = ledger.validateLedgerIntegrity(current);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 2);
    assert.match(result.errors[0], /duplicate id/);
    assert.match(result.errors[1], /duplicate betId/);
  });
});
