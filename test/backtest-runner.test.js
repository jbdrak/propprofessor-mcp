'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Mock picks before requiring
const MOCK_PICKS_FILE = path.join(os.tmpdir(), 'pp-backtest-test-picks-' + Date.now() + '.json');
process.env.PP_PICKS_FILE = MOCK_PICKS_FILE;

// Temporarily remove the real picks module from the cache so it re-reads with our mock path
delete require.cache[require.resolve('../lib/propprofessor-picks')];

// Must reorder: clear env first, then require the runner
const { parseArgs, filterByDateRange, computeStatsFromPicks } = require('../scripts/backtest-runner');

describe('backtest-runner', () => {
  after(() => {
    try {
      fs.unlinkSync(MOCK_PICKS_FILE);
    } catch (_err) {
      void _err; /* file may not exist */
    }
    delete process.env.PP_PICKS_FILE;
  });

  describe('parseArgs', () => {
    it('parses --from and --to', () => {
      const result = parseArgs(['--from', '2026-06-01', '--to', '2026-07-20']);
      assert.equal(result.from, '2026-06-01');
      assert.equal(result.to, '2026-07-20');
      assert.equal(result.days, null);
      assert.equal(result.help, false);
    });

    it('parses --days', () => {
      const result = parseArgs(['--days', '30']);
      assert.equal(result.days, 30);
      assert.equal(result.from, null);
    });

    it('parses --help', () => {
      const result = parseArgs(['--help']);
      assert.equal(result.help, true);
    });

    it('handles empty args', () => {
      const result = parseArgs([]);
      assert.equal(result.from, null);
      assert.equal(result.to, null);
      assert.equal(result.days, null);
    });
  });

  describe('filterByDateRange', () => {
    const picks = [
      { loggedAt: '2026-06-15T12:00:00Z' },
      { loggedAt: '2026-07-01T08:00:00Z' },
      { loggedAt: '2026-07-20T23:59:59Z' },
      { loggedAt: '2026-08-01T00:00:00Z' }
    ];

    it('filters picks within a date range', () => {
      const result = filterByDateRange(picks, '2026-06-01', '2026-07-20');
      assert.equal(result.length, 3);
    });

    it('includes exact boundary dates', () => {
      const result = filterByDateRange(picks, '2026-06-15', '2026-06-15');
      assert.equal(result.length, 1);
      assert.equal(result[0].loggedAt, '2026-06-15T12:00:00Z');
    });

    it('returns empty for range with no matches', () => {
      const result = filterByDateRange(picks, '2025-01-01', '2025-01-31');
      assert.equal(result.length, 0);
    });

    it('returns all picks when from and to are null', () => {
      const result = filterByDateRange(picks, null, null);
      assert.equal(result.length, picks.length);
    });
  });

  describe('computeStatsFromPicks', () => {
    it('returns correct win/loss/push counts', () => {
      const picks = [
        {
          league: 'NBA',
          market: 'Moneyline',
          selection: 'Lakers',
          odds: 150,
          stake: 100,
          status: 'won',
          confidenceTier: 'TIER 1'
        },
        {
          league: 'NBA',
          market: 'Moneyline',
          selection: 'Celtics',
          odds: -110,
          stake: 50,
          status: 'lost',
          confidenceTier: 'TIER 1'
        },
        {
          league: 'MLB',
          market: 'Moneyline',
          selection: 'Yankees',
          odds: -140,
          stake: 100,
          status: 'won',
          confidenceTier: 'TIER 2'
        },
        {
          league: 'NFL',
          market: 'Spread',
          selection: 'Chiefs -3',
          odds: -110,
          stake: 0,
          status: 'push',
          confidenceTier: 'TIER 3'
        }
      ];

      const stats = computeStatsFromPicks(picks);
      assert.equal(stats.total, 4);
      assert.equal(stats.resolved, 4);
      assert.equal(stats.wins, 2);
      assert.equal(stats.losses, 1);
      assert.equal(stats.pushes, 1);
      assert.equal(stats.winRate, '66.7%');
    });

    it('handles empty picks array without crashing', () => {
      const stats = computeStatsFromPicks([]);
      assert.equal(stats.total, 0);
      assert.equal(stats.resolved, 0);
      assert.equal(stats.wins, 0);
      assert.equal(stats.losses, 0);
      assert.equal(stats.winRate, null);
      assert.equal(stats.profit, 0);
    });

    it('handles picks with no settled results (all pending)', () => {
      const picks = [
        { league: 'NBA', status: 'pending' },
        { league: 'MLB', status: 'pending' }
      ];
      const stats = computeStatsFromPicks(picks);
      assert.equal(stats.total, 2);
      assert.equal(stats.resolved, 0);
    });

    it('computes byTier breakdown', () => {
      const picks = [
        { league: 'NBA', odds: 200, stake: 100, status: 'won', confidenceTier: 'TIER 1' },
        { league: 'NBA', odds: -110, stake: 50, status: 'lost', confidenceTier: 'TIER 1' },
        { league: 'MLB', odds: 150, stake: 100, status: 'won', confidenceTier: 'TIER 2' }
      ];

      const stats = computeStatsFromPicks(picks);
      assert.ok(stats.byTier['TIER 1']);
      assert.equal(stats.byTier['TIER 1'].picks, 2);
      assert.equal(stats.byTier['TIER 1'].wins, 1);
      assert.equal(stats.byTier['TIER 1'].losses, 1);
      assert.equal(stats.byTier['TIER 1'].winRate, '50.0%');

      assert.ok(stats.byTier['TIER 2']);
      assert.equal(stats.byTier['TIER 2'].picks, 1);
      assert.equal(stats.byTier['TIER 2'].wins, 1);
      assert.equal(stats.byTier['TIER 2'].winRate, '100.0%');
    });

    it('computes byLeague breakdown', () => {
      const picks = [
        { league: 'NBA', odds: 100, stake: 100, status: 'won' },
        { league: 'MLB', odds: -110, stake: 100, status: 'lost' }
      ];

      const stats = computeStatsFromPicks(picks);
      assert.ok(stats.byLeague['NBA']);
      assert.equal(stats.byLeague['NBA'].picks, 1);
      assert.equal(stats.byLeague['NBA'].wins, 1);

      assert.ok(stats.byLeague['MLB']);
      assert.equal(stats.byLeague['MLB'].picks, 1);
      assert.equal(stats.byLeague['MLB'].losses, 1);
    });

    it('computes profit correctly', () => {
      // +150 @100 won = +150; -110 @100 lost = -100; net = +50
      const picks = [
        { league: 'NBA', odds: 150, stake: 100, status: 'won' },
        { league: 'NBA', odds: -110, stake: 100, status: 'lost' }
      ];
      const stats = computeStatsFromPicks(picks);
      assert.equal(stats.profit, 50);
    });

    it('handles picks without stakes (profit = 0)', () => {
      const picks = [
        { league: 'NBA', odds: 150, status: 'won' },
        { league: 'NBA', odds: -110, status: 'lost' }
      ];
      const stats = computeStatsFromPicks(picks);
      assert.equal(stats.profit, 0);
    });

    it('assigns Unranked tier when confidenceTier is missing', () => {
      const picks = [{ league: 'NBA', odds: 100, stake: 100, status: 'won' }];
      const stats = computeStatsFromPicks(picks);
      assert.ok(stats.byTier['Unranked']);
      assert.equal(stats.byTier['Unranked'].picks, 1);
    });
  });
});
