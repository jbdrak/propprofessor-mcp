#!/usr/bin/env node
'use strict';

/**
 * Verify that `npm pack --dry-run` would produce a tarball containing the
 * required runtime + docs entries and none of the tests, auth data, local
 * data, or scratch scripts that must never ship.
 *
 * Standalone:  node scripts/check-package-contents.js
 * Testable:    const { verify } = require('./check-package-contents.js')
 */

const { spawnSync } = require('node:child_process');

// Required tarball entries (paths as they appear in the tarball, i.e. the
// `files[].path` values from `npm pack --dry-run --json` with the leading
// "package/" prefix stripped).
const REQUIRED = [
  'package.json',
  'README.md',
  'INSTALL.md',
  'LICENSE',
  'CHANGELOG.md',
  'lib/propprofessor-api.js',
  'bin/pp',
  'scripts/propprofessor-mcp-server.js',
  'scripts/fetch-sofascore.py'
];

// Everything that must never appear in the tarball. "prefix" matches any
// entry under that path, "exact" matches a single entry, "pattern" is a
// regex applied to each entry.
const FORBIDDEN = [
  // tests & fixtures
  { type: 'prefix', value: 'test/' },
  { type: 'pattern', value: /\.test\.js$/ },
  { type: 'pattern', value: /\.test\.py$/ },
  { type: 'pattern', value: /^scripts\/test_install/ },
  // local data / auth / caches
  { type: 'prefix', value: 'data/' },
  { type: 'prefix', value: 'backtest-data/' },
  { type: 'prefix', value: 'coverage/' },
  { type: 'exact', value: 'auth.json' },
  { type: 'exact', value: 'token-cache.json' },
  { type: 'exact', value: 'ranked-screen-rows.json' },
  { type: 'exact', value: 'package-lock.json' },
  { type: 'exact', value: 'lib/tennis-schedule-data/flashscore-cache.json' },
  // scratch / dev-time scripts
  { type: 'pattern', value: /^scripts\/scan-/ },
  { type: 'pattern', value: /^scripts\/_scan-/ },
  { type: 'pattern', value: /^scripts\/check-/ },
  { type: 'pattern', value: /^scripts\/novig-scan\.js$/ },
  // local audit/plan artifacts
  { type: 'prefix', value: 'docs/plans/' },
  { type: 'prefix', value: 'docs/cron-prompts/' },
  { type: 'exact', value: 'CLEANUP_PLAN.md' },
  // repo tooling / meta
  { type: 'prefix', value: '.hermes/' },
  { type: 'prefix', value: '.github/' },
  { type: 'prefix', value: '.pytest_cache/' },
  { type: 'prefix', value: '.commandcode/' },
  { type: 'exact', value: 'Makefile' },
  { type: 'exact', value: 'llms.txt' }
];

function findForbiddenHit(rule, files) {
  if (rule.type === 'prefix') {
    return files.find((f) => f.startsWith(rule.value));
  }
  if (rule.type === 'exact') {
    return files.includes(rule.value) ? rule.value : undefined;
  }
  return files.find((f) => rule.value.test(f));
}

/**
 * @param {string[]} files tarball entry paths (no "package/" prefix)
 * @returns {string[]} human-readable failures; empty array means the tarball is OK
 */
function verify(files) {
  const list = Array.isArray(files) ? files : [];
  const failures = [];

  for (const required of REQUIRED) {
    if (!list.includes(required)) {
      failures.push(`missing required entry: ${required}`);
    }
  }
  if (!list.some((f) => f.startsWith('docs/'))) {
    failures.push('missing required entry: docs/ (no files under docs/)');
  }

  for (const rule of FORBIDDEN) {
    const hit = findForbiddenHit(rule, list);
    if (hit) {
      failures.push(`forbidden entry present: ${hit}`);
    }
  }

  return failures;
}

function collectPackageFiles(manifest) {
  const packageEntries = Array.isArray(manifest) ? manifest : Object.values(manifest || {});
  const files = [];
  for (const entry of packageEntries) {
    for (const file of entry.files || []) {
      files.push(file.path.replace(/^package\//, ''));
    }
  }
  return files;
}

function main() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    console.error('npm pack --dry-run failed:');
    console.error(result.stderr || result.stdout || `exit code ${result.status}`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch (err) {
    console.error(`Could not parse npm pack --json output: ${err.message}`);
    process.exit(1);
  }

  const files = collectPackageFiles(manifest);

  const failures = verify(files);
  for (const failure of failures) {
    console.error(`error: ${failure}`);
  }
  if (failures.length > 0) {
    console.error('Package contents check FAILED.');
    process.exit(1);
  }
  console.log(`Package contents check passed (${files.length} files in tarball).`);
}

if (require.main === module) {
  main();
}

module.exports = { REQUIRED, FORBIDDEN, verify, collectPackageFiles };
