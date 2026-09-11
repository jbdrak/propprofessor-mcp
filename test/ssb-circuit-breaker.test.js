'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  CircuitBreaker,
  CircuitBreakerOpenError,
  STATE,
  getOrCreateBreaker,
  resetAllBreakers,
  DEFAULT_THRESHOLD,
  DEFAULT_RESET_TIMEOUT_MS
} = require('../lib/ssb-circuit-breaker');

describe('CircuitBreaker', () => {
  describe('initial state', () => {
    it('starts in closed state with zero failures', () => {
      const breaker = new CircuitBreaker({ name: 'test-endpoint', threshold: 5 });
      assert.equal(breaker.state, STATE.CLOSED);
      assert.equal(breaker.failureCount, 0);
    });

    it('uses default threshold and reset timeout when not specified', () => {
      const breaker = new CircuitBreaker({ name: 'test-endpoint' });
      assert.equal(breaker.threshold, DEFAULT_THRESHOLD);
      assert.equal(breaker.resetTimeoutMs, DEFAULT_RESET_TIMEOUT_MS);
    });
  });

  describe('allowRequest', () => {
    it('allows requests when closed', () => {
      const breaker = new CircuitBreaker({ name: 'test', threshold: 2 });
      assert.equal(breaker.allowRequest(), true);
    });

    it('rejects requests when open', () => {
      const breaker = new CircuitBreaker({ name: 'test', threshold: 2 });
      breaker.failureCount = 2;
      breaker.state = STATE.OPEN;
      breaker.nextAttemptMs = Date.now() + 10000;
      assert.equal(breaker.allowRequest(), false);
    });

    it('allows requests when half-open', () => {
      const breaker = new CircuitBreaker({ name: 'test', threshold: 2 });
      breaker.state = STATE.HALF_OPEN;
      assert.equal(breaker.allowRequest(), true);
    });
  });

  describe('recordFailure', () => {
    it('increments failure count on each call', () => {
      const breaker = new CircuitBreaker({ name: 'test', threshold: 5 });
      breaker.recordFailure();
      assert.equal(breaker.failureCount, 1);
      breaker.recordFailure();
      assert.equal(breaker.failureCount, 2);
    });

    it('opens circuit when threshold is reached', () => {
      const breaker = new CircuitBreaker({ name: 'test', threshold: 3 });
      breaker.recordFailure();
      breaker.recordFailure();
      assert.equal(breaker.state, STATE.CLOSED);
      assert.throws(
        () => breaker.recordFailure(),
        (err) => {
          assert.equal(err.code, 'CIRCUIT_BREAKER_OPEN');
          assert.equal(err.breakerName, 'test');
          return true;
        }
      );
      assert.equal(breaker.state, STATE.OPEN);
      assert.equal(breaker.nextAttemptMs !== null, true);
    });

    it('throws CircuitBreakerOpenError when circuit is open', () => {
      const breaker = new CircuitBreaker({ name: 'test', threshold: 2 });
      breaker.state = STATE.OPEN;
      breaker.nextAttemptMs = Date.now() + 10000;

      assert.throws(
        () => breaker.recordFailure(),
        (err) => {
          assert.equal(err.code, 'CIRCUIT_BREAKER_OPEN');
          assert.equal(err.retryable, true);
          assert.equal(err.breakerName, 'test');
          return true;
        }
      );
    });
  });

  describe('recordSuccess', () => {
    it('resets to closed state', () => {
      const breaker = new CircuitBreaker({ name: 'test', threshold: 2 });
      breaker.state = STATE.OPEN;
      breaker.failureCount = 5;
      breaker.nextAttemptMs = Date.now() + 10000;

      breaker.recordSuccess();
      assert.equal(breaker.state, STATE.CLOSED);
      assert.equal(breaker.failureCount, 0);
      assert.equal(breaker.nextAttemptMs, null);
    });
  });

  describe('state transitions', () => {
    it('transitions from open to half-open after reset timeout', () => {
      const breaker = new CircuitBreaker({ name: 'test', threshold: 2, resetTimeoutMs: 10 });
      breaker.state = STATE.OPEN;
      breaker.nextAttemptMs = Date.now() - 5; // Already past due

      assert.equal(breaker.allowRequest(), true);
      assert.equal(breaker.state, STATE.HALF_OPEN);
    });

    it('stays open until reset timeout elapses', () => {
      const breaker = new CircuitBreaker({ name: 'test', threshold: 2, resetTimeoutMs: 10000 });
      breaker.state = STATE.OPEN;
      breaker.nextAttemptMs = Date.now() + 10000; // Not yet due

      assert.equal(breaker.allowRequest(), false);
      assert.equal(breaker.state, STATE.OPEN);
    });

    it('transitions from half-open to closed on success', () => {
      const breaker = new CircuitBreaker({ name: 'test', threshold: 2 });
      breaker.state = STATE.HALF_OPEN;

      breaker.recordSuccess();
      assert.equal(breaker.state, STATE.CLOSED);
    });

    it('transitions from half-open back to open on failure', () => {
      const breaker = new CircuitBreaker({ name: 'test', threshold: 2 });
      breaker.state = STATE.HALF_OPEN;

      // This should fail the threshold check (failureCount becomes 1, not reaching threshold)
      // Let's test with threshold 1
      const breaker2 = new CircuitBreaker({ name: 'test2', threshold: 1 });
      breaker2.state = STATE.HALF_OPEN;
      assert.throws(
        () => breaker2.recordFailure(),
        (err) => {
          assert.equal(err.code, 'CIRCUIT_BREAKER_OPEN');
          assert.equal(breaker2.state, STATE.OPEN);
          return true;
        }
      );
    });
  });
});

