'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectPackageFiles, verify } = require('../scripts/check-package-contents');
const { ALLOWED_DIRTY_PREFIXES, parse, verify: verifyTree } = require('../scripts/check-publish-tree');

test('package content verifier accepts a coherent manifest', () => {
  const failures = verify([
    'package.json',
    'README.md',
    'INSTALL.md',
    'CHANGELOG.md',
    'LICENSE',
    'lib/propprofessor-api.js',
    'bin/pp',
    'scripts/propprofessor-mcp-server.js',
    'scripts/fetch-sofascore.py',
    'docs/agent-guide.md'
  ]);
  assert.deepEqual(failures, []);
});

test('package content parser accepts npm pack JSON array and object shapes', () => {
  const files = [{ path: 'package/package.json' }, { path: 'package/lib/example.js' }];
  assert.deepEqual(collectPackageFiles([{ files }]), ['package.json', 'lib/example.js']);
  assert.deepEqual(collectPackageFiles({ 'propprofessor-mcp@2.9.1': { files } }), ['package.json', 'lib/example.js']);
});

test('package content verifier rejects missing required paths', () => {
  const failures = verify(['package.json', 'README.md']);
  assert.ok(
    failures.some((f) => f.includes('INSTALL.md')),
    'INSTALL.md must be required'
  );
  assert.ok(
    failures.some((f) => f.includes('docs/')),
    'docs/ must be required'
  );
});

test('package content verifier rejects tests, auth data, and scratch scripts', () => {
  const failures = verify([
    'package.json',
    'README.md',
    'INSTALL.md',
    'CHANGELOG.md',
    'LICENSE',
    'lib/',
    'bin/',
    'scripts/',
    'docs/',
    'test/record-settlement.test.js',
    'coverage/lcov.info',
    'backtest-data/2026-08-05.json',
    'auth.json',
    'token-cache.json',
    'scripts/scan-tennis-debug.js',
    'scripts/_scan-nba.js',
    'scripts/check-whatever.js',
    'scripts/novig-scan.js',
    'docs/openapi.json'
  ]);
  assert.ok(failures.some((f) => f.includes('test/record-settlement.test.js')));
  assert.ok(failures.some((f) => f.includes('auth.json')));
  assert.ok(failures.some((f) => f.includes('scripts/scan-tennis-debug.js')));
  assert.ok(failures.some((f) => f.includes('scripts/_scan-nba.js')));
  assert.ok(failures.some((f) => f.includes('scripts/novig-scan.js')));
  assert.ok(failures.some((f) => f.includes('docs/openapi.json')));
});

test('package content verifier rejects the manual-only live smoke diagnostic', () => {
  const failures = verify([
    'package.json',
    'README.md',
    'INSTALL.md',
    'CHANGELOG.md',
    'LICENSE',
    'lib/propprofessor-api.js',
    'bin/pp',
    'scripts/propprofessor-mcp-server.js',
    'scripts/fetch-sofascore.py',
    'docs/agent-guide.md',
    'scripts/live-smoke-all-tools.js'
  ]);
  assert.ok(
    failures.some((f) => f.includes('scripts/live-smoke-all-tools.js')),
    'scripts/live-smoke-all-tools.js must never ship (manual-only live diagnostic)'
  );
});

test('package content verifier accepts a manifest without the live smoke diagnostic', () => {
  const failures = verify([
    'package.json',
    'README.md',
    'INSTALL.md',
    'CHANGELOG.md',
    'LICENSE',
    'lib/propprofessor-api.js',
    'bin/pp',
    'scripts/propprofessor-mcp-server.js',
    'scripts/fetch-sofascore.py',
    'docs/agent-guide.md'
  ]);
  assert.ok(
    !failures.some((f) => f.includes('scripts/live-smoke-all-tools.js')),
    'absence of scripts/live-smoke-all-tools.js must not be flagged'
  );
});

test('publish-tree parser reads porcelain entries', () => {
  const parsed = parse([' M lib/foo.js', '?? lib/record-new.js', 'D  lib/old.js']);
  assert.deepEqual(parsed, [
    { code: ' M', file: 'lib/foo.js' },
    { code: '??', file: 'lib/record-new.js' },
    { code: 'D ', file: 'lib/old.js' }
  ]);
});

test('publish-tree verifier blocks dirty runtime content but allows local artifacts', () => {
  const blocked = verifyTree([
    ' M lib/foo.js',
    '?? lib/record-new.js',
    'M  .hermes/plans/2026-08-05-plan.md',
    '?? docs/cron-prompts/manual.md',
    'D  lib/removed.js'
  ]);
  assert.deepEqual(blocked, [' M lib/foo.js', '?? lib/record-new.js', 'D  lib/removed.js']);
  assert.ok(ALLOWED_DIRTY_PREFIXES.includes('.hermes/'));
});
