'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const claimsScript = path.join(repoRoot, 'scripts/check-claims.js');

// Minimal stand-ins so scripts/check-claims.js can run fully offline against a
// fixture directory: one tool definition, one OpenAPI path, and a deterministic
// synthetic backtest whose tier ordering satisfies the TIER 4 <= TIER 2 claim.
const TOOL_DEFS_STUB = `'use strict';\nmodule.exports = { buildToolDefinitions: () => [{ name: 'quick_screen' }] };\n`;
const BACKTEST_STUB = `'use strict';\nmodule.exports = {\n  runBacktest: () => ({\n    results: {\n      'TIER 1': { wins: 60, losses: 40 },\n      'TIER 2': { wins: 20, losses: 20 },\n      'TIER 3': { wins: 10, losses: 10 },\n      'TIER 4': { wins: 5, losses: 5 }\n    }\n  }),\n  setRandomSeed: () => {},\n  resetRandomSeed: () => {}\n};\n`;

function makeFixture(readme) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-claims-'));
  for (const sub of ['lib', 'docs', 'scripts']) {
    fs.mkdirSync(path.join(dir, sub));
  }
  fs.writeFileSync(path.join(dir, 'lib/propprofessor-tool-definitions.js'), TOOL_DEFS_STUB);
  fs.writeFileSync(path.join(dir, 'docs/openapi.json'), JSON.stringify({ paths: { '/quick_screen': {} } }));
  fs.writeFileSync(path.join(dir, 'scripts/backtest-synthetic.js'), BACKTEST_STUB);
  fs.writeFileSync(path.join(dir, 'README.md'), readme);
  return dir;
}

function runClaims(dir) {
  return spawnSync(process.execPath, [claimsScript], { cwd: dir, encoding: 'utf8' });
}

test('check-claims passes when README has no exact test-count claim (non-volatile wording)', (t) => {
  const dir = makeFixture(
    ['## Available Tools', '', '- `quick_screen` — screens a game quickly', '', '1 tool to rule them all.', ''].join(
      '\n'
    )
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runClaims(dir);
  const combined = result.stdout + result.stderr;
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}\n${combined}`);
  assert.match(combined, /No exact test-count claim/);
  // The fixture has no package.json, so a stray `npm test` invocation would
  // fail the run and exit 1. Exit 0 proves the checker skipped npm test when
  // there was no count claim to verify against.
  assert.doesNotMatch(combined, /npm test/);
});

test('check-claims still fails on tool-count drift', (t) => {
  const dir = makeFixture(
    ['## Available Tools', '', '- `quick_screen` — screens a game quickly', '', '2 tools to rule them all.', ''].join(
      '\n'
    )
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runClaims(dir);
  const combined = result.stdout + result.stderr;
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}\n${combined}`);
  assert.match(combined, /README claims 2 tools/);
});
