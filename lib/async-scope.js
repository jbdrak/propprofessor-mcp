'use strict';

// Per-pair cancellation reaches provider calls without threading a signal
// through every ranking/validation handler.
const { AsyncLocalStorage } = require('node:async_hooks');
const scopeStorage = new AsyncLocalStorage();

class ScopeAbortError extends Error {
  constructor(message = 'scan scope aborted') {
    super(message);
    this.name = 'ScopeAbortError';
    this.code = 'PAIR_TIMEOUT';
    this.retryable = false;
    this.category = 'scan_cancelled';
  }
}

/** @param {() => Promise<any>} fn */
function runScope(fn) {
  const controller = new AbortController();
  return { controller, promise: scopeStorage.run(controller, fn) };
}
function currentScopeController() {
  return scopeStorage.getStore() || null;
}
function currentScopeAbortSignal() {
  return currentScopeController()?.signal || null;
}
function isScopeAborted() {
  return currentScopeAbortSignal()?.aborted === true;
}
function throwIfScopeAborted() {
  if (isScopeAborted()) throw new ScopeAbortError();
}

// Settle a queued wait promptly on cancellation; observe the underlying
// promise even after abort and remove the listener on either outcome.
function waitForScope(promise) {
  const signal = currentScopeAbortSignal();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ScopeAbortError());
    const cleanup = () => signal.removeEventListener('abort', abort);
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

// Completed results may be shared, but a cancellable in-flight request must
// not belong to two independent scopes. Weak keys die with their scan.
function createScopedInflight() {
  const unscoped = new Map();
  const scoped = new WeakMap();
  return () => {
    const signal = currentScopeAbortSignal();
    if (!signal) return unscoped;
    if (!scoped.has(signal)) scoped.set(signal, new Map());
    return scoped.get(signal);
  };
}

module.exports = {
  runScope,
  currentScopeController,
  currentScopeAbortSignal,
  isScopeAborted,
  throwIfScopeAborted,
  waitForScope,
  createScopedInflight,
  ScopeAbortError
};
