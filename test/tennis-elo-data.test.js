'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  parseMatchCsv,
  importMatchData,
  loadSnapshot,
  resolvePlayer,
  normalizeName
} = require('../lib/tennis-elo-data');

const HEADER = ['date', 'tour', 'surface', 'winner', 'loser', 'status'].join(',');

// The real engine (lib/tennis-elo.js) is a parallel deliverable and may not be
// present yet; the integration test below skips instead of failing when absent.
let realEngineAvailable = false;
try {
  require('../lib/tennis-elo');
  realEngineAvailable = true;
} catch {
  realEngineAvailable = false;
}

const MATCH_ROWS = [
  '2026-07-01,ATP,hard,"Williams, Serena","Navratilova, Martina",completed',
  '2026-07-02,WTA,clay,"Swiatek, Iga","Sabalenka, Aryna",completed',
  '2026-07-03,ATP,grass,"Djokovic, Novak","Alcaraz, Carlos",completed'
];

function csv(rows) {
  return [HEADER, ...rows].join('\r\n');
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Deterministic stand-in for the tennis-elo engine (lib/tennis-elo.js is being
// built in parallel). Winner +10 / loser -10 from a 1500 seed; Djokovic gets
// explicit aliases so the alias-index path is exercised.
function syntheticBuilder(rows) {
  const players = { ATP: {}, WTA: {} };
  for (const row of rows) {
    const tour = row.tour.trim().toUpperCase();
    const pool = players[tour] || (players[tour] = {});
    for (const side of ['winner', 'loser']) {
      const key = normalizeName(row[side]);
      if (!pool[key]) {
        pool[key] = { name: row[side], overall: 1500, hard: 1500, clay: 1500, grass: 1500, matches: 0 };
      }
      pool[key].matches += 1;
    }
    pool[normalizeName(row.winner)].overall += 10;
    pool[normalizeName(row.loser)].overall -= 10;
  }
  const djokovic = players.ATP && players.ATP[normalizeName('Djokovic, Novak')];
  if (djokovic) djokovic.aliases = ['Djokovic', 'Nole'];
  return { players, constants: { k: 32, seed: 1500 } };
}

function importOptions(dir, extra) {
  return Object.assign(
    {
      inputPath: path.join(dir, 'matches.csv'),
      outputPath: path.join(dir, 'nested', 'snapshot.json'),
      sourceUrl: 'https://example.invalid/tennis-results.csv',
      license: 'CC-BY-4.0 (user-verified)',
      asOf: '2026-07-31',
      importedAt: '2026-08-01T00:00:00.000Z',
      modelVersion: 'tennis-elo-test@1.0.0',
      buildRatingsImpl: syntheticBuilder
    },
    extra || {}
  );
}

function writeInput(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const content = csv(rows);
  fs.writeFileSync(path.join(dir, 'matches.csv'), content);
  return content;
}

describe('tennis-elo-data', () => {
  let tmpRoot;
  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tennis-elo-data-'));
  });
  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('parseMatchCsv', () => {
    it('parses CRLF CSV with quoted names containing commas', () => {
      const matches = parseMatchCsv(csv(MATCH_ROWS));
      assert.equal(matches.length, 3);
      const first = matches[0];
      assert.equal(first.date, '2026-07-01');
      assert.equal(first.tour, 'ATP');
      assert.equal(first.surface, 'hard');
      assert.equal(first.winner, 'Williams, Serena');
      assert.equal(first.loser, 'Navratilova, Martina');
      assert.equal(first.status, 'completed');
      assert.equal(first.rowNumber, 2);
    });

    it('parses LF-only line endings', () => {
      const matches = parseMatchCsv([HEADER, ...MATCH_ROWS].join('\n'));
      assert.equal(matches.length, 3);
      assert.equal(matches[2].rowNumber, 4);
    });

    it('parses escaped double quotes inside quoted fields', () => {
      const matches = parseMatchCsv(csv(['2026-07-01,ATP,hard,"McDonald ""Macca"" John","Smith, Bob",completed']));
      assert.equal(matches[0].winner, 'McDonald "Macca" John');
    });

    it('parses a quoted field containing a newline and reports the row start line', () => {
      const matches = parseMatchCsv(csv(['2026-07-01,ATP,hard,"Williams,\nSerena","Navratilova, Martina",completed']));
      assert.equal(matches.length, 1);
      assert.equal(matches[0].winner, 'Williams,\nSerena');
      assert.equal(matches[0].rowNumber, 2);
    });

    it('strips a UTF-8 BOM from the header', () => {
      const matches = parseMatchCsv(`\uFEFF${csv(MATCH_ROWS)}`);
      assert.equal(matches.length, 3);
    });

    it('skips blank lines', () => {
      const matches = parseMatchCsv(csv(['', '2026-07-01,ATP,hard,A,B,completed', '', '']));
      assert.equal(matches.length, 1);
      assert.equal(matches[0].rowNumber, 3);
    });

    it('accepts a header-only CSV and returns no matches', () => {
      assert.deepEqual(parseMatchCsv(csv([])), []);
    });

    it('rejects empty input with an actionable header error', () => {
      assert.throws(() => parseMatchCsv(''), /header/i);
      assert.throws(() => parseMatchCsv('\r\n'), /column/i);
    });

    it('rejects a missing required column and names it', () => {
      const badHeader = 'date,tour,surface,winner,loser';
      assert.throws(() => parseMatchCsv(`${badHeader}\r\n2026-07-01,ATP,hard,A,B`), /surface/);
      assert.throws(
        () => parseMatchCsv(`${badHeader}\r\n2026-07-01,ATP,hard,A,B`),
        /date, tour, surface, winner, loser, status/
      );
    });

    it('rejects duplicate header columns', () => {
      assert.throws(
        () => parseMatchCsv('date,date,surface,winner,loser,status\r\n2026-07-01,ATP,hard,A,B,completed'),
        /duplicate/i
      );
    });

    it('rejects a row with the wrong field count and reports the line', () => {
      assert.throws(() => parseMatchCsv(csv(['2026-07-01,ATP,hard,A,B'])), /line 2/i);
      assert.throws(() => parseMatchCsv(csv(['2026-07-01,ATP,hard,A,B,completed,EXTRA'])), /line 2/i);
    });

    it('rejects an unterminated quoted field with a line number', () => {
      assert.throws(() => parseMatchCsv(csv(['2026-07-01,ATP,hard,"Williams,Serena'])), /unterminated/i);
      assert.throws(() => parseMatchCsv(csv(['2026-07-01,ATP,hard,"Williams,Serena'])), /line 2/i);
    });

    it('rejects a quote inside an unquoted field', () => {
      assert.throws(() => parseMatchCsv(csv(['2026-07-01,ATP,hard,Will"iams,B,completed'])), /quote/i);
    });

    it('rejects an empty required cell with column and line', () => {
      assert.throws(() => parseMatchCsv(csv(['2026-07-01,ATP,,A,B,completed'])), /surface/);
      assert.throws(() => parseMatchCsv(csv(['2026-07-01,ATP,,A,B,completed'])), /line 2/);
    });

    it('rejects a row where winner equals loser', () => {
      assert.throws(
        () => parseMatchCsv(csv(['2026-07-01,ATP,hard,"Self, Sam","Self, Sam",completed'])),
        /same player/i
      );
    });
  });

  describe('normalizeName', () => {
    it('uppercases, collapses whitespace, and strips combining accents', () => {
      assert.equal(normalizeName('André  Agassi'), 'ANDRE AGASSI');
      assert.equal(normalizeName('  novak   djokovic '), 'NOVAK DJOKOVIC');
      assert.equal(normalizeName('Sergio García'), 'SERGIO GARCIA');
    });
  });

  describe('importMatchData', () => {
    it('writes a snapshot whose manifest carries full provenance and a real SHA-256', () => {
      const dir = path.join(tmpRoot, 'provenance');
      writeInput(dir, MATCH_ROWS);
      const snapshot = importMatchData(importOptions(dir));

      const onDisk = JSON.parse(
        fs.readFileSync(snapshot.manifest.sourcePath.replace('matches.csv', 'nested/snapshot.json'), 'utf8')
      );
      assert.deepEqual(onDisk, snapshot);
      assert.equal(snapshot.schemaVersion, 1);
      assert.equal(snapshot.modelVersion, 'tennis-elo-test@1.0.0');

      const m = snapshot.manifest;
      assert.equal(m.sourcePath, path.join(dir, 'matches.csv'));
      assert.equal(m.sourceUrl, 'https://example.invalid/tennis-results.csv');
      assert.equal(m.license, 'CC-BY-4.0 (user-verified)');
      assert.equal(m.asOf, '2026-07-31');
      assert.equal(m.importedAt, '2026-08-01T00:00:00.000Z');
      assert.equal(m.modelVersion, 'tennis-elo-test@1.0.0');
      assert.equal(m.sha256, fileSha256(path.join(dir, 'matches.csv')));
      assert.equal(m.rowCount, 3);
      assert.equal(m.matchCount, 3);
      assert.equal(m.playerCount, 6);
    });

    it('creates parent directories and leaves no temp files behind (atomic write)', () => {
      const dir = path.join(tmpRoot, 'atomic');
      writeInput(dir, MATCH_ROWS);
      const outputPath = path.join(dir, 'deep', 'nested', 'snapshot.json');
      importMatchData(importOptions(dir, { outputPath }));
      assert.ok(fs.existsSync(outputPath));
      const entries = fs.readdirSync(path.dirname(outputPath));
      assert.deepEqual(entries, ['snapshot.json']);
    });

    it('records the builder-reported matchCount separately from parsed rowCount', () => {
      const dir = path.join(tmpRoot, 'matchcount');
      writeInput(dir, MATCH_ROWS);
      const snapshot = importMatchData(
        importOptions(dir, {
          buildRatingsImpl: () => ({ players: { ATP: {}, WTA: {} }, matchCount: 2 })
        })
      );
      assert.equal(snapshot.manifest.rowCount, 3);
      assert.equal(snapshot.manifest.matchCount, 2);
      assert.equal(snapshot.manifest.playerCount, 0);
    });

    it('never modifies the input file', () => {
      const dir = path.join(tmpRoot, 'input-unchanged');
      writeInput(dir, MATCH_ROWS);
      const inputPath = path.join(dir, 'matches.csv');
      const beforeHash = fileSha256(inputPath);
      const beforeBytes = fs.readFileSync(inputPath);
      importMatchData(importOptions(dir));
      assert.equal(fileSha256(inputPath), beforeHash);
      assert.deepEqual(fs.readFileSync(inputPath), beforeBytes);
    });

    it('writes no implicit timestamps into the manifest (only explicit importedAt/asOf)', () => {
      const dir = path.join(tmpRoot, 'no-clock');
      writeInput(dir, MATCH_ROWS);
      const snapshot = importMatchData(importOptions(dir));
      assert.deepEqual(
        Object.keys(snapshot.manifest).sort(),
        [
          'asOf',
          'generator',
          'importedAt',
          'license',
          'matchCount',
          'modelVersion',
          'playerCount',
          'rowCount',
          'schemaVersion',
          'sha256',
          'sourcePath',
          'sourceUrl'
        ].sort()
      );
      assert.deepEqual(
        Object.keys(snapshot).sort(),
        ['aliasIndex', 'engine', 'manifest', 'modelVersion', 'players', 'schemaVersion'].sort()
      );
    });

    it('records the explicitly supplied importedAt verbatim', () => {
      const dir = path.join(tmpRoot, 'imported-at');
      writeInput(dir, MATCH_ROWS);
      const snapshot = importMatchData(importOptions(dir, { importedAt: '2026-08-02T03:04:05.000Z' }));
      assert.equal(snapshot.manifest.importedAt, '2026-08-02T03:04:05.000Z');
    });

    it('rejects missing required options with actionable errors', () => {
      const dir = path.join(tmpRoot, 'rejections');
      writeInput(dir, MATCH_ROWS);
      const base = importOptions(dir);
      assert.throws(() => importMatchData({ ...base, importedAt: undefined }), /importedAt/);
      assert.throws(() => importMatchData({ ...base, importedAt: '' }), /importedAt/);
      assert.throws(() => importMatchData({ ...base, license: undefined }), /license/);
      assert.throws(() => importMatchData({ ...base, asOf: undefined }), /asOf/);
      assert.throws(() => importMatchData({ ...base, modelVersion: undefined }), /modelVersion/);
      assert.throws(() => importMatchData({ ...base, inputPath: undefined }), /inputPath/);
      assert.throws(() => importMatchData({ ...base, outputPath: undefined }), /outputPath/);
      assert.throws(() => importMatchData(null), /options/);
    });

    it('rejects rows dated after asOf (future-leaking rows) with a line number', () => {
      const dir = path.join(tmpRoot, 'future');
      writeInput(dir, ['2027-01-01,ATP,hard,A,B,completed']);
      assert.throws(() => importMatchData(importOptions(dir, { asOf: '2026-12-31' })), /future/i);
      assert.throws(() => importMatchData(importOptions(dir, { asOf: '2026-12-31' })), /line 2/);
    });

    it('rejects non-ISO row dates and non-ISO asOf', () => {
      const dir = path.join(tmpRoot, 'bad-dates');
      writeInput(dir, ['2026/07/01,ATP,hard,A,B,completed']);
      assert.throws(() => importMatchData(importOptions(dir)), /YYYY-MM-DD/);

      const dir2 = path.join(tmpRoot, 'bad-asof');
      writeInput(dir2, MATCH_ROWS);
      assert.throws(() => importMatchData(importOptions(dir2, { asOf: '31/07/2026' })), /asOf/);
    });

    it('builds the alias index from engine-provided aliases (import -> load -> resolve)', () => {
      const dir = path.join(tmpRoot, 'engine-alias');
      writeInput(dir, MATCH_ROWS);
      importMatchData(importOptions(dir));
      const loaded = loadSnapshot(path.join(dir, 'nested', 'snapshot.json'));
      assert.equal(loaded.available, true);
      const exact = resolvePlayer(loaded.snapshot, { tour: 'ATP', name: 'djokovic, novak' });
      assert.equal(exact.available, true);
      assert.equal(exact.matchedBy, 'exact_name');
      const alias = resolvePlayer(loaded.snapshot, { tour: 'ATP', name: 'Nole' });
      assert.equal(alias.available, true);
      assert.equal(alias.matchedBy, 'alias');
      assert.equal(alias.id, 'DJOKOVIC, NOVAK');
    });

    it('merges caller-supplied aliases into the snapshot alias index', () => {
      const dir = path.join(tmpRoot, 'option-alias');
      writeInput(dir, MATCH_ROWS);
      const snapshot = importMatchData(importOptions(dir, { aliases: { ATP: { 'The Joker': 'Djokovic, Novak' } } }));
      assert.deepEqual(snapshot.aliasIndex.ATP['THE JOKER'], ['DJOKOVIC, NOVAK']);
      const resolved = resolvePlayer(snapshot, { tour: 'ATP', name: 'the joker' });
      assert.equal(resolved.available, true);
      assert.equal(resolved.matchedBy, 'alias');
      assert.equal(resolved.id, 'DJOKOVIC, NOVAK');
    });

    it('rejects an alias option that points at an unknown player', () => {
      const dir = path.join(tmpRoot, 'dangling-alias');
      writeInput(dir, MATCH_ROWS);
      assert.throws(
        () => importMatchData(importOptions(dir, { aliases: { ATP: { Ghost: 'Nobody, N. ' } } })),
        /alias/i
      );
    });

    it('records ambiguous aliases and the resolver reports them as ambiguous', () => {
      const dir = path.join(tmpRoot, 'ambiguous-import');
      writeInput(dir, ['2026-07-01,ATP,hard,John Smith,Jane Smith,completed']);
      const twoSmiths = () => ({
        players: {
          ATP: {
            'JOHN SMITH': { name: 'John Smith', aliases: ['Smith'] },
            'JANE SMITH': { name: 'Jane Smith', aliases: ['Smith'] }
          }
        }
      });
      const snapshot = importMatchData(importOptions(dir, { buildRatingsImpl: twoSmiths }));
      assert.deepEqual(snapshot.aliasIndex.ATP.SMITH, ['JOHN SMITH', 'JANE SMITH']);
      const resolved = resolvePlayer(snapshot, { tour: 'ATP', name: 'Smith' });
      assert.equal(resolved.available, false);
      assert.equal(resolved.reason, 'ambiguous');
      assert.deepEqual(resolved.candidates, ['JOHN SMITH', 'JANE SMITH']);
    });

    it('keeps ATP and WTA pools separate in the snapshot', () => {
      const dir = path.join(tmpRoot, 'isolation');
      writeInput(dir, MATCH_ROWS);
      const snapshot = importMatchData(importOptions(dir));
      assert.ok(snapshot.players.ATP['DJOKOVIC, NOVAK']);
      assert.ok(snapshot.players.WTA['SWIATEK, IGA']);
      assert.equal(snapshot.players.ATP['SWIATEK, IGA'], undefined);
      assert.equal(snapshot.players.WTA['DJOKOVIC, NOVAK'], undefined);
    });

    it('rejects engine output without a players map', () => {
      const dir = path.join(tmpRoot, 'bad-engine');
      writeInput(dir, MATCH_ROWS);
      assert.throws(() => importMatchData(importOptions(dir, { buildRatingsImpl: () => null })), /players/);
    });

    it('rejects two players whose names normalize to the same key', () => {
      const dir = path.join(tmpRoot, 'dup-names');
      writeInput(dir, ['2026-07-01,ATP,hard,A,B,completed']);
      const dupBuilder = () => ({
        players: { ATP: { 'JOHN SMITH': { name: 'John Smith' }, 'JOHN  SMITH': { name: 'john  smith' } } }
      });
      assert.throws(() => importMatchData(importOptions(dir, { buildRatingsImpl: dupBuilder })), /same name/i);
    });

    it('defaults to the real lib/tennis-elo engine when no builder is injected', { skip: !realEngineAvailable }, () => {
      const dir = path.join(tmpRoot, 'real-engine');
      writeInput(dir, MATCH_ROWS);
      const opts = importOptions(dir);
      delete opts.buildRatingsImpl;
      const snapshot = importMatchData(opts);
      assert.equal(snapshot.manifest.rowCount, 3);
      assert.equal(snapshot.manifest.matchCount, 3);
      assert.equal(snapshot.manifest.sha256, fileSha256(path.join(dir, 'matches.csv')));
      assert.ok(snapshot.players.ATP['DJOKOVIC, NOVAK']);
      assert.ok(snapshot.players.WTA['SWIATEK, IGA']);
      assert.ok(snapshot.engine && snapshot.engine.constants);
      const loaded = loadSnapshot(opts.outputPath);
      assert.equal(loaded.available, true);
      const resolved = resolvePlayer(loaded.snapshot, { tour: 'ATP', name: 'Djokovic, Novak' });
      assert.equal(resolved.available, true);
      assert.equal(resolved.matchedBy, 'exact_name');
    });
  });

  describe('loadSnapshot', () => {
    it('returns a safe not_found result for a missing file (no throw)', () => {
      const result = loadSnapshot(path.join(tmpRoot, 'does-not-exist.json'));
      assert.equal(result.available, false);
      assert.equal(result.reason, 'not_found');
    });

    it('returns a safe invalid result for corrupt JSON (no throw)', () => {
      const badPath = path.join(tmpRoot, 'corrupt.json');
      fs.writeFileSync(badPath, '{ not json !!!');
      const result = loadSnapshot(badPath);
      assert.equal(result.available, false);
      assert.equal(result.reason, 'invalid');
      assert.match(result.error, /JSON/i);
    });

    it('returns invalid for JSON that is not a snapshot shape', () => {
      const badPath = path.join(tmpRoot, 'wrong-shape.json');
      fs.writeFileSync(badPath, JSON.stringify({ hello: 'world' }));
      const result = loadSnapshot(badPath);
      assert.equal(result.available, false);
      assert.equal(result.reason, 'invalid');
    });

    it('returns invalid without throwing when the path is a directory', () => {
      const result = loadSnapshot(tmpRoot);
      assert.equal(result.available, false);
      assert.equal(result.reason, 'invalid');
    });

    it('loads a valid snapshot written by importMatchData', () => {
      const dir = path.join(tmpRoot, 'roundtrip');
      writeInput(dir, MATCH_ROWS);
      importMatchData(importOptions(dir));
      const result = loadSnapshot(path.join(dir, 'nested', 'snapshot.json'));
      assert.equal(result.available, true);
      assert.equal(result.snapshot.manifest.rowCount, 3);
      assert.ok(result.snapshot.players.ATP['DJOKOVIC, NOVAK']);
    });

    it('honors an explicit pathOverride over PP_TENNIS_ELO_SNAPSHOT', () => {
      const dir = path.join(tmpRoot, 'override-beats-env');
      writeInput(dir, MATCH_ROWS);
      importMatchData(importOptions(dir));
      const validPath = path.join(dir, 'nested', 'snapshot.json');
      const prev = process.env.PP_TENNIS_ELO_SNAPSHOT;
      process.env.PP_TENNIS_ELO_SNAPSHOT = path.join(tmpRoot, 'missing.json');
      try {
        const result = loadSnapshot(validPath);
        assert.equal(result.available, true);
      } finally {
        if (prev === undefined) delete process.env.PP_TENNIS_ELO_SNAPSHOT;
        else process.env.PP_TENNIS_ELO_SNAPSHOT = prev;
      }
    });

    it('respects the PP_TENNIS_ELO_SNAPSHOT env override when no path is given', () => {
      const dir = path.join(tmpRoot, 'env-only');
      writeInput(dir, MATCH_ROWS);
      importMatchData(importOptions(dir));
      const validPath = path.join(dir, 'nested', 'snapshot.json');
      const prev = process.env.PP_TENNIS_ELO_SNAPSHOT;
      process.env.PP_TENNIS_ELO_SNAPSHOT = validPath;
      try {
        const result = loadSnapshot();
        assert.equal(result.available, true);
        assert.equal(result.path, validPath);
      } finally {
        if (prev === undefined) delete process.env.PP_TENNIS_ELO_SNAPSHOT;
        else process.env.PP_TENNIS_ELO_SNAPSHOT = prev;
      }
    });

    it('defaults to ~/.propprofessor/tennis-elo-snapshot.json without throwing', () => {
      const prev = process.env.PP_TENNIS_ELO_SNAPSHOT;
      delete process.env.PP_TENNIS_ELO_SNAPSHOT;
      try {
        const result = loadSnapshot();
        assert.equal(typeof result.available, 'boolean');
        assert.ok(result.path.endsWith(path.join('.propprofessor', 'tennis-elo-snapshot.json')));
      } finally {
        if (prev === undefined) delete process.env.PP_TENNIS_ELO_SNAPSHOT;
        else process.env.PP_TENNIS_ELO_SNAPSHOT = prev;
      }
    });
  });

  describe('resolvePlayer', () => {
    function makeSnapshot() {
      return {
        schemaVersion: 1,
        players: {
          ATP: {
            'ANDRE AGASSI': { name: 'André Agassi', overall: 1600 },
            'JOHN SMITH': { name: 'John Smith', overall: 1500 },
            'JANE SMITH': { name: 'Jane Smith', overall: 1400 }
          },
          WTA: {
            'ANDRE AGASSI': { name: 'Andre Agassi (WTA)', overall: 1450 },
            'SERENA WILLIAMS': { name: 'Serena Williams', overall: 1800 }
          }
        },
        aliasIndex: {
          ATP: {
            SMITH: ['JOHN SMITH', 'JANE SMITH'],
            NOLE: ['ANDRE AGASSI']
          },
          WTA: {
            WILLIAMS: ['SERENA WILLIAMS']
          }
        }
      };
    }

    it('resolves an exact full name with case/whitespace/accent-insensitive normalization', () => {
      const result = resolvePlayer(makeSnapshot(), { tour: 'ATP', name: 'andre  agassi' });
      assert.equal(result.available, true);
      assert.equal(result.matchedBy, 'exact_name');
      assert.equal(result.id, 'ANDRE AGASSI');
      assert.equal(result.name, 'André Agassi');
    });

    it('matches an unaccented query against an accented stored name', () => {
      const result = resolvePlayer(makeSnapshot(), { tour: 'ATP', name: 'Andre Agassi' });
      assert.equal(result.available, true);
      assert.equal(result.id, 'ANDRE AGASSI');
    });

    it('resolves a unique explicit alias', () => {
      const result = resolvePlayer(makeSnapshot(), { tour: 'ATP', name: 'Nole' });
      assert.equal(result.available, true);
      assert.equal(result.matchedBy, 'alias');
      assert.equal(result.id, 'ANDRE AGASSI');
    });

    it('returns ambiguous for an alias shared by multiple players', () => {
      const result = resolvePlayer(makeSnapshot(), { tour: 'ATP', name: 'Smith' });
      assert.equal(result.available, false);
      assert.equal(result.reason, 'ambiguous');
      assert.deepEqual(result.candidates, ['JOHN SMITH', 'JANE SMITH']);
    });

    it('never guesses a surname-only lookup without an explicit unique alias', () => {
      const result = resolvePlayer(makeSnapshot(), { tour: 'ATP', name: 'Agassi' });
      assert.equal(result.available, false);
      assert.equal(result.reason, 'unknown_player');
    });

    it('returns unknown_player for an unknown name', () => {
      const result = resolvePlayer(makeSnapshot(), { tour: 'ATP', name: 'Roger Federer' });
      assert.equal(result.available, false);
      assert.equal(result.reason, 'unknown_player');
    });

    it('returns unknown_player for an empty or whitespace name', () => {
      assert.equal(resolvePlayer(makeSnapshot(), { tour: 'ATP', name: '' }).reason, 'unknown_player');
      assert.equal(resolvePlayer(makeSnapshot(), { tour: 'ATP', name: '   ' }).reason, 'unknown_player');
    });

    it('keeps ATP and WTA pools isolated even for identical normalized names', () => {
      const atp = resolvePlayer(makeSnapshot(), { tour: 'ATP', name: 'Andre Agassi' });
      const wta = resolvePlayer(makeSnapshot(), { tour: 'WTA', name: 'Andre Agassi' });
      assert.equal(atp.available, true);
      assert.equal(atp.name, 'André Agassi');
      assert.equal(wta.available, true);
      assert.equal(wta.name, 'Andre Agassi (WTA)');
    });

    it('does not leak a WTA-only player into an ATP lookup', () => {
      const result = resolvePlayer(makeSnapshot(), { tour: 'ATP', name: 'Serena Williams' });
      assert.equal(result.available, false);
      assert.equal(result.reason, 'unknown_player');
    });

    it('returns unknown_tour for a tour with no pool', () => {
      const result = resolvePlayer(makeSnapshot(), { tour: 'ITF', name: 'Andre Agassi' });
      assert.equal(result.available, false);
      assert.equal(result.reason, 'unknown_tour');
    });

    it('accepts a lowercase tour', () => {
      const result = resolvePlayer(makeSnapshot(), { tour: 'atp', name: 'Andre Agassi' });
      assert.equal(result.available, true);
    });

    it('returns missing_snapshot when no snapshot is provided', () => {
      const result = resolvePlayer(null, { tour: 'ATP', name: 'Andre Agassi' });
      assert.equal(result.available, false);
      assert.equal(result.reason, 'missing_snapshot');
      assert.equal(resolvePlayer({}, { tour: 'ATP', name: 'x' }).reason, 'missing_snapshot');
    });
  });
});
