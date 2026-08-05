#!/usr/bin/env node
'use strict';

/**
 * Reject publishing while tracked or untracked package/runtime content is
 * dirty. Anything that would be packed into the npm tarball (the package.json
 * "files" entries) must match the committed tree before `npm publish`.
 *
 * Local audit/plan artifacts (tests, coverage, backtest data, .hermes plans,
 * docs/plans, docs/cron-prompts, CLEANUP_PLAN.md) are allowed to be dirty —
 * they do not ship.
 *
 * Standalone:  node scripts/check-publish-tree.js
 * Testable:    const { verify } = require('./check-publish-tree.js')
 */

const { spawnSync } = require('node:child_process');

// Dirty status is fine for anything under these prefixes (never packed).
const ALLOWED_DIRTY_PREFIXES = [
  '.hermes/',
  '.commandcode/',
  '.pytest_cache/',
  '.archive/',
  '.github/',
  'test/',
  'coverage/',
  'backtest-data/',
  'data/',
  'docs/plans/',
  'docs/cron-prompts/',
  'examples/',
  'node_modules/'
];

// ...and for these exact paths (local-only artifacts, never packed).
const ALLOWED_DIRTY_EXACT = new Set([
  'CLEANUP_PLAN.md',
  'llms.txt',
  'Makefile',
  '.gitignore',
  'package-lock.json',
  'auth.json',
  'token-cache.json',
  'ranked-screen-rows.json',
  'circuit-cache.json',
  '.DS_Store'
]);

function isAllowedDirty(file) {
  if (ALLOWED_DIRTY_EXACT.has(file)) {
    return true;
  }
  return ALLOWED_DIRTY_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/**
 * Parse `git status --porcelain=v1` lines.
 * @param {string[]} lines
 * @returns {{code: string, file: string}[]}
 */
function parse(lines) {
  const entries = [];
  for (const line of lines || []) {
    const text = String(line);
    if (text.length < 4) {
      continue; // empty, or "XY " with no path
    }
    const code = text.slice(0, 2);
    let file = text.slice(3);
    // Rename/copy lines look like "R  old/path -> new/path"; keep the destination.
    if ((code[0] === 'R' || code[0] === 'C') && file.includes(' -> ')) {
      file = file.split(' -> ')[1];
    }
    entries.push({ code, file });
  }
  return entries;
}

/**
 * @param {string[]} lines `git status --porcelain=v1` lines
 * @returns {string[]} blocked dirty package/runtime entries (original line text)
 */
function verify(lines) {
  const blocked = [];
  for (const { code, file } of parse(lines)) {
    // Any git status entry can change what ships, including staged additions,
    // deletions, renames, and copies. Only explicitly non-package paths are
    // allowed to be dirty.
    if (isAllowedDirty(file)) {
      continue;
    }
    blocked.push(`${code} ${file}`);
  }
  return blocked;
}

function main() {
  const result = spawnSync('git', ['status', '--porcelain=v1'], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    console.error(`git status failed: ${result.stderr || result.stdout || `exit code ${result.status}`}`);
    process.exit(1);
  }

  const lines = (result.stdout || '').split('\n').filter((l) => l.length > 0);
  const blocked = verify(lines);
  for (const entry of blocked) {
    console.error(`error: dirty package/runtime content: ${entry}`);
  }
  if (blocked.length > 0) {
    console.error('Publish tree check FAILED - commit (or revert) package/runtime changes before publishing.');
    process.exit(1);
  }
  console.log('Publish tree check passed: package/runtime content matches the committed tree.');
}

if (require.main === module) {
  main();
}

module.exports = {
  ALLOWED_DIRTY_PREFIXES,
  ALLOWED_DIRTY_EXACT,
  isAllowedDirty,
  parse,
  verify
};
