'use strict';

// Environment variable overrides with defaults
const DEFAULT_THRESHOLD = parseInt(process.env.SSB_CIRCUIT_BREAKER_THRESHOLD || '5', 10);
const DEFAULT_RESET_TIMEOUT_MS = parseInt(process.env.SSB_CIRCUIT_BREAKER_TIMEOUT_MS || '30000', 10);

/**
 * Error thrown when a circuit breaker is open and rejects a request.
 */
class CircuitBreakerOpenError extends Error {
  constructor(message, breakerName) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
    this.code = 'CIRCUIT_BREAKER_OPEN';
    this.retryable = true;
    this.breakerName = breakerName;
  }
}

/**
 * Circuit breaker states.
 */
const STATE = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open'
};

/**
 * Circuit breaker class that protects against cascading failures.
 * States: closed -> open -> half-open -> closed
 */
class CircuitBreaker {
  /**
   * @param {Object} options - Circuit breaker options.
   * @param {string} options.name - Unique name for the breaker (typically the URL endpoint).
   * @param {number} [options.threshold] - Number of failures before opening the circuit.
   * @param {number} [options.resetTimeoutMs] - Time in ms before transitioning from open to half-open.
   */
  constructor({ name, threshold = DEFAULT_THRESHOLD, resetTimeoutMs = DEFAULT_RESET_TIMEOUT_MS }) {
    this.name = name;
    this.threshold = threshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.nextAttemptMs = null;
  }

  /**
   * Check if requests should be allowed through.
   * @returns {boolean} True if the request should pass, false if the circuit is open.
   */
  allowRequest() {
    if (this.state === STATE.CLOSED) {
      return true;
    }

    if (this.state === STATE.OPEN) {
      // Check if the reset timeout has elapsed
      if (this.nextAttemptMs && Date.now() >= this.nextAttemptMs) {
        // Transition to half-open
        this.state = STATE.HALF_OPEN;
        return true;
      }
      return false;
    }

    // HALF_OPEN: allow one request through to test
    return true;
  }

  /**
   * Record a failure. Increments counter and opens circuit at threshold.
   * In half-open state or when already open, any failure immediately re-opens the circuit.
   * @throws {CircuitBreakerOpenError} When circuit is open.
   */
  recordFailure() {
    // If already open, throw immediately without incrementing
    if (this.state === STATE.OPEN) {
      throw new CircuitBreakerOpenError(`Circuit breaker '${this.name}' is open`, this.name);
    }

    this.failureCount += 1;

    if (this.state === STATE.HALF_OPEN || this.failureCount >= this.threshold) {
      this.state = STATE.OPEN;
      this.nextAttemptMs = Date.now() + this.resetTimeoutMs;
      throw new CircuitBreakerOpenError(
        `Circuit breaker '${this.name}' is open after ${this.failureCount} failures`,
        this.name
      );
    }
  }

  /**
   * Record a success. Resets the circuit to closed.
   */
  recordSuccess() {
    this.failureCount = 0;
    this.state = STATE.CLOSED;
    this.nextAttemptMs = null;
  }

  /**
   * Get the current state of the circuit breaker.
   * @returns {Object} State information for debugging/metrics.
   */
  getInfo() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      threshold: this.threshold,
      resetTimeoutMs: this.resetTimeoutMs,
      nextAttemptMs: this.nextAttemptMs,
      timeUntilReset: this.nextAttemptMs ? Math.max(0, this.nextAttemptMs - Date.now()) : null
    };
  }
}

// Module-level map that persists across requests
const breakerMap = new Map();

/**
 * Get or create a circuit breaker for a given name.
 * @param {string} name - Unique name (typically URL endpoint).
 * @param {Object} [options] - Optional override options.
 * @param {number} [options.threshold] - Failure threshold.
 * @param {number} [options.resetTimeoutMs] - Reset timeout in ms.
 * @returns {CircuitBreaker} The circuit breaker instance.
 */
function getOrCreateBreaker(name, options = {}) {
  if (!breakerMap.has(name)) {
    breakerMap.set(
      name,
      new CircuitBreaker({
        name,
        threshold: options.threshold ?? DEFAULT_THRESHOLD,
        resetTimeoutMs: options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS
      })
    );
  }
  return breakerMap.get(name);
}

/**
 * Reset all circuit breakers.
 */
function resetAllBreakers() {
  breakerMap.clear();
}

/**
 * Get information about all circuit breakers.
 * @returns {Object[]} Array of breaker info objects.
 */
function getAllBreakersInfo() {
  const result = [];
  for (const [, breaker] of breakerMap) {
    result.push(breaker.getInfo());
  }
  return result;
}

module.exports = {
  CircuitBreaker,
  CircuitBreakerOpenError,
  STATE,
  createCircuitBreaker: CircuitBreaker,
  getOrCreateBreaker,
  resetAllBreakers,
  getAllBreakersInfo,
  DEFAULT_THRESHOLD,
  DEFAULT_RESET_TIMEOUT_MS
};
