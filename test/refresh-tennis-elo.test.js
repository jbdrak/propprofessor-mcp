'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const CLI = path.join(__dirname, '..', 'scripts', 'refresh-tennis-elo.js');
const HEADER = 'date,tour,surface,winner,loser,status';

// Rows: 5 input rows, 4 processed by the engine (walkover is skipped).
// 6 ATP players + 2 WTA players = 8 players (the WTA walkover row is skipped).
const MATCH_ROWS = [
  '2026-07-01,ATP,hard,"Williams, Serena","Navratilova, Martina",completed',
  '2026-07-02,WTA,clay,"Swiatek, Iga","Sabalenka, Aryna",finished',
  '2026-07-03,ATP,grass,"Djokovic, Novak","Alcaraz, Carlos",final',
  '2026-07-04,WTA,hard,"Gauff, Coco","Pegula, Jessica",walkover',
  '2026-07-05,ATP,clay,"Zverev, Alexander","Ruud, Casper",ended'
];

const BASE_ARGS = [
  '--input',
  '<INPUT>',
  '--license',
  'CC BY-NC-SA 4.0 (user-verified)',
  '--as-of',
  '2026-07-31',
  '--imported-at',
  '2026-08-01T00:00:00.000Z',
  '--model-version',
  'tennis-elo@1.1.0'
];

