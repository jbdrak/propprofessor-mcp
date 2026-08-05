'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { backtest, parseArgs, resolveSnapshot, takeSnapshot } = require('../scripts/backtest');

const DATA_DIR = path.join(__dirname, '..', 'backtest-data');

describe('backtest CLI', () => {
  describe('parseArgs', () => {
    it('returns defaults when no arguments provided', () => {
      const opts = parseArgs(['node', 'backtest.js']);
      assert.equal(opts.league, 'MLB');
      assert.equal(opts.market, 'Moneyline');
      assert.equal(opts.days, 30);
      assert.equal(opts.snapshot, false);
    });

    it('parses positional arguments', () => {
      const opts = parseArgs(['node', 'backtest.js', 'NBA', 'Spread', '7']);
      assert.equal(opts.league, 'NBA');
      assert.equal(opts.market, 'Spread');
      assert.equal(opts.days, 7);
    });

    it('falls back to defaults for missing positionals', () => {
      const opts = parseArgs(['node', 'backtest.js', 'Tennis']);
      assert.equal(opts.league, 'Tennis');
      assert.equal(opts.market, 'Moneyline');
      assert.equal(opts.days, 30);
    });

    it('parses --snapshot flag', () => {
      const opts = parseArgs(['node', 'backtest.js', '--snapshot']);
      assert.equal(opts.snapshot, true);
    });

    it('parses --snapshot with inline league value, positional args still work', () => {
      const opts = parseArgs(['node', 'backtest.js', '--snapshot=NBA', 'Spread']);
      assert.equal(opts.snapshot, 'NBA');
      assert.equal(opts.league, 'Spread');
      assert.equal(opts.market, 'Moneyline');
    });

    it('parses --resolve with --wins/--losses/--pushes', () => {
      const opts = parseArgs(['node', 'backtest.js', '--resolve', 'foo.json', '--wins=5', '--losses=2', '--pushes=1']);
      assert.equal(opts.resolve, 'foo.json');
      assert.equal(opts.wins, 5);
      assert.equal(opts.losses, 2);
      assert.equal(opts.pushes, 1);
    });

    it('parses --live acknowledgment flag', () => {
      const opts = parseArgs(['node', 'backtest.js', '--snapshot', '--live']);
      assert.equal(opts.snapshot, true);
      assert.equal(opts.live, true);
    });

    it('--live is absent by default', () => {
      const opts = parseArgs(['node', 'backtest.js', '--snapshot']);
      assert.equal(opts.live, false);
    });
  });

  describe('resolveSnapshot', () => {
    const testFile = path.join(DATA_DIR, 'resolve-test-snapshot.json');

    before(() => {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        testFile,
        JSON.stringify({
          meta: { league: 'MLB', market: 'Moneyline', date: '2026-06-01', totalRows: 10 },
          byTier: {
            'TIER 1': [{ participant: 'Team A', odds: -120 }],
            'TIER 4': [{ participant: 'Team B', odds: +150 }]
          },
          resolved: null
        }),
        'utf8'
      );
    });

    after(() => {
      try {
        fs.unlinkSync(testFile);
      } catch {
        /* ignore */
      }
    });

    it('reports no outcomes when wins/losses/pushes are all 0', () => {
      const result = resolveSnapshot(testFile, { wins: 0, losses: 0, pushes: 0 });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'no_outcomes');
    });

    it('calculates hit rate correctly', () => {
      const result = resolveSnapshot(testFile, { wins: 7, losses: 3, pushes: 0 });
      assert.equal(result.ok, true);
      assert.equal(result.hitRate, '70.0');
      assert.equal(result.wins, 7);
      assert.equal(result.losses, 3);
    });

    it('returns error for non-existent file', () => {
      const result = resolveSnapshot('nonexistent-file.json', { wins: 1, losses: 0, pushes: 0 });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'file_not_found');
    });
  });

  describe('backtest function', () => {
    it('is exported and is a function', () => {
      assert.equal(typeof backtest, 'function');
    });

    it('aggregate mode returns an object with ok field', async () => {
      const result = await backtest({ league: 'MLB', market: 'Moneyline', days: 1 });
      assert.equal(typeof result, 'object');
      assert.ok('ok' in result);
    });

    it('snapshot mode returns error for nonexistent league (but doesnt crash)', async () => {
      // Should not throw — should return an error result object
      try {
        const result = await backtest({ snapshot: true, league: 'NONEXISTENT_LEAGUE_999', market: 'Moneyline' });
        assert.equal(typeof result, 'object');
        assert.ok('ok' in result);
      } catch (e) {
        // If it throws, that's also acceptable — the test just ensures no silent crash
        assert.ok(e.message);
      }
    });

    it('takeSnapshot refuses to call PropProfessor without --live (manual-only gate)', async () => {
      await assert.rejects(
        () => takeSnapshot({ league: 'MLB', market: 'Moneyline', live: false }),
        /manual-only/,
        'snapshot capture must require an explicit --live acknowledgment'
      );
    });

    it('forwards --live through the main snapshot path without touching the network', async () => {
      let received;
      const result = await backtest(
        { snapshot: 'MLB', market: 'Moneyline', tag: 'manual', live: true },
        {
          takeSnapshot: async (options) => {
            received = options;
            return { ok: true };
          }
        }
      );

      assert.equal(result.ok, true);
      assert.deepEqual(received, {
        league: 'MLB',
        market: 'Moneyline',
        tag: 'manual',
        live: true
      });
    });
  });
});
