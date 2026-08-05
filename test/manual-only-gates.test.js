'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const INSTALL_PY = path.join(REPO_ROOT, 'scripts', 'install.py');

// ---------------------------------------------------------------------------
// Executable-surface scanner
//
// Rule: PropProfessor is manual-only. No tracked executable automation
// surface may combine scheduling/unattended language with live PropProfessor
// client/endpoint access. Public-only data refreshes (ESPN settlement,
// Flashscore cache refresh) are allowed to discuss scheduling ONLY when they
// never construct a PropProfessor client or call a PropProfessor endpoint —
// those files live in PUBLIC_ONLY_ALLOWLIST with a documented rationale.
// ---------------------------------------------------------------------------

/**
 * Scheduling / unattended-execution constructs. Deliberately precise:
 * - bare words like "cron" or "schedule" in prose (e.g. "never invoked by
 *   cron", "Scheduled match times are unreliable") do NOT count;
 * - `setTimeout` is NOT counted — it is used repo-wide as a promise-timeout
 *   helper, not as an automation construct;
 * - match only recurring/unattended execution: cron schedules, setInterval
 *   polling, Hermes cron registration markers, launch agents, file watchers,
 *   and crontab expressions.
 */
const SCHEDULE_PATTERNS = [
  /\bschedule\s*:/i, // Hermes cron `schedule: "0 9 * * *"` / GH Actions `schedule:`
  /setInterval\s*\(/, // recurring polling loops
  /@daily|@hourly|@weekly|@monthly|@yearly/i, // crontab shorthand
  /\bno_agent\b/i, // Hermes cron marker (no_agent: true)
  /\bhermes cron\b|\bcronjob\b/i, // explicit cron registration
  /\blaunch agent\b|\blaunchagent\b|\blaunchdaemon\b|launchd\s+plist/i, // OS-level schedulers (not process-ancestry prose)
  /\bfs\.watch\s*\(|watchFile\s*\(/i, // file watchers
  /\b\d{1,2}([-,]\d{1,2}|\s+\d{1,2})* \* \* \* \*?/ // 4-5 field crontab expression, e.g. `0 9 * * *`
];

/**
 * Live PropProfessor client/endpoint access. Matches the actual API surface
 * (screen calls, client construction, PP host, live handler names) rather
 * than mere imports of local auth helpers.
 */
const PP_PATTERNS = [
  /queryScreenOddsBestComps|queryScreenOdds\b/, // direct PP screen queries
  /createPropProfessorClient\s*\(/, // constructs the live PP client
  /app\.propprofessor\.com/, // PP endpoint host
  /\bquick_screen\b|\brecommended_bets\b|\bscreen_ranked\b|\bget_alerts\b/, // live PP handler/tool names
  /takeSnapshot\s*\(/ // backtest snapshot helper (always constructs a live client)
];

/**
 * Narrow, documented allowlist of public-only automation that may discuss
 * scheduling. Each entry is asserted to (a) never reference live PP access
 * and (b) reference public data sources (ESPN/Flashscore/Sofascore) only.
 * These are safe under the rule: scheduled public-only settlement is allowed
 * if it never calls PropProfessor.
 */
const PUBLIC_ONLY_ALLOWLIST = {
  'scripts/resolve-outcomes.js':
    'Public-only settlement: fetches settled scores from ESPN public endpoints only; never constructs a PropProfessor client or calls a PP endpoint.',
  'scripts/refresh-tennis-circuit.js':
    'Public-only tennis circuit refresh: rebuilds PLAYER_CIRCUIT from ESPN/Flashscore public schedule data; never imports propprofessor-api or calls a PP endpoint.'
};

/** True when a file combines scheduling language with live PP access. */
function hasScheduledPPAccess(content) {
  const scheduleHit = SCHEDULE_PATTERNS.some((re) => re.test(content));
  const ppHit = PP_PATTERNS.some((re) => re.test(content));
  return scheduleHit && ppHit;
}

/** True when a file references live PP client/endpoint access. */
function hasPPAccess(content) {
  return PP_PATTERNS.some((re) => re.test(content));
}

/**
 * Enumerate tracked executable automation surfaces:
 * scripts/*.js|.py|.sh, .github/workflows/*.yml|.yaml, Makefile.
 * Uses `git ls-files` so untracked scratch files (e.g. scripts/scan-*)
 * and docs/changelogs are naturally excluded from the executable scan.
 * Files already deleted from the working tree (uncommitted removals, such
 * as the removed scripts/backtest-daily-snapshot.js wrapper) are skipped —
 * they are no longer executable surfaces.
 */
function enumerateTrackedExecutables() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((relPath) => fs.existsSync(path.join(REPO_ROOT, relPath)))
    .filter(
      (relPath) =>
        (relPath.startsWith('scripts/') && /\.(js|py|sh)$/.test(relPath)) ||
        relPath.startsWith('.github/workflows/') ||
        relPath === 'Makefile'
    );
}

describe('manual-only gates — scheduling', () => {
  describe('GitHub Actions workflows', () => {
    let workflows;
    try {
      workflows = fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml'));
    } catch {
      workflows = [];
    }

    it('no scheduled workflow references live PropProfessor access', () => {
      for (const wf of workflows) {
        const fullPath = path.join(WORKFLOW_DIR, wf);
        const content = fs.readFileSync(fullPath, 'utf8');
        // Scheduled workflows are only a violation when they also reference
        // live PropProfessor. Public-only schedules (ESPN settlement,
        // Flashscore refresh) never touch PP and are harmless — allowed.
        assert.ok(
          !hasScheduledPPAccess(content),
          `workflow ${wf} combines a schedule trigger with live PropProfessor access — PropProfessor is manual-only`
        );
      }
    });

    it('no workflow references live PP smoke commands', () => {
      for (const wf of workflows) {
        const fullPath = path.join(WORKFLOW_DIR, wf);
        const content = fs.readFileSync(fullPath, 'utf8');
        const hasSmokeLive = /smoke\s*:\s*live/.test(content);
        assert.ok(!hasSmokeLive, `workflow ${wf} references smoke:live — PropProfessor is manual-only`);
      }
    });
  });

  describe('installer', () => {
    it('install.py has no cron subcommand', () => {
      const content = fs.readFileSync(INSTALL_PY, 'utf8');
      // `cron` should not appear as a subcommand name in the argparse registration
      const hasCronSubcommand = /"cron"/.test(content) || /'cron'/.test(content);
      assert.ok(
        !hasCronSubcommand,
        'install.py has a cron subcommand — PropProfessor cron installation is not supported'
      );
    });

    it('install.py has no install_cron function', () => {
      const content = fs.readFileSync(INSTALL_PY, 'utf8');
      assert.ok(
        !/def install_cron/.test(content),
        'install.py has an install_cron function — PropProfessor cron installation is not supported'
      );
    });
  });

  describe('Makefile', () => {
    const makefilePath = path.join(REPO_ROOT, 'Makefile');

    it('Makefile has no install-cron target', () => {
      let content;
      try {
        content = fs.readFileSync(makefilePath, 'utf8');
      } catch {
        return; // No Makefile, skip
      }
      assert.ok(
        !/install-cron\s*:/.test(content),
        'Makefile has an install-cron target — PropProfessor cron installation is not supported'
      );
    });
  });

  describe('cron prompt template', () => {
    const cronPromptPath = path.join(REPO_ROOT, 'docs', 'cron-prompts', 'sharp-money-alert.md');

    it('sharp-money-alert.md is manual-only documentation', () => {
      let content;
      try {
        content = fs.readFileSync(cronPromptPath, 'utf8');
      } catch {
        return; // File doesn't exist, skip
      }
      const hasExecutableCronCommand = /hermes cron create/.test(content);
      assert.ok(
        !hasExecutableCronCommand,
        'cron prompt template contains an executable hermes cron create command — replace with manual-only documentation'
      );
    });
  });

  describe('executable surface scanner (scheduled + live PP)', () => {
    // RED fixture: a fake scheduled queryScreenOdds script must be rejected.
    // This proves the scanner catches the exact pattern the deleted
    // scripts/backtest-daily-snapshot.js cron wrapper used.
    it('rejects a fake scheduled queryScreenOdds script (RED fixture)', () => {
      const fake = [
        '#!/usr/bin/env node',
        '// Runs via Hermes cron (no_agent: true). Silent on success, alerts on failure.',
        "const { createPropProfessorClient } = require('../lib/propprofessor-api');",
        'async function main() {',
        '  const client = createPropProfessorClient();',
        "  const payload = await client.queryScreenOdds({ league: 'NBA', market: 'Moneyline' });",
        '}',
        'main();'
      ].join('\n');
      assert.equal(
        hasScheduledPPAccess(fake),
        true,
        'fake scheduled queryScreenOdds script must be flagged as scheduled PP access'
      );
    });

    it('rejects a fake scheduled queryScreenOddsBestComps script (RED fixture)', () => {
      const fake = [
        '// Daily polling loop',
        "setInterval(() => client.queryScreenOddsBestComps({ league: 'Tennis' }), 86400000);"
      ].join('\n');
      assert.equal(
        hasScheduledPPAccess(fake),
        true,
        'fake scheduled queryScreenOddsBestComps script must be flagged as scheduled PP access'
      );
    });

    // RED fixture: a scheduled public-only workflow must be ALLOWED. The old
    // blanket gate ("no workflow has a schedule trigger") rejected ANY
    // scheduled workflow; the corrected gate only rejects schedules that also
    // reference live PropProfessor. Public-only ESPN settlement / Flashscore
    // refresh schedules are harmless.
    it('allows a scheduled public-only workflow (RED fixture)', () => {
      const fakeWorkflow = [
        'name: espn-settlement',
        'on:',
        '  schedule:',
        "    - cron: '0 9 * * *'",
        'jobs:',
        '  settle:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: node scripts/resolve-outcomes.js',
        '      - run: node scripts/refresh-tennis-circuit.js'
      ].join('\n');
      assert.equal(
        hasScheduledPPAccess(fakeWorkflow),
        false,
        'scheduled public-only settlement workflow must be allowed — it never references PropProfessor'
      );
    });

    // RED fixture: a scheduled public-only script must be ALLOWED for the
    // same reason (public data refresh, no PropProfessor client/endpoint).
    it('allows a scheduled public-only script (RED fixture)', () => {
      const fakeScript = [
        '#!/usr/bin/env node',
        '// Registered as a launchd agent. Refreshes public Flashscore data only.',
        'schedule: "0 9 * * *"',
        "const { fetchFlashscoreSchedule } = require('../lib/flashscore-public');",
        "fetchFlashscoreSchedule().then((r) => console.log('refreshed', r.length));"
      ].join('\n');
      assert.equal(
        hasScheduledPPAccess(fakeScript),
        false,
        'scheduled public-only Flashscore refresh must be allowed — it never references PropProfessor'
      );
    });

    // Companion RED fixture: the corrected gate still blocks a scheduled
    // workflow that DOES reference live PropProfessor endpoints.
    it('rejects a scheduled workflow that references live PP (RED fixture)', () => {
      const fakeWorkflow = [
        'name: pp-snapshot',
        'on:',
        '  schedule:',
        "    - cron: '0 9 * * *'",
        'jobs:',
        '  snapshot:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: curl -s https://app.propprofessor.com/api/screen > snapshot.json'
      ].join('\n');
      assert.equal(
        hasScheduledPPAccess(fakeWorkflow),
        true,
        'scheduled workflow hitting the live PropProfessor host must be flagged'
      );
    });

    it('does not flag scheduling-only or PP-only files', () => {
      assert.equal(
        hasScheduledPPAccess('// Manual-only. Never invoked by cron, a watcher, or a scheduler.\nconst x = 1;'),
        false,
        'negated cron prose is not a schedule'
      );
      assert.equal(
        hasScheduledPPAccess("const client = createPropProfessorClient(); client.queryScreenOdds({ league: 'NBA' });"),
        false,
        'manual PP call without scheduling is allowed'
      );
    });

    it('no tracked executable combines scheduling with live PropProfessor access', () => {
      const files = enumerateTrackedExecutables();
      assert.ok(files.length > 0, 'expected tracked executable surfaces to be enumerated');
      const violations = [];
      for (const relPath of files) {
        if (PUBLIC_ONLY_ALLOWLIST[relPath]) continue; // allowlisted below
        const content = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
        if (hasScheduledPPAccess(content)) violations.push(relPath);
      }
      assert.deepEqual(
        violations,
        [],
        `tracked executable(s) combine scheduling with live PropProfessor access — PropProfessor is manual-only: ${violations.join(', ')}`
      );
    });

    it('allowlisted public-only files never reference PropProfessor and are public-data refreshes', () => {
      const entries = Object.entries(PUBLIC_ONLY_ALLOWLIST);
      assert.ok(entries.length > 0, 'allowlist must be non-empty');
      for (const [relPath, rationale] of entries) {
        assert.ok(rationale.length > 20, `allowlist entry ${relPath} needs a documented rationale`);
        const fullPath = path.join(REPO_ROOT, relPath);
        const content = fs.readFileSync(fullPath, 'utf8');
        assert.ok(
          !hasPPAccess(content),
          `allowlisted ${relPath} must never reference live PropProfessor access: ${rationale}`
        );
        assert.ok(
          /espn|flashscore|sofascore/i.test(content),
          `allowlisted ${relPath} should be a public-data (ESPN/Flashscore/Sofascore) refresh: ${rationale}`
        );
      }
    });
  });
});