function csv(rows) {
  return [HEADER, ...rows].join('\r\n');
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runCli(args, options) {
  const opts = options || {};
  const env = Object.assign({}, process.env, { HOME: opts.home, USERPROFILE: opts.home });
  delete env.PP_TENNIS_ELO_SNAPSHOT;
  return spawnSync(process.execPath, [CLI].concat(args), {
    encoding: 'utf8',
    env,
    cwd: opts.cwd || opts.home
  });
}

function writeCsv(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const content = csv(rows);
  const inputPath = path.join(dir, 'matches.csv');
  fs.writeFileSync(inputPath, content);
  return { inputPath, content };
}

function argsFor(inputPath) {
  return BASE_ARGS.map((arg) => (arg === '<INPUT>' ? inputPath : arg));
}

let tmpRoot;

function freshHome(name) {
  const dir = path.join(tmpRoot, `home-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('refresh-tennis-elo CLI', () => {
  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-tennis-elo-'));
  });
  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('--help prints usage and exits 0', () => {
    const result = runCli(['--help'], { home: freshHome('help') });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--dry-run/);
    assert.match(result.stdout, /--aliases/);
    assert.match(result.stdout, /--model-version/);
  });

  it('exits 0 quietly when stdout is closed early (EPIPE, e.g. `--help | head`)', async () => {
    // Reproduces `node scripts/refresh-tennis-elo.js --help | head`: the
    // downstream consumer closes stdout while the CLI is still writing, so the
    // write fails with EPIPE. Destroying the read end immediately after spawn
    // guarantees the child's write lands after the pipe is closed — no shell,
    // no sleep, no flaky timing.
    const child = spawn(process.execPath, [CLI, '--help'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.destroy();

    const { status, stderr } = await new Promise((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('CLI did not exit after stdout was closed'));
      }, 10000);
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      child.on('error', (spawnErr) => {
        clearTimeout(timer);
        reject(spawnErr);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ status: code, stderr: err });
      });
    });

    assert.equal(status, 0, `expected clean exit 0 on EPIPE, got ${status}; stderr: ${stderr}`);
    assert.doesNotMatch(stderr, /Error:|at Object\.|at Module\.|EPIPE/, 'EPIPE must not surface as a stack trace');
  });

  it('exits 1 with an actionable message when required options are missing', () => {
    const result = runCli([], { home: freshHome('t') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing required option/);
    for (const flag of ['--input', '--license', '--as-of', '--imported-at', '--model-version']) {
      assert.match(result.stderr, new RegExp(flag.replace(/[-]/g, '\\-')));
    }
    // No stack dump by default.
    assert.doesNotMatch(result.stderr, /at Object\.|at Module\.|Error: /);
  });

  it('names the specific missing flag when only one is absent', () => {
    const { inputPath } = writeCsv(path.join(tmpRoot, 'missing-license'), MATCH_ROWS);
    const args = argsFor(inputPath).filter((arg, i, arr) => arg !== '--license' && arr[i - 1] !== '--license');
    const result = runCli(args, { home: freshHome('t') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--license/);
  });

  it('rejects unknown options with a usage hint', () => {
    const result = runCli(['--bogus'], { home: freshHome('t') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option "--bogus"/);
    assert.match(result.stderr, /--help/);
  });

  it('exits 1 when the input CSV does not exist', () => {
    const args = argsFor(path.join(tmpRoot, 'nope.csv'));
    const result = runCli(args, { home: freshHome('t') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not found/);
  });

  it('builds a snapshot and prints a JSON summary with all contract fields', () => {
    const dir = path.join(tmpRoot, 'success');
    const { inputPath, content } = writeCsv(dir, MATCH_ROWS);
    const outputPath = path.join(dir, 'nested', 'snapshot.json');
    const result = runCli(argsFor(inputPath).concat(['--output', outputPath]), { home: freshHome('t') });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(outputPath), 'snapshot file should exist');

    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.dryRun, false);
    assert.equal(summary.output, outputPath);
    assert.equal(summary.sha256, fileSha256(inputPath));
    assert.equal(summary.rows, 5);
    assert.equal(summary.matches, 4);
    assert.equal(summary.players, 8);
    assert.equal(summary.asOf, '2026-07-31');
    assert.equal(summary.modelVersion, 'tennis-elo@1.1.0');
    assert.equal(summary.license, 'CC BY-NC-SA 4.0 (user-verified)');

    const snapshot = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(snapshot.manifest.sha256, fileSha256(inputPath));
    assert.equal(snapshot.manifest.rowCount, 5);
    assert.equal(snapshot.manifest.matchCount, 4);
    assert.equal(snapshot.manifest.playerCount, 8);
    assert.equal(snapshot.manifest.asOf, '2026-07-31');
    assert.equal(snapshot.manifest.importedAt, '2026-08-01T00:00:00.000Z');
    assert.equal(snapshot.manifest.license, 'CC BY-NC-SA 4.0 (user-verified)');
    assert.equal(snapshot.manifest.sourceUrl, null);
    assert.equal(snapshot.manifest.sourcePath, inputPath);
    assert.ok(snapshot.players.ATP, 'ATP pool present');
    assert.ok(snapshot.players.WTA, 'WTA pool present');
    assert.equal(Object.keys(snapshot.players.ATP).length, 6);
    assert.equal(Object.keys(snapshot.players.WTA).length, 2);
    assert.equal(content.trim().length > 0, true);
  });

  it('writes to the default ~/.propprofessor path when --output is omitted (HOME redirected)', () => {
    const dir = path.join(tmpRoot, 'default-output');
    const homeDir = freshHome('default');
    const { inputPath } = writeCsv(dir, MATCH_ROWS);
    const result = runCli(argsFor(inputPath), { home: homeDir });

    assert.equal(result.status, 0, result.stderr);
    const defaultPath = path.join(homeDir, '.propprofessor', 'tennis-elo-snapshot.json');
    assert.ok(fs.existsSync(defaultPath), 'default snapshot should exist under HOME');
    const snapshot = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
    assert.equal(snapshot.manifest.playerCount, 8);
  });

  it('--dry-run prints the summary and writes no final output file', () => {
    const dir = path.join(tmpRoot, 'dry-run');
    const { inputPath } = writeCsv(dir, MATCH_ROWS);
    const outputPath = path.join(dir, 'snapshot.json');

    const result = runCli(argsFor(inputPath).concat(['--output', outputPath, '--dry-run']), { home: freshHome('t') });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(outputPath), 'dry-run must not write the final output');
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.output, outputPath, 'summary reports the would-be output');
    assert.equal(summary.rows, 5);
    assert.equal(summary.matches, 4);
    assert.equal(summary.players, 8);
    assert.equal(summary.sha256, fileSha256(inputPath));
  });

  it('--dry-run with no --output touches nothing under HOME', () => {
    const dir = path.join(tmpRoot, 'dry-run-home');
    const homeDir = freshHome('dryrun-home');
    const { inputPath } = writeCsv(dir, MATCH_ROWS);
    const result = runCli(argsFor(inputPath).concat(['--dry-run']), { home: homeDir });

    assert.equal(result.status, 0, result.stderr);
    const entries = fs.readdirSync(homeDir);
    assert.deepEqual(entries, [], 'dry-run with default output must not create ~/.propprofessor');
  });

  it('records --source-url in the manifest', () => {
    const dir = path.join(tmpRoot, 'source-url');
    const { inputPath } = writeCsv(dir, MATCH_ROWS);
    const outputPath = path.join(dir, 'snapshot.json');
    const result = runCli(
      argsFor(inputPath).concat(['--source-url', 'https://example.invalid/tennis.csv', '--output', outputPath]),
      { home: freshHome('source-url') }
    );
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(snapshot.manifest.sourceUrl, 'https://example.invalid/tennis.csv');
  });

  it('applies an --aliases JSON file and embeds the alias index', () => {
    const dir = path.join(tmpRoot, 'aliases');
    const { inputPath } = writeCsv(dir, MATCH_ROWS);
    const aliasesPath = path.join(dir, 'aliases.json');
    fs.writeFileSync(aliasesPath, JSON.stringify({ ATP: { Nole: 'Djokovic, Novak' } }));
    const outputPath = path.join(dir, 'snapshot.json');
    const result = runCli(argsFor(inputPath).concat(['--aliases', aliasesPath, '--output', outputPath]), {
      home: freshHome('aliases')
    });
    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const nole = snapshot.aliasIndex.ATP['NOLE'];
    assert.ok(Array.isArray(nole) && nole.includes('DJOKOVIC, NOVAK'), 'alias should resolve to normalized name');
  });

  it('exits 1 when an alias target is not a known player', () => {
    const dir = path.join(tmpRoot, 'aliases-bad');
    const { inputPath } = writeCsv(dir, MATCH_ROWS);
    const aliasesPath = path.join(dir, 'aliases.json');
    fs.writeFileSync(aliasesPath, JSON.stringify({ ATP: { Nole: 'Nobody, Nobody' } }));
    const result = runCli(argsFor(inputPath).concat(['--aliases', aliasesPath]), { home: freshHome('t') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown player/i);
  });

  it('exits 1 with an actionable message for an unparseable aliases file', () => {
    const dir = path.join(tmpRoot, 'aliases-json');
    const { inputPath } = writeCsv(dir, MATCH_ROWS);
    const aliasesPath = path.join(dir, 'aliases.json');
    fs.writeFileSync(aliasesPath, '{ not json');
    const result = runCli(argsFor(inputPath).concat(['--aliases', aliasesPath]), { home: freshHome('t') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(aliasesPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(result.stderr, /not valid JSON/i);
  });

  it('exits 1 on a CSV missing a required column', () => {
    const dir = path.join(tmpRoot, 'bad-header');
    fs.mkdirSync(dir, { recursive: true });
    const inputPath = path.join(dir, 'matches.csv');
    fs.writeFileSync(inputPath, 'date,tour,surface,winner,loser\n2026-07-01,ATP,hard,A,B\n');
    const result = runCli(argsFor(inputPath), { home: freshHome('t') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /status/);
    assert.match(result.stderr, /missing required column/i);
  });

  it('exits 1 on a malformed date', () => {
    const dir = path.join(tmpRoot, 'bad-date');
    const { inputPath } = writeCsv(dir, ['2026/07/01,ATP,hard,"Williams, Serena","Navratilova, Martina",completed']);
    const result = runCli(argsFor(inputPath), { home: freshHome('t') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /YYYY-MM-DD/);
  });

  it('exits 1 on a future-leaking row (date after asOf)', () => {
    const dir = path.join(tmpRoot, 'future-leak');
    const { inputPath } = writeCsv(dir, ['2026-08-05,ATP,hard,"Williams, Serena","Navratilova, Martina",completed']);
    const result = runCli(argsFor(inputPath), { home: freshHome('t') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /after asOf|future/i);
  });

  it('exits 1 when winner equals loser', () => {
    const dir = path.join(tmpRoot, 'same-player');
    const { inputPath } = writeCsv(dir, ['2026-07-01,ATP,hard,"Williams, Serena","Williams, Serena",completed']);
    const result = runCli(argsFor(inputPath), { home: freshHome('t') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /same player/i);
  });

  it('rejects a non-ISO --as-of value', () => {
    const dir = path.join(tmpRoot, 'bad-asof');
    const { inputPath } = writeCsv(dir, MATCH_ROWS);
    const withBadAsOf = argsFor(inputPath).map((arg, i, arr) => (arr[i - 1] === '--as-of' ? '07/31/2026' : arg));
    const result = runCli(withBadAsOf, { home: freshHome('bad-asof') });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--as-of/);
  });
});
