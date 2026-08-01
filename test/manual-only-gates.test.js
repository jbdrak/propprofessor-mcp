'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const INSTALL_PY = path.join(REPO_ROOT, 'scripts', 'install.py');

/**
 * Parse a YAML workflow file and check if it has a `schedule` trigger
 * that could invoke live PropProfessor endpoints.
 * This is a lightweight regex-based check — it doesn't parse full YAML
 * but catches the most common ways a schedule trigger is written.
 */
function hasScheduleTrigger(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  // Match the `schedule:` key under `on:` at the top level of the workflow
  return /\bon:\s*\n(\s+#.*\n)*\s+schedule:/.test(content) || /\bon:\s*\[[^\]]*schedule[^\]]*\]/.test(content);
}

describe('manual-only gates — scheduling', () => {
  describe('GitHub Actions workflows', () => {
    let workflows;
    try {
      workflows = fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml'));
    } catch {
      workflows = [];
    }

    it('no workflow has a schedule trigger', () => {
      for (const wf of workflows) {
        const fullPath = path.join(WORKFLOW_DIR, wf);
        assert.ok(
          !hasScheduleTrigger(fullPath),
          `workflow ${wf} has a schedule trigger — PropProfessor is manual-only`
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
});
