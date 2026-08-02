'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { RateLimiter, DEFAULT_MAX_CALLS, DEFAULT_WINDOW_MS } = require('../lib/rate-limiter');

// Injectable fake clock: RateLimiter must use the `now` option instead of
// Date.now() so sliding-window expiry is testable without real sleeps.
function makeFakeClock(startMs = 1_000_000) {
  let now = startMs;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    }
  };
}

describe('RateLimiter', () => {
  it('allows up to maxCalls calls within the window', () => {
    const clock = makeFakeClock();
    const limiter = new RateLimiter({ maxCalls: 2, windowMs: 1000, now: clock.now });
    assert.deepEqual(limiter.check('screen_ranked'), { ok: true });
    assert.deepEqual(limiter.check('screen_ranked'), { ok: true });
  });

  it('rejects the maxCalls+1 call with the RATE_LIMITED error shape', () => {
    const clock = makeFakeClock();
    const limiter = new RateLimiter({ maxCalls: 2, windowMs: 1000, now: clock.now });
    limiter.check('screen_ranked');
    limiter.check('screen_ranked');
    const result = limiter.check('screen_ranked');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RATE_LIMITED');
    assert.match(result.message, /Rate limit exceeded/);
    assert.match(result.message, /2 calls in the last 1s/);
  });

  it('allows calls again after the window elapses (uses the injected clock)', () => {
    const clock = makeFakeClock();
    const limiter = new RateLimiter({ maxCalls: 2, windowMs: 1000, now: clock.now });
    limiter.check('screen_ranked');
    limiter.check('screen_ranked');
    assert.equal(limiter.check('screen_ranked').ok, false);
    clock.advance(1000);
    // A 1ms tick over the boundary is still inside the window
    clock.advance(1);
    assert.deepEqual(limiter.check('screen_ranked'), { ok: true });
  });

  it('reset() clears the call log', () => {
    const clock = makeFakeClock();
    const limiter = new RateLimiter({ maxCalls: 1, windowMs: 1000, now: clock.now });
    limiter.check('screen_ranked');
    assert.equal(limiter.check('screen_ranked').ok, false);
    limiter.reset();
    assert.deepEqual(limiter.check('screen_ranked'), { ok: true });
  });

  it('never rate-limits health_status', () => {
    const clock = makeFakeClock();
    const limiter = new RateLimiter({ maxCalls: 1, windowMs: 1000, now: clock.now });
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(limiter.check('health_status'), { ok: true });
    }
  });

  describe('invalid constructor values fall back to safe defaults', () => {
    it('maxCalls 0 falls back to DEFAULT_MAX_CALLS', () => {
      const clock = makeFakeClock();
      const limiter = new RateLimiter({ maxCalls: 0, windowMs: 1000, now: clock.now });
      assert.equal(limiter.maxCalls, DEFAULT_MAX_CALLS);
    });

    it('maxCalls NaN falls back to DEFAULT_MAX_CALLS', () => {
      const clock = makeFakeClock();
      const limiter = new RateLimiter({ maxCalls: NaN, windowMs: 1000, now: clock.now });
      assert.equal(limiter.maxCalls, DEFAULT_MAX_CALLS);
    });

    it('negative windowMs falls back to DEFAULT_WINDOW_MS', () => {
      const clock = makeFakeClock();
      const limiter = new RateLimiter({ maxCalls: 2, windowMs: -500, now: clock.now });
      assert.equal(limiter.windowMs, DEFAULT_WINDOW_MS);
    });

    it('windowMs 0 falls back to DEFAULT_WINDOW_MS', () => {
      const clock = makeFakeClock();
      const limiter = new RateLimiter({ maxCalls: 2, windowMs: 0, now: clock.now });
      assert.equal(limiter.windowMs, DEFAULT_WINDOW_MS);
    });

    it('maxCalls 0 must NOT disable protection — the limiter still enforces DEFAULT_MAX_CALLS', () => {
      const clock = makeFakeClock();
      const limiter = new RateLimiter({ maxCalls: 0, windowMs: 1000, now: clock.now });
      for (let i = 0; i < DEFAULT_MAX_CALLS; i += 1) {
        assert.deepEqual(limiter.check('screen_ranked'), { ok: true });
      }
      const result = limiter.check('screen_ranked');
      assert.equal(result.ok, false);
      assert.equal(result.code, 'RATE_LIMITED');
    });

    it('maxCalls 1 with windowMs 0 behaves as the 60s default window (no expiry within the window)', () => {
      const clock = makeFakeClock();
      const limiter = new RateLimiter({ maxCalls: 1, windowMs: 0, now: clock.now });
      assert.equal(limiter.windowMs, DEFAULT_WINDOW_MS);
      assert.deepEqual(limiter.check('screen_ranked'), { ok: true });
      clock.advance(1);
      const result = limiter.check('screen_ranked');
      assert.equal(result.ok, false);
      assert.equal(result.code, 'RATE_LIMITED');
    });
  });
});
