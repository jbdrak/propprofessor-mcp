'use strict';

/**
 * Sliding-window rate limiter for PropProfessor MCP tool calls.
 *
 * Prevents runaway agent loops from triggering an upstream API ban.
 * Configurable via PROPPROFESSOR_RATE_LIMIT (max calls) and
 * PROPPROFESSOR_RATE_WINDOW_MS (window in ms).
 *
 * Tools that don't hit the backend (health_status, ping, etc.) are
 * never rate-limited.
 */

const DEFAULT_MAX_CALLS = 25;
const DEFAULT_WINDOW_MS = 60_000;

// Non-backend tools — these are always allowed through
const LOCAL_ONLY_TOOLS = new Set(['health_status']);

// Guard against bad env/config values (0, negative, NaN, garbage strings):
// a finite positive number wins, anything else falls back to the default so
// protection can never be silently disabled by a bad value.
function toPositiveFiniteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

class RateLimiter {
  constructor({ maxCalls = DEFAULT_MAX_CALLS, windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
    this.maxCalls = toPositiveFiniteOr(maxCalls, DEFAULT_MAX_CALLS);
    this.windowMs = toPositiveFiniteOr(windowMs, DEFAULT_WINDOW_MS);
    this.now = now;
    this._log = [];
  }

  /**
   * Check if a tool call is allowed.
   * @param {string} toolName
   * @returns {{ ok: true } | { ok: false, code: string, message: string }}
   */
  check(toolName) {
    // Skip rate-limiting for non-backend tools
    if (LOCAL_ONLY_TOOLS.has(toolName)) {
      return { ok: true };
    }

    const now = this.now();
    this._log.push(now);

    // Trim log to current window
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this._log.length && this._log[i] < cutoff) {
      i++;
    }
    if (i > 0) {
      this._log.splice(0, i);
    }

    if (this._log.length > this.maxCalls) {
      const waitSeconds = Math.ceil(this.windowMs / 1000);
      return {
        ok: false,
        code: 'RATE_LIMITED',
        message: `Rate limit exceeded: >${this.maxCalls} calls in the last ${waitSeconds}s. Hold a moment and retry.`
      };
    }

    return { ok: true };
  }

  /** Reset the call log (for testing). */
  reset() {
    this._log = [];
  }
}

module.exports = { RateLimiter, DEFAULT_MAX_CALLS, DEFAULT_WINDOW_MS };
