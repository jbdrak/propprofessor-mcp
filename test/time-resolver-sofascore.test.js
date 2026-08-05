'use strict';

/**
 * Deterministic, network-free tests for the Sofascore Python helper wiring in
 * lib/propprofessor-time-resolver.js.
 *
 * The module resolves child_process at load time, so we inject behavior by
 * intercepting Module._load (same convention as test/query-propprofessor.test.js)
 * and re-requiring a fresh copy of the resolver per test — fresh module state
 * (caches, one-time diagnostic flag) per test. The child_process stub provides
 * a callback-style execFile (the same shape cp.execFile uses) and https is
 * stubbed to throw, so no test can reach tennis.com — this suite never touches
 * the network.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const RESOLVER_PATH = require.resolve('../lib/propprofessor-time-resolver');

const SOFASCORE_FIXTURE = [
  {
    homeTeam: 'Djokovic',
    awayTeam: 'Alcaraz',
    startTime: '2026-08-05T19:00:00.000Z',
    tournament: 'US Open',
    status: 'scheduled'
  }
];

/**
 * Load a fresh copy of the resolver with stubbed child_process/https.
 *
 * @param {object} [stubs]
 * @param {Function} [stubs.execFile] - Callback-style (file, args, options, cb)
 * @param {Function} [stubs.httpsGet] - https.get replacement
 * @returns {object} Fresh resolver module
 */
function loadResolver({ execFile, httpsGet } = {}) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'child_process') {
      return {
        execFile:
          execFile ||
          ((file, args, options, callback) => {
            callback(new Error('no execFile stub provided'));
          })
      };
    }
    if (request === 'https') {
      return {
        get:
          httpsGet ||
          (() => {
            throw new Error('no https stub provided');
          })
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[RESOLVER_PATH];
    return require(RESOLVER_PATH);
  } finally {
    Module._load = originalLoad;
  }
}

/** Capture stderr writes; returns a restore function and the captured text. */
function captureStderr() {
  const originalWrite = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += chunk;
    return true;
  };
  return {
    captured: () => captured,
    restore: () => {
      process.stderr.write = originalWrite;
    }
  };
}

/** Count occurrences of the one-time helper diagnostic prefix. */
function diagnosticCount(captured) {
  return (captured.match(/\[time-resolver\] Sofascore helper unavailable/g) || []).length;
}

