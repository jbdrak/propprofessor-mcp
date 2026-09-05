'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPropProfessorClient } = require('../lib/propprofessor-api');
const { withPairTimeout, createCrossCallMemoizedQuery } = require('../lib/propprofessor-shared-utils');
const { runScope } = require('../lib/async-scope');

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const ok = () => ({ ok: true, status: 200, json: async () => [] });
const history = {
  gameId: 'offline-game',
  market: 'Moneyline',
  selectionId: 'Moneyline:Home',
  sportsbooks: ['Pinnacle']
};
function clientFor(t, fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cancel-'));
  const authFile = path.join(dir, 'auth.json');
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'offline-fixture' }],
      origins: []
    })
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createPropProfessorClient({
    authFile,
    fetchImpl,
    requestTimeoutMs: 2000,
    retryDelaysMs: [5],
    oddsHistoryMinIntervalMs: 0,
    gotScrapingImpl: async () => ({
      statusCode: 200,
      body: JSON.stringify({ token: 'offline-token', exp: Math.floor(Date.now() / 1000) + 3600, perm: {} })
    })
  });
}
test('scoped requests work without AbortSignal.any on early Node 20', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
  t.after(() => {
    if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor);
    else delete AbortSignal.any;
  });
  const client = clientFor(t, async () => ok());
  await assert.doesNotReject(runScope(() => client.queryOddsHistory(history)).promise);
});

function blockedFetch(signal, onAbort) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(Object.assign(new Error('fixture aborted'), { name: 'AbortError' }));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

test('pair deadline aborts a real client fetch and prevents retry or follow-up work', { timeout: 3000 }, async (t) => {
  const started = deferred();
  let starts = 0;
  let aborts = 0;
  let worker;
  const client = clientFor(t, async (_url, { signal }) => {
    starts += 1;
    started.resolve();
    return blockedFetch(signal, () => {
      aborts += 1;
    });
  });
  const run = withPairTimeout(() => {
    worker = (async () => {
      await client.queryOddsHistory(history);
      await client.queryOddsHistory({ ...history, gameId: 'must-not-start' });
    })();
    return worker;
  }, 100);
  const result = run({});
  const rejected = assert.rejects(result, { code: 'PAIR_TIMEOUT' });
  await started.promise;
  await rejected;
  await assert.rejects(worker, { code: 'PAIR_TIMEOUT', retryable: false });
  assert.equal(starts, 1);
  assert.equal(aborts, 1);
});

test('aborted history waiter leaves the queue while a live request still holds it', { timeout: 3000 }, async (t) => {
  const started = deferred();
  const release = deferred();
  let starts = 0;
  const client = clientFor(t, async () => {
    starts += 1;
    started.resolve();
    await release.promise;
    return ok();
  });
  t.after(() => release.resolve());
  const first = client.queryOddsHistory(history);
  await started.promise;
  const scope = runScope(() => client.queryOddsHistory({ ...history, gameId: 'queued' }));
  let settled = false;
  const rejected = scope.promise.catch((error) => {
    settled = true;
    assert.equal(error.code, 'PAIR_TIMEOUT');
  });
  await new Promise((r) => setImmediate(r));
  scope.controller.abort();
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, true, 'cancelled waiter must reject before holder releases');
  release.resolve();
  await Promise.all([first, rejected]);
  assert.equal(starts, 1, 'cancelled waiter never starts a request');
  await client.queryOddsHistory({ ...history, gameId: 'after-cancel' });
  assert.equal(starts, 2, 'no queue slot leaked');
});

for (const memoized of [false, true])
  test(`same history survives sibling cancellation (memoized=${memoized})`, { timeout: 3000 }, async (t) => {
    const started = deferred();
    let starts = 0;
    const client = clientFor(t, async (_url, { signal }) => {
      starts += 1;
      if (starts === 1) {
        started.resolve();
        return blockedFetch(signal, () => {});
      }
      return ok();
    });
    const query = memoized
      ? createCrossCallMemoizedQuery((args) => client.queryOddsHistory(args), {
          cache: new Map(),
          keyFn: JSON.stringify
        })
      : (args) => client.queryOddsHistory(args);
    const a = runScope(() => query(history));
    const rejection = assert.rejects(a.promise, { code: 'PAIR_TIMEOUT' });
    await started.promise;
    const b = runScope(() => query(history));
    // Observe rejection immediately, then assert outside so failures aren't unhandled.
    const bResult = b.promise.then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await new Promise((r) => setImmediate(r));
    a.controller.abort();
    await rejection;
    assert.deepEqual(await bResult, { value: [] });
    assert.equal(starts, 2);
  });
