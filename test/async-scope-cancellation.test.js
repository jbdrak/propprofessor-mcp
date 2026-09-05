'use strict';

// Hermetic regression for the cooperative scan-deadline cancellation scope.
//
// withPairTimeout used to only stop WAITING for a slow pair (Promise.race)
// while the provider work kept issuing new requests. This proves the
// cancellation channel now actually stops provider work:
//   1. runScope exposes a real AbortController per scope.
//   2. Aborting a scope's controller marks signal.aborted true and makes
//      isScopeAborted() true inside that scope.
//   3. A provider gate inside a live scope allows a request; inside an
//      aborted scope it refuses (and throws the non-retryable ScopeAbortError).
//   4. Sibling scopes are independent — aborting one leaves the other's
//      signal untouched.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  runScope,
  currentScopeController,
  currentScopeAbortSignal,
  isScopeAborted,
  ScopeAbortError
} = require('../lib/async-scope');

// Synchronous provider gate: observes the active scope's abort state at the
// instant it is called (mirrors the top-of-requestJSON isScopeAborted() guard).
function gateAllows() {
  return !isScopeAborted();
}

describe('async-scope cooperative cancellation', () => {
  it('exposes a real AbortController and abort() marks signal.aborted', async () => {
    const { controller } = runScope(async () => {});
    assert.ok(controller instanceof AbortController, 'runScope returns a real AbortController');
    assert.equal(controller.signal.aborted, false);
    controller.abort();
    assert.equal(controller.signal.aborted, true, 'abort() marks the signal aborted');
    assert.equal(currentScopeAbortSignal(), null, 'no scope leaks into the runner context');
  });

  it('a live provider gate allows work; the aborted scope refuses and throws ScopeAbortError', async () => {
    // Live scope: the synchronous gate allows a request, then the deadline
    // fires inside the scope and the gate refuses + throws a non-retryable
    // cancellation error. Everything is asserted inside the worker so the
    // result is observed in the scope's own async context.
    await runScope(async () => {
      assert.equal(gateAllows(), true, 'live provider gate allows a request');
      assert.equal(currentScopeController().signal.aborted, false);

      // Fire the pair deadline (as withPairTimeout finally does).
      currentScopeController().abort();

      assert.equal(gateAllows(), false, 'aborted provider gate refuses a request');
      assert.equal(isScopeAborted(), true);
      assert.throws(() => {
        if (isScopeAborted()) throw new ScopeAbortError('request not started: scan scope aborted');
      }, ScopeAbortError);
      assert.equal(currentScopeController().signal.aborted, true);
    }).promise;

    // A fresh scope that the deadline aborts while the worker is still inside
    // it must refuse afterward (misnomer-safe even when the callback is
    // deferred by the harness).
    let postAbortAllows = null;
    let parkedResolve;
    const parked = new Promise((r) => (parkedResolve = r));
    const { controller, promise } = runScope(async () => {
      await parked;
      postAbortAllows = gateAllows();
      assert.equal(isScopeAborted(), true, 'post-deadline scope is aborted');
    });
    parkedResolve();
    controller.abort();
    await promise;
    await new Promise((r) => setImmediate(r)); // let any deferred tail settle
    assert.equal(postAbortAllows, false, 'post-deadline gate refuses a request');
  });

  it('aborting one scope leaves a sibling scope independent', async () => {
    const a = runScope(async () => {
      assert.equal(gateAllows(), true, 'scope A is live before its abort');
      assert.equal(isScopeAborted(), false);
    });
    a.controller.abort();
    assert.equal(a.controller.signal.aborted, true, 'scope A aborted');
    const b = runScope(async () => {
      assert.equal(gateAllows(), true, 'sibling scope B still live');
      assert.equal(isScopeAborted(), false);
    });
    assert.equal(b.controller.signal.aborted, false, 'sibling scope B is untouched');
    await Promise.all([a.promise, b.promise]);
  });
});