describe('time-resolver sofascore helper', () => {
  it('resolves a match from async helper output without touching the network', async () => {
    const execCalls = [];
    let httpsHits = 0;
    const mod = loadResolver({
      execFile: (file, args, options, callback) => {
        execCalls.push({ file, args });
        callback(null, JSON.stringify(SOFASCORE_FIXTURE), '');
      },
      httpsGet: () => {
        httpsHits += 1;
        throw new Error('network must not be hit');
      }
    });

    const result = await mod.resolveMatchTime('Djokovic', 'Alcaraz');

    assert.deepEqual(result, {
      time: '2026-08-05T19:00:00.000Z',
      confidence: 0.85,
      source: 'sofascore'
    });
    assert.equal(httpsHits, 0, 'tennis.com fallback must not be reached');
    assert.equal(execCalls.length, 1, 'helper invoked exactly once');
    assert.equal(execCalls[0].file, 'python3');
    assert.ok(
      execCalls[0].args[0].endsWith(path.join('scripts', 'fetch-sofascore.py')),
      `helper path should point at scripts/fetch-sofascore.py, got: ${execCalls[0].args[0]}`
    );
    assert.match(execCalls[0].args[1], /^\d{4}-\d{2}-\d{2}$/, 'date arg should be YYYY-MM-DD');
  });

  it('keeps successful day caching: a second pair reuses the cached data without respawning', async () => {
    const execCalls = [];
    const mod = loadResolver({
      execFile: (file, args, options, callback) => {
        execCalls.push({ file, args });
        callback(null, JSON.stringify(SOFASCORE_FIXTURE), '');
      },
      httpsGet: () => {
        throw new Error('network must not be hit');
      }
    });

    const first = await mod.resolveMatchTime('Djokovic', 'Alcaraz');
    const second = await mod.resolveMatchTime('Sinner', 'Zverev');

    assert.equal(first.source, 'sofascore');
    assert.equal(second, null, 'non-fixture pair resolves to null, not a respawned fetch');
    assert.equal(execCalls.length, 1, 'second pair must hit the 10-minute day cache');
  });

  it('reports a missing helper once per process and falls back without throwing', async () => {
    const execCalls = [];
    const missingHelper = Object.assign(new Error('spawn python3 ENOENT'), {
      code: 'ENOENT'
    });
    const mod = loadResolver({
      execFile: (file, args, options, callback) => {
        execCalls.push({ file, args });
        callback(missingHelper);
      },
      // Guard: if the fallback chain tries tennis.com, the stub throws so no
      // network can escape this test.
      httpsGet: () => {
        throw new Error('network must not be hit');
      }
    });

    const stderr = captureStderr();
    try {
      const first = await mod.resolveMatchTime('Djokovic', 'Alcaraz');
      const second = await mod.resolveMatchTime('Sinner', 'Zverev');

      assert.equal(first, null, 'missing helper must fall back to null, not throw');
      assert.equal(second, null);
      assert.equal(diagnosticCount(stderr.captured()), 1, 'helper diagnostic must be emitted exactly once per process');
      assert.match(stderr.captured(), /\[time-resolver\] Sofascore helper unavailable/);
      assert.match(stderr.captured(), /fetch-sofascore\.py/);
      assert.equal(execCalls.length, 1, 'second pair must not respawn the failing helper');
    } finally {
      stderr.restore();
    }
  });

  it('reports a missing cloudscraper dependency (non-zero exit) once and preserves fallback', async () => {
    const execCalls = [];
    const depFailure = Object.assign(new Error('Command failed: python3 scripts/fetch-sofascore.py'), {
      code: 3,
      stderr: 'fetch-sofascore.py: cloudscraper is required (python3 -m pip install cloudscraper)'
    });
    const mod = loadResolver({
      execFile: (file, args, options, callback) => {
        execCalls.push({ file, args });
        callback(depFailure);
      },
      httpsGet: () => {
        throw new Error('network must not be hit');
      }
    });

    const stderr = captureStderr();
    try {
      const first = await mod.resolveMatchTime('Djokovic', 'Alcaraz');
      const second = await mod.resolveMatchTime('Sinner', 'Zverev');

      assert.equal(first, null, 'dependency failure must fall back to null, not throw');
      assert.equal(second, null);
      assert.equal(
        diagnosticCount(stderr.captured()),
        1,
        'dependency diagnostic must be emitted exactly once per process'
      );
      assert.match(stderr.captured(), /cloudscraper/);
      assert.match(stderr.captured(), /exited 3/);
      assert.equal(execCalls.length, 1, 'second pair must not respawn the failing helper');
    } finally {
      stderr.restore();
    }
  });

  it('caches an empty Sofascore result so each player pair does not respawn Python', async () => {
    const execCalls = [];
    const mod = loadResolver({
      execFile: (file, args, options, callback) => {
        execCalls.push({ file, args });
        callback(null, '[]', '');
      },
      httpsGet: () => {
        throw new Error('network must not be hit');
      }
    });

    await mod.resolveMatchTime('Djokovic', 'Alcaraz');
    await mod.resolveMatchTime('Sinner', 'Zverev');

    assert.equal(
      execCalls.length,
      1,
      'empty result must be cached for the short TTL so the helper is not respawned per pair'
    );
  });

  it('falls back safely on malformed helper output (no throw, no network)', async () => {
    const execCalls = [];
    let httpsHits = 0;
    const mod = loadResolver({
      execFile: (file, args, options, callback) => {
        execCalls.push({ file, args });
        callback(null, 'not-json{{{', '');
      },
      httpsGet: () => {
        httpsHits += 1;
        throw new Error('network must not be hit');
      }
    });

    const result = await mod.resolveMatchTime('Djokovic', 'Alcaraz');
    await mod.resolveMatchTime('Sinner', 'Zverev');

    assert.equal(result, null, 'malformed JSON must not throw');
    assert.equal(httpsHits, 2, 'tennis.com fallback attempted per pair, but network stays stubbed');
    assert.equal(execCalls.length, 1, 'malformed output must be short-TTL cached, not respawned');
  });

  it('restores Module._load after loading the resolver', () => {
    const originalLoad = Module._load;
    try {
      loadResolver({
        execFile: (file, args, options, callback) => callback(new Error('stub')),
        httpsGet: () => {
          throw new Error('stub');
        }
      });
      assert.equal(Module._load, originalLoad, 'Module._load must be restored in finally, even on stub failures');
    } finally {
      Module._load = originalLoad;
    }
  });
});