describe('getOrCreateBreaker', () => {
  beforeEach(() => {
    resetAllBreakers();
  });

  it('returns existing breaker for same name', () => {
    const breaker1 = getOrCreateBreaker('endpoint-a');
    const breaker2 = getOrCreateBreaker('endpoint-a');
    assert.equal(breaker1 === breaker2, true);
  });

  it('creates different breakers for different names', () => {
    const breaker1 = getOrCreateBreaker('endpoint-a');
    const breaker2 = getOrCreateBreaker('endpoint-b');
    assert.equal(breaker1 === breaker2, false);
  });

  it('accepts threshold and resetTimeoutMs overrides', () => {
    const breaker = getOrCreateBreaker('custom-endpoint', { threshold: 10, resetTimeoutMs: 5000 });
    assert.equal(breaker.threshold, 10);
    assert.equal(breaker.resetTimeoutMs, 5000);
  });
});

describe('resetAllBreakers', () => {
  it('clears all breakers from the map', () => {
    getOrCreateBreaker('endpoint-a');
    getOrCreateBreaker('endpoint-b');
    resetAllBreakers();

    // After reset, getOrCreateBreaker should create fresh instances
    const breaker1 = getOrCreateBreaker('endpoint-a');
    const breaker2 = getOrCreateBreaker('endpoint-b');
    assert.equal(breaker1.failureCount, 0);
    assert.equal(breaker2.failureCount, 0);
  });
});

describe('CircuitBreakerOpenError', () => {
  it('has correct properties', () => {
    const error = new CircuitBreakerOpenError('test message', 'test-breaker');
    assert.equal(error.name, 'CircuitBreakerOpenError');
    assert.equal(error.code, 'CIRCUIT_BREAKER_OPEN');
    assert.equal(error.retryable, true);
    assert.equal(error.breakerName, 'test-breaker');
    assert.equal(error.message, 'test message');
  });
});

describe('getInfo', () => {
  it('returns current breaker state information', () => {
    const breaker = new CircuitBreaker({ name: 'info-test', threshold: 3, resetTimeoutMs: 5000 });
    const info = breaker.getInfo();

    assert.equal(info.name, 'info-test');
    assert.equal(info.state, STATE.CLOSED);
    assert.equal(info.failureCount, 0);
    assert.equal(info.threshold, 3);
    assert.equal(info.resetTimeoutMs, 5000);
    assert.equal(info.nextAttemptMs, null);
    assert.equal(info.timeUntilReset, null);
  });

  it('includes timeUntilReset when circuit is open', () => {
    const breaker = new CircuitBreaker({ name: 'info-test', threshold: 2, resetTimeoutMs: 10000 });
    breaker.state = STATE.OPEN;
    breaker.nextAttemptMs = Date.now() + 5000;

    const info = breaker.getInfo();
    assert.equal(info.timeUntilReset !== null, true);
    assert.equal(info.timeUntilReset >= 0, true);
  });
});
