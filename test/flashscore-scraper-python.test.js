'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Requiring the scraper must not execute main() (guarded by `require.main ===
// module`), so no Python/Playwright scrape is launched by this test.
const { resolvePythonCommand } = require('../scripts/flashscore-scraper');

const os = require('node:os');

const HERMES_PYTHON = require('node:path').join(os.homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'python');

describe('flashscore-scraper python interpreter', () => {
  it('defaults to the Hermes venv python (playwright-compatible)', () => {
    delete process.env.FLASHSCORE_PYTHON;
    assert.equal(resolvePythonCommand(), HERMES_PYTHON);
  });

  it('honors the FLASHSCORE_PYTHON environment override', () => {
    process.env.FLASHSCORE_PYTHON = '/opt/other/bin/python';
    try {
      assert.equal(resolvePythonCommand(), '/opt/other/bin/python');
    } finally {
      delete process.env.FLASHSCORE_PYTHON;
    }
  });
});
