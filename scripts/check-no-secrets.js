#!/usr/bin/env node

/**
 * Secret/credential guard for the working tree.
 *
 * Blocks any of the following from being present in the working tree or
 * tracked by git:
 *   - auth.json (SSB session cookies)
 *   - token-cache.json (cached JWT)
 *   - anything under .ssb-for-agents/ (runtime credentials/config)
 *
 * Run from package.json scripts:
 *   - "precommit:secrets" — fast, working tree only
 *   - "check:secrets"     — full check (working tree + git ls-files)
 *
 * Exit code: 0 on success, 1 if any forbidden path is present.
 *
 * The CI workflow runs `check:secrets` to fail PRs that try to reintroduce
 * these files. The `precommit:secrets` script is meant to be invoked
 * manually (or via a `pre-commit` hook) before staging changes.
 *
 * This is belt-and-suspenders alongside `.gitignore`: even if a developer
 * `git add -f`s a sensitive file, this script will flag it before the
 * commit lands and before CI ever sees it.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const repoRoot = process.cwd();

const FORBIDDEN_PATHS = ['auth.json', 'token-cache.json', '.ssb-for-agents', '.propprofessor', '.ssb'];

const FORBIDDEN_PATTERNS = [/^auth\.json$/, /^token-cache\.json$/, /^\.ssb-for-agents\//];

function listTrackedFiles() {
  try {
    const out = execSync('git ls-files', { encoding: 'utf8', cwd: repoRoot });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function checkWorkingTree(cwd = process.cwd()) {
  const violations = [];
  for (const forbidden of FORBIDDEN_PATHS) {
    const fullPath = path.join(cwd, forbidden);
    if (fs.existsSync(fullPath)) {
      violations.push(forbidden);
    }
  }
  return violations;
}

function checkTrackedFiles() {
  const tracked = listTrackedFiles();
  const violations = [];
  for (const file of tracked) {
    if (FORBIDDEN_PATTERNS.some((re) => re.test(file))) {
      violations.push(file);
    }
  }
  return violations;
}

function main() {
  const args = process.argv.slice(2);
  const skipTracked = args.includes('--working-tree-only');

  const workingTreeViolations = checkWorkingTree();
  const trackedViolations = skipTracked ? [] : checkTrackedFiles();

  let failures = 0;

  if (workingTreeViolations.length > 0) {
    console.error('FAIL: forbidden credentials found in working tree:');
    for (const v of workingTreeViolations) {
      console.error(`  - ${v}`);
    }
    console.error('\nThese files contain session cookies, JWTs, or runtime credentials.');
    console.error('They are gitignored but should also be removed from your local working tree:');
    console.error('  rm -f auth.json token-cache.json');
    console.error('  rm -rf .ssb-for-agents');
    console.error('The actual credentials live outside the repo in $HOME/.ssb-for-agents/ —');
    console.error('re-run `pp-query login` to regenerate them in the right location.');
    failures += workingTreeViolations.length;
  }

  if (trackedViolations.length > 0) {
    console.error('FAIL: forbidden credentials are tracked by git:');
    for (const v of trackedViolations) {
      console.error(`  - ${v}`);
    }
    console.error('\nUntrack immediately:');
    console.error('  git rm --cached <file>');
    console.error('And purge from history if these were ever pushed:');
    console.error('  git filter-repo --path <file> --invert-paths');
    console.error('Then ROTATE every credential in the file — assume compromise.');
    failures += trackedViolations.length;
  }

  if (failures === 0) {
    const scope = skipTracked ? 'working tree' : 'working tree + git ls-files';
    console.log(`OK: no forbidden credential files in ${scope}`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { FORBIDDEN_PATHS, FORBIDDEN_PATTERNS, checkWorkingTree, checkTrackedFiles };
