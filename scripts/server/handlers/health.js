'use strict';

/**
 * Health and status handlers (stateless, no cache interaction).
 * Extracted from handlers.js createMcpHandlers closure.
 */

const { resolveAuthFile, readAuthState, isAuthValid, getCookieExpiryInfo } = require('../../../lib/propprofessor-api');

const { ok, fail } = require('../../../lib/response-envelope');

/**
 * @param {import('../../lib/propprofessor-api').PropProfessorClient} client
 * @param {import('./handler-context').HandlerContext} ctx
 */
function createHealthHandlers(client, ctx) {
  const { responseCache, responseCacheTtlMs } = ctx || {};
  const { getOddsHistoryCache, DEFAULT_ODDS_HISTORY_CACHE_TTL_MS } = require('../../../lib/mcp-runtime-config');

  return {
    async health_status() {
      const authFile = resolveAuthFile();
      let authState;
      try {
        authState = readAuthState(authFile);
      } catch {
        authState = null;
      }

      const authValid = isAuthValid(authState);
      const expiryInfo = getCookieExpiryInfo(authState);
      const authSection = {
        valid: authValid,
        file: authValid ? authFile : null,
        message: authValid ? 'Auth is valid' : 'Auth missing or expired. Run: pp-query login',
        session: {
          status: expiryInfo.status,
          expiresAt: expiryInfo.sessionExpiry,
          daysRemaining: expiryInfo.daysRemaining,
          warning: expiryInfo.warning
        }
      };

      if (!authValid) {
        return fail('AUTH_EXPIRED', 'Auth missing or expired. Run: pp-query login', { auth: authSection });
      }

      const result = await client.healthStatus();
      const responseCacheStats =
        responseCache && typeof responseCache.stats === 'function' ? responseCache.stats() : {};
      const totalLooks = responseCacheStats.hits + responseCacheStats.misses;
      const responseCacheHitRate = totalLooks > 0 ? responseCacheStats.hits / totalLooks : 0;
      const oddsHistoryCacheStats = getOddsHistoryCache().stats();
      const oddsTotalLooks = oddsHistoryCacheStats.hits + oddsHistoryCacheStats.misses;
      const oddsHistoryHitRate = oddsTotalLooks > 0 ? oddsHistoryCacheStats.hits / oddsTotalLooks : 0;

      return ok({
        auth: authSection,
        result,
        backend: {
          ok: result.ok,
          message: result.ok ? 'Backend is reachable' : 'Backend returned an error',
          ...result
        },
        caches: {
          response: {
            size: responseCacheStats.size || 0,
            max: responseCacheStats.max || 0,
            hits: responseCacheStats.hits || 0,
            misses: responseCacheStats.misses || 0,
            evictions: responseCacheStats.evictions || 0,
            hitRate: Number(responseCacheHitRate.toFixed(4)),
            ttlMs: responseCacheTtlMs
          },
          oddsHistory: {
            size: oddsHistoryCacheStats.size || 0,
            max: oddsHistoryCacheStats.max || 0,
            hits: oddsHistoryCacheStats.hits || 0,
            misses: oddsHistoryCacheStats.misses || 0,
            evictions: oddsHistoryCacheStats.evictions || 0,
            hitRate: Number(oddsHistoryHitRate.toFixed(4)),
            ttlMs: DEFAULT_ODDS_HISTORY_CACHE_TTL_MS || 300000
          }
        }
      });
    }
  };
}

module.exports = { createHealthHandlers };
