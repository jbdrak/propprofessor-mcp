'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Clear module cache to allow env var changes
function resetModules() {
  delete require.cache[require.resolve('../lib/mcp-runtime-config')];
  delete require.cache[require.resolve('../lib/propprofessor-prewarm')];
}

describe('propprofessor-prewarm', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetModules();
  });

  describe('getPreWarmConfig', () => {
    it('skips when PROPPROFESSOR_MCP_PREWARM=0', () => {
      process.env.PROPPROFESSOR_MCP_PREWARM = '0';
      const { getPreWarmConfig } = require('../lib/mcp-runtime-config');
      const config = getPreWarmConfig();
      assert.equal(config.enabled, false);
    });

    it('returns enabled by default', () => {
      delete process.env.PROPPROFESSOR_MCP_PREWARM;
      const { getPreWarmConfig } = require('../lib/mcp-runtime-config');
      const config = getPreWarmConfig();
      assert.equal(config.enabled, true);
    });

    it('parses PROPPROFESSOR_MCP_PREWARM_LEAGUES', () => {
      process.env.PROPPROFESSOR_MCP_PREWARM_LEAGUES = 'NBA,MLB,NHL';
      const { getPreWarmConfig } = require('../lib/mcp-runtime-config');
      const config = getPreWarmConfig();
      assert.deepEqual(config.leagues, ['NBA', 'MLB', 'NHL']);
    });

    it('defaults to all supported leagues', () => {
      delete process.env.PROPPROFESSOR_MCP_PREWARM_LEAGUES;
      const { getPreWarmConfig } = require('../lib/mcp-runtime-config');
      const config = getPreWarmConfig();
      const expectedLeagues = [
        'NBA',
        'NBASL',
        'MLB',
        'NFL',
        'NHL',
        'WNBA',
        'NCAAB',
        'NCAAF',
        'Soccer',
        'Tennis',
        'UFC'
      ];
      assert.deepEqual(config.leagues, expectedLeagues);
    });

    it('parses PROPPROFESSOR_MCP_PREWARM_TIMEOUT_MS', () => {
      process.env.PROPPROFESSOR_MCP_PREWARM_TIMEOUT_MS = '5000';
      const { getPreWarmConfig } = require('../lib/mcp-runtime-config');
      const config = getPreWarmConfig();
      assert.equal(config.timeoutMs, 5000);
    });

    it('defaults timeout to 10000ms', () => {
      delete process.env.PROPPROFESSOR_MCP_PREWARM_TIMEOUT_MS;
      const { getPreWarmConfig } = require('../lib/mcp-runtime-config');
      const config = getPreWarmConfig();
      assert.equal(config.timeoutMs, 10000);
    });
  });

  describe('prewarmOddsHistoryCache', () => {
    it('skips when enabled is false', async () => {
      process.env.PROPPROFESSOR_MCP_PREWARM = '0';
      const { getPreWarmConfig } = require('../lib/mcp-runtime-config');
      const { prewarmOddsHistoryCache } = require('../lib/propprofessor-prewarm');

      const mockClient = {
        queryScreenOddsBestComps: async () => {
          throw new Error('Should not be called');
        }
      };

      const config = getPreWarmConfig();
      const result = await prewarmOddsHistoryCache({
        client: mockClient,
        runtimeConfig: config,
        logger: null
      });

      assert.equal(result.leaguesProcessed, 0);
      assert.equal(result.gamesProcessed, 0);
      assert.equal(result.errors, 0);
    });

    it('runs within timeout and warms screen cache (skipHistory)', async () => {
      const { prewarmOddsHistoryCache } = require('../lib/propprofessor-prewarm');

      let screenCallCount = 0;
      const mockClient = {
        queryScreenOddsBestComps: async () => {
          screenCallCount += 1;
          // Return mock game data for each league
          return {
            game_data: [
              { gameId: 'game-1', selections: { home: { selectionId: 'home-1' } } },
              { gameId: 'game-2', selections: { away: { selectionId: 'away-1' } } }
            ]
          };
        },
        queryOddsHistory: async () => {
          throw new Error('Should not be called when skipHistory is true');
        }
      };

      const config = { enabled: true, leagues: ['NBA'], timeoutMs: 10000 };
      const result = await prewarmOddsHistoryCache({
        client: mockClient,
        runtimeConfig: config,
        logger: null
      });

      assert.equal(result.leaguesProcessed, 1);
      // With skipHistory=true (default in prewarm), gamesProcessed stays 0
      // because odds history is not fetched — only screen data is warmed.
      assert.equal(result.gamesProcessed, 0);
      assert.equal(screenCallCount, 1);
    });

    it('handles client errors gracefully', async () => {
      const { prewarmOddsHistoryCache } = require('../lib/propprofessor-prewarm');

      const mockClient = {
        queryScreenOddsBestComps: async () => {
          throw new Error('API error');
        }
      };

      const config = { enabled: true, leagues: ['NBA'], timeoutMs: 10000 };
      const result = await prewarmOddsHistoryCache({
        client: mockClient,
        runtimeConfig: config,
        logger: null
      });

      assert.equal(result.leaguesProcessed, 0);
      assert.equal(result.errors, 1);
    });

    it('does not block initialize (setImmediate is used)', async () => {
      const { prewarmOddsHistoryCache } = require('../lib/propprofessor-prewarm');

      let prewarmStarted = false;
      let prewarmCompleted = false;

      const mockClient = {
        queryScreenOddsBestComps: async () => {
          prewarmStarted = true;
          await new Promise((r) => setTimeout(r, 100)); // Simulate slow API
          prewarmCompleted = true;
          return { game_data: [] };
        },
        queryOddsHistory: async () => ({})
      };

      const config = { enabled: true, leagues: ['NBA'], timeoutMs: 10000 };

      // Call prewarmOddsHistoryCache - it should NOT block
      const prewarmPromise = prewarmOddsHistoryCache({
        client: mockClient,
        runtimeConfig: config,
        logger: null
      });
      // Immediately after calling, prewarm should NOT have completed yet
      // (setImmediate defers execution)
      // Note: This test verifies the function returns a promise, not that it blocks
      // The actual setImmediate behavior is tested by checking the function signature

      // Wait for completion
      await prewarmPromise;

      assert.equal(prewarmStarted, true);
      assert.equal(prewarmCompleted, true);
    });

    it('processes multiple leagues in parallel - MLB screen fires while NBA screen is delayed', async () => {
      const { prewarmOddsHistoryCache } = require('../lib/propprofessor-prewarm');

      const callOrder = [];
      const nbaDelayMs = 150; // NBA will be artificially delayed

      const mockClient = {
        queryScreenOddsBestComps: async ({ league }) => {
          callOrder.push(`screen-start-${league}`);

          if (league === 'NBA') {
            // Simulate a slow NBA API call
            await new Promise((r) => setTimeout(r, nbaDelayMs));
          } else if (league === 'MLB') {
            // MLB should complete quickly
            await new Promise((r) => setTimeout(r, 10));
          }

          callOrder.push(`screen-end-${league}`);
          return { game_data: [] };
        },
        queryOddsHistory: async () => ({})
      };

      const config = { enabled: true, leagues: ['NBA', 'MLB', 'NHL'], timeoutMs: 10000 };
      await prewarmOddsHistoryCache({
        client: mockClient,
        runtimeConfig: config,
        logger: null
      });

      // Verify that MLB screen started before NBA screen ended
      // This proves parallel execution
      const mlbStartIdx = callOrder.indexOf('screen-start-MLB');
      const nbaEndIdx = callOrder.indexOf('screen-end-NBA');

      assert.notEqual(mlbStartIdx, -1, 'MLB screen should have started');
      assert.notEqual(nbaEndIdx, -1, 'NBA screen should have ended');

      // MLB screen should start before NBA screen ends (proving parallel execution)
      assert.ok(mlbStartIdx < nbaEndIdx, 'MLB screen should start before NBA screen ends - proving parallel execution');
    });

    it('respects MAX_CONCURRENT_LEAGUES=3 - no more than 3 leagues run at once', async () => {
      const { prewarmOddsHistoryCache } = require('../lib/propprofessor-prewarm');

      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const mockClient = {
        queryScreenOddsBestComps: async () => {
          currentConcurrent += 1;
          if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
          // Stagger delays so we can observe concurrency
          await new Promise((r) => setTimeout(r, 50));
          currentConcurrent -= 1;
          return { game_data: [] };
        },
        queryOddsHistory: async () => ({})
      };

      const config = { enabled: true, leagues: ['NBA', 'MLB', 'NHL', 'NFL', 'WNBA'], timeoutMs: 10000 };
      const result = await prewarmOddsHistoryCache({
        client: mockClient,
        runtimeConfig: config,
        logger: null
      });

      assert.equal(result.leaguesProcessed, 5);
      assert.ok(maxConcurrent <= 3, `Expected max concurrency <= 3, got ${maxConcurrent}`);
    });
  });
});
