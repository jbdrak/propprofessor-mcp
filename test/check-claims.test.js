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
// fixture directory: N tool definitions, N OpenAPI paths, and a deterministic
// synthetic backtest whose tier ordering satisfies the TIER 4 <= TIER 2 claim.
function toolDefsStub(names) {
  return `'use strict';\nmodule.exports = { buildToolDefinitions: () => ${JSON.stringify(
    names.map((n) => ({ name: n }))
  )} };\n`;
}

const BACKTEST_STUB = `'use strict';\nmodule.exports = {\n  runBacktest: () => ({\n    results: {\n      'TIER 1': { wins: 60, losses: 40 },\n      'TIER 2': { wins: 20, losses: 20 },\n      'TIER 3': { wins: 10, losses: 10 },\n      'TIER 4': { wins: 5, losses: 5 }\n    }\n  }),\n  setRandomSeed: () => {},\n  resetRandomSeed: () => {}\n};\n`;

// A clean README that satisfies the tool-count, tool-name, and non-volatile
// test-count checks for a fixture with `n` registered tools.
function cleanReadme(n = 1) {
  return [
    '## Available Tools',
    '',
    '- `quick_screen` — screens a game quickly',
    '',
    `${n} tool${n === 1 ? '' : 's'} across the MCP surface.`,
    ''
  ].join('\n');
}

// A supported-versions table with the given first (current) row.
function securityTable(currentRow) {
  return [
    '# Security Policy',
    '',
    '## Supported Versions',
    '',
    '| Version | Supported |',
    '| ------- | --------- |',
    currentRow,
    '| 2.8.x   | Yes — receives security fixes |',
    '| 2.7.x   | Security fixes only           |',
    '| < 2.7   | No — please upgrade           |',
    ''
  ].join('\n');
}

function makeFixture(readme, opts = {}) {
  const { toolNames = ['quick_screen'], packageVersion, files = {} } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-claims-'));
  for (const sub of ['lib', 'docs', 'scripts', '.github']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'lib/propprofessor-tool-definitions.js'), toolDefsStub(toolNames));
  fs.writeFileSync(
    path.join(dir, 'docs/openapi.json'),
    JSON.stringify({ paths: Object.fromEntries(toolNames.map((n) => ['/' + n, {}])) })
  );
  fs.writeFileSync(path.join(dir, 'scripts/backtest-synthetic.js'), BACKTEST_STUB);
  fs.writeFileSync(path.join(dir, 'README.md'), readme);
  if (packageVersion) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: packageVersion }));
  }
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

function runClaims(dir, extraArgs = []) {
  return spawnSync(process.execPath, [claimsScript, ...extraArgs], { cwd: dir, encoding: 'utf8' });
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

// ---------------------------------------------------------------------------
// Active-doc drift scan: live `sharp_plays` guidance
// ---------------------------------------------------------------------------

const ACTIVE_DOC_PATHS = [
  'README.md',
  'docs/METHODOLOGY.md',
  'docs/AGENT_PROMPT.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  '.github/PULL_REQUEST_TEMPLATE.md'
];

for (const rel of ACTIVE_DOC_PATHS) {
  test(`fails when ${rel} carries live sharp_plays guidance`, (t) => {
    const readme = cleanReadme(1) + '\nRun `sharp_plays` on demand.\n';
    const files = rel === 'README.md' ? {} : { [rel]: 'Run `sharp_plays` on demand.\n' };
    const dir = makeFixture(readme, { files });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const result = runClaims(dir);
    const combined = result.stdout + result.stderr;
    assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}\n${combined}`);
    assert.match(combined, /sharp_plays/);
  });
}

test('historical archives (CHANGELOG.md, docs/RELEASES.md) are exempt from the active-doc scan', (t) => {
  const dir = makeFixture(cleanReadme(1), {
    files: {
      'CHANGELOG.md': '## 2.8.0\n- Run `sharp_plays` (966 tests, 27 MCP tools) — historical notes.\n',
      'docs/RELEASES.md': '# Releases\n\n2.7.0: Run `sharp_plays` with (966 tests) and 27 MCP tools.\n'
    }
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runClaims(dir);
  const combined = result.stdout + result.stderr;
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}\n${combined}`);
  assert.match(combined, /exempt/);
});

// ---------------------------------------------------------------------------
// Active-doc drift scan: stale tool-count claims
// ---------------------------------------------------------------------------

