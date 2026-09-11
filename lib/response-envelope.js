'use strict';

/**
 * Response envelope helpers for SSB MCP tools.
 *
 * Every handler wraps its return with ok() or fail() so the output shape
 * is consistent across all tools:
 *
 *   Success → { ok: true, data: { ... }, ...legacyFields }
 *   Error   → { ok: false, error: { code, message } }
 *
 * The legacy spread keeps pre-existing fields at root so no agent skills
 * or scripts break — they can read result.plays OR result.data.plays.
 */

/**
 * Wrap a successful handler result.
 * @param {Object} data - The handler's result object (may already have `ok`).
 * @returns {Object} Enveloped result with `ok`, `data`, and legacy spread.
 */
function ok(data) {
  if (!data || typeof data !== 'object') {
    return { ok: true, data: {}, ...data };
  }
  // Strip `ok` from the spread so the wrapper's `ok: true` is authoritative
  // and consumers reading `result.ok` always see the right value.
  const { ok: _ok, ...rest } = data;
  return { ok: true, data, ...rest };
}

/**
 * Wrap a handler failure.
 * @param {string} code - Machine-readable error code.
 * @param {string} message - Human-readable error description.
 * @param {Object} [extra] - Optional extra fields to include at root.
 * @returns {Object} Enveloped error with `ok`, `error`, and any extra fields.
 */
function fail(code, message, extra = {}) {
  return { ok: false, error: { code, message }, ...extra };
}

module.exports = { ok, fail };
