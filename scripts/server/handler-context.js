'use strict';

/**
 * Shared context factory for MCP tool handlers.
 *
 * Captures the common dependencies that all 31 handlers need — extracted
 * from the createMcpHandlers() closure in handlers.js so that extracted
 * modules can access them without reaching into the monolith.
 *
 * Updated v2.10.0: accepts `handlers` reference for cross-calling handlers.
 *
 * Usage:
 *   const { createHandlerContext } = require('./handler-context');
 *   const ctx = createHandlerContext({ client });
 *   // ctx.client, ctx.responseCache, ctx.handlers, etc.
 */

const { getCacheTtlMs, getCacheMaxEntries, getCacheMaxEntrySizeBytes } = require('../../lib/mcp-runtime-config');
const { LruCache } = require('../../lib/propprofessor-lru-cache');
const { clearTierCache } = require('../../lib/propprofessor-risk-score');
const { createCanonicalScreenCache } = require('../../lib/propprofessor-shared-utils');

function createHandlerContext({ client } = {}) {
  const _maybeGc =
    typeof global.gc === 'function'
      ? () => {
          try {
            global.gc();
          } catch {
            /* best-effort */
          }
        }
      : () => {};

  const responseCache = new LruCache(getCacheMaxEntries(), getCacheMaxEntrySizeBytes());
  const responseCacheTtlMs = getCacheTtlMs();
  const responseCacheMaxEntrySizeBytes = getCacheMaxEntrySizeBytes();

  const canonicalScreenCache = createCanonicalScreenCache({
    ttlMs: responseCacheTtlMs,
    maxEntries: 100
  });

  return {
    client,
    responseCache,
    responseCacheTtlMs,
    responseCacheMaxEntrySizeBytes,
    cacheMaxEntries: getCacheMaxEntries(),
    canonicalScreenCache,
    maybeGc: _maybeGc,
    clearTierCache,
    // Set externally after handlers are built — extracted modules use this
    // to call sibling handlers (e.g. quick_screen -> sharp_plays)
    handlers: null
  };
}

module.exports = { createHandlerContext };