test('fails on a stale tool-count claim in docs/METHODOLOGY.md', (t) => {
  const dir = makeFixture(cleanReadme(1), {
    files: { 'docs/METHODOLOGY.md': 'After all 5 steps, the play is exposed via 27 MCP tools with a rationale.\n' }
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runClaims(dir);
  const combined = result.stdout + result.stderr;
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}\n${combined}`);
  assert.match(combined, /27 MCP tools/);
});

// ---------------------------------------------------------------------------
// Active-doc drift scan: stale current version (SECURITY.md vs package.json)
// ---------------------------------------------------------------------------

test('fails when SECURITY.md supported-versions table is stale vs package.json', (t) => {
  const dir = makeFixture(cleanReadme(1), {
    packageVersion: '2.9.1',
    files: { 'SECURITY.md': securityTable('| 2.1.x   | Yes — current release |') }
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runClaims(dir);
  const combined = result.stdout + result.stderr;
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}\n${combined}`);
  assert.match(combined, /2\.9\.1/);
  assert.match(combined, /current release/);
});

// ---------------------------------------------------------------------------
// Active-doc drift scan: hardcoded volatile test totals
// ---------------------------------------------------------------------------

test('fails on a hardcoded test total in the PR template', (t) => {
  const dir = makeFixture(cleanReadme(1), {
    files: { '.github/PULL_REQUEST_TEMPLATE.md': '- [ ] `npm test` (966 tests)\n' }
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runClaims(dir);
  const combined = result.stdout + result.stderr;
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}\n${combined}`);
  assert.match(combined, /966/);
});

test('fails on a hardcoded qualified test total in README', (t) => {
  const dir = makeFixture(cleanReadme(1) + '\nThe pipeline is built and tested (8 pipeline tests, 0 fail).\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runClaims(dir);
  const combined = result.stdout + result.stderr;
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}\n${combined}`);
  assert.match(combined, /8 pipeline tests/);
});

// ---------------------------------------------------------------------------
// Active-doc drift scan: false full-suite-auth claim
// ---------------------------------------------------------------------------

test('fails on a false full-suite-auth claim in CONTRIBUTING.md', (t) => {
  const dir = makeFixture(cleanReadme(1), {
    files: { 'CONTRIBUTING.md': '4. **Full suite:** `npm test` (slower, needs auth)\n' }
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runClaims(dir);
  const combined = result.stdout + result.stderr;
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}\n${combined}`);
  assert.match(combined, /needs auth/);
});

test('smoke-test auth guidance is not treated as a full-suite-auth claim', (t) => {
  const dir = makeFixture(cleanReadme(1), {
    files: {
      'CONTRIBUTING.md': '- Smoke tests: use `pp-query doctor` or individual MCP tools manually (requires auth)\n'
    }
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runClaims(dir);
  const combined = result.stdout + result.stderr;
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}\n${combined}`);
});

// ---------------------------------------------------------------------------
// Clean multi-doc fixture (the "repaired repo" simulation)
// ---------------------------------------------------------------------------

test('passes when all active docs are clean and archives carry historical drift', (t) => {
  const dir = makeFixture(cleanReadme(31), {
    toolNames: Array.from({ length: 31 }, (_, i) => (i === 0 ? 'quick_screen' : `tool_${i}`)),
    packageVersion: '2.9.1',
    files: {
      'docs/METHODOLOGY.md': 'After all 5 steps, the play is exposed via 31 MCP tools with a rationale.\n',
      'docs/AGENT_PROMPT.md': [
        '- `quick_screen({mode: \'sharp\'})` only returns a "Bet candidate" when a non-target sharp book confirms.\n',
        '- `full` (default): all 31 tools\n',
        '| `live` | `is_live` | 13 tools — backend still uses `is_live` on the wire |\n'
      ].join(''),
      'docs/HERMES_SKILL.md':
        '**quick_screen**\nThe fastest way to find playable bets. Equivalent to sharp_plays + player_context bundled.\n',
      'SECURITY.md': securityTable('| 2.9.x   | Yes — current release |'),
      'CONTRIBUTING.md':
        '4. **Full suite:** `npm test` (full deterministic suite — offline, no auth needed)\n' +
        '- Smoke tests: use `pp-query doctor` or individual MCP tools manually (requires auth)\n',
      '.github/PULL_REQUEST_TEMPLATE.md': '- [ ] `npm test` (full suite)\n',
      'CHANGELOG.md': '## 2.8.0\n- Run `sharp_plays` (966 tests, 27 MCP tools) — historical notes.\n',
      'docs/RELEASES.md': '# Releases\n\n2.7.0: sharp_plays, 966 tests, 27 MCP tools.\n'
    }
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runClaims(dir);
  const combined = result.stdout + result.stderr;
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}\n${combined}`);
});

test('quick mode still runs the active-doc drift checks', (t) => {
  const dir = makeFixture(cleanReadme(1) + '\nRun `sharp_plays` on demand.\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = runClaims(dir, ['--quick']);
  const combined = result.stdout + result.stderr;
  assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}\n${combined}`);
  assert.match(combined, /sharp_plays/);
});
