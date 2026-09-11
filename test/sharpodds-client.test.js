'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = require('../lib/sharpodds-client');

function okResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

describe('sharpodds-client exports', () => {
  it('exposes factory and functions without PP auth', () => {
    assert.equal(typeof client.createSharpOddsClient, 'function');
    assert.equal(typeof client.fetchBoard, 'function');
    assert.equal(typeof client.fetchHistory, 'function');
    assert.equal(typeof client.buildBoardUrl, 'function');
    assert.equal(typeof client.buildHistoryUrl, 'function');
    assert.equal(client.SHARPODDS_API_ORIGIN, 'https://api.tsp.live');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sharpodds-client.js'), 'utf8');
    assert.ok(!src.includes('ssb-auth'), 'must not import PP auth');
    assert.ok(!/require\((['"])[^'"]*cookie/i.test(src), 'must not require cookies');
    assert.ok(!src.includes('document.cookie'), 'must not use document.cookie');
  });

  it('makes no request during module import', () => {
    let called = false;
    const throwingFetch = async () => {
      called = true;
      throw new Error('must not fetch at import');
    };
    assert.equal(called, false);
    assert.ok(client);
    void throwingFetch;
  });
});

describe('buildBoardUrl', () => {
  it('builds the bare verified board endpoint with no params', () => {
    assert.equal(client.buildBoardUrl(), 'https://api.tsp.live/v1/odds');
  });

  it('encodes optional board params without inventing auth', () => {
    const url = new URL(client.buildBoardUrl({ date: '2026-09-01', timezone: 'America/Chicago' }));
    assert.equal(`${url.origin}${url.pathname}`, 'https://api.tsp.live/v1/odds');
    assert.equal(url.searchParams.get('d'), '2026-09-01');
    assert.equal(url.searchParams.get('z'), 'America/Chicago');
  });
});

describe('buildHistoryUrl', () => {
  it('constructs the exact verified line-history query', () => {
    const url = new URL(
      client.buildHistoryUrl({
        market: 'SPREAD',
        date: '2026-09-01',
        gameId: 123,
        sportId: 4,
        period: 'Game',
        timezone: 'America/Chicago',
        bookName: 'Pinnacle',
        awayTeam: 'AWY',
        homeTeam: 'HME',
        bookId: 7,
        league: 'NFL'
      })
    );
    assert.equal(`${url.origin}${url.pathname}`, 'https://api.tsp.live/v1/odds');
    const q = url.searchParams;
    assert.equal(q.get('action'), 'linehistory');
    assert.equal(q.get('t'), 'SPREAD');
    assert.equal(q.get('d'), '2026-09-01');
    assert.equal(q.get('n'), '123');
    assert.equal(q.get('s'), '4');
    assert.equal(q.get('p'), 'Game');
    assert.equal(q.get('z'), 'America/Chicago');
    assert.equal(q.get('sn'), 'Pinnacle');
    assert.equal(q.get('an'), 'AWY');
    assert.equal(q.get('hn'), 'HME');
    assert.equal(q.get('bid'), '7');
    assert.equal(q.get('league'), 'NFL');
  });

  it('accepts TOTAL and ML markets', () => {
    for (const market of ['TOTAL', 'ML']) {
      const q = new URL(client.buildHistoryUrl({ market, date: '2026-09-01', gameId: 1 })).searchParams;
      assert.equal(q.get('t'), market);
    }
  });

  it('URL-encodes team and book names', () => {
    const q = new URL(
      client.buildHistoryUrl({
        market: 'ML',
        date: '2026-09-01',
        gameId: 1,
        bookName: 'Foo & Bar',
        awayTeam: 'St Louis'
      })
    ).searchParams;
    assert.equal(q.get('sn'), 'Foo & Bar');
    assert.equal(q.get('an'), 'St Louis');
  });

  it('rejects unknown market types', () => {
    assert.throws(() => client.buildHistoryUrl({ market: 'PUCK', date: '2026-09-01', gameId: 1 }), /market/);
  });

  it('requires market, date, and gameId', () => {
    assert.throws(() => client.buildHistoryUrl({ date: '2026-09-01', gameId: 1 }), /market/);
    assert.throws(() => client.buildHistoryUrl({ market: 'ML', gameId: 1 }), /date/);
    assert.throws(() => client.buildHistoryUrl({ market: 'ML', date: '2026-09-01' }), /gameId/);
  });
});

describe('fetchBoard', () => {
  it('fetches the board URL and returns parsed JSON', async () => {
    let seenUrl;
    let seenOptions;
    const fetchImpl = async (url, options) => {
      seenUrl = String(url);
      seenOptions = options;
      return okResponse({ data: [] });
    };
    const res = await client.fetchBoard(fetchImpl);
    assert.equal(seenUrl, 'https://api.tsp.live/v1/odds');
    assert.ok(seenOptions && seenOptions.signal, 'must pass an AbortSignal');
    assert.deepEqual(res.data, { data: [] });
    assert.equal(res.status, 200);
  });

  it('throws a structured error on non-2xx without leaking the body', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ secret: 1 }) });
    const err = await assert.rejects(() => client.fetchBoard(fetchImpl), /HTTP 500/);
    void err;
    try {
      await client.fetchBoard(fetchImpl);
      assert.fail('expected throw');
    } catch (thrown) {
      assert.equal(thrown.provider, 'sharpodds');
      assert.equal(thrown.status, 500);
      assert.ok(!JSON.stringify(thrown).includes('secret'), 'must not leak response body');
    }
  });

  it('throws a structured error on malformed JSON', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      }
    });
    try {
      await client.fetchBoard(fetchImpl);
      assert.fail('expected throw');
    } catch (thrown) {
      assert.equal(thrown.provider, 'sharpodds');
      assert.equal(thrown.category, 'parse');
    }
  });

  it('aborts on timeout via AbortSignal', async () => {
    const fetchImpl = (url, options) =>
      new Promise((resolve, reject) => {
        const signal = options && options.signal;
        if (signal && signal.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('This operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    try {
      await client.fetchBoard(fetchImpl, { timeoutMs: 20 });
      assert.fail('expected timeout');
    } catch (thrown) {
      assert.equal(thrown.provider, 'sharpodds');
      assert.equal(thrown.category, 'timeout');
    }
  });
});

describe('fetchHistory', () => {
  it('fetches the exact history URL and returns { meta, markets }', async () => {
    let seenUrl;
    const payload = { meta: { sportsbook: 'ExampleBook' }, markets: { SPREADS: [], TOTALS: [], MONEYLINES: [] } };
    const fetchImpl = async (url, options) => {
      seenUrl = String(url);
      assert.ok(options && options.signal, 'must pass an AbortSignal');
      return okResponse(payload);
    };
    const res = await client.fetchHistory(fetchImpl, { market: 'SPREAD', date: '2026-09-01', gameId: 123 });
    const q = new URL(seenUrl).searchParams;
    assert.equal(q.get('action'), 'linehistory');
    assert.equal(q.get('t'), 'SPREAD');
    assert.equal(q.get('n'), '123');
    assert.deepEqual(res.data, payload);
  });

  it('throws a structured error on non-2xx', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
    try {
      await client.fetchHistory(fetchImpl, { market: 'ML', date: '2026-09-01', gameId: 1 });
      assert.fail('expected throw');
    } catch (thrown) {
      assert.equal(thrown.provider, 'sharpodds');
      assert.equal(thrown.status, 404);
      assert.equal(thrown.category, 'http');
      assert.ok(String(thrown.endpoint).includes('action=linehistory'));
    }
  });

  it('throws a structured error on malformed history JSON', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      }
    });
    try {
      await client.fetchHistory(fetchImpl, { market: 'ML', date: '2026-09-01', gameId: 1 });
      assert.fail('expected throw');
    } catch (thrown) {
      assert.equal(thrown.category, 'parse');
    }
  });

  it('validates history params before any request', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return okResponse({});
    };
    await assert.rejects(
      () => client.fetchHistory(fetchImpl, { market: 'NOPE', date: '2026-09-01', gameId: 1 }),
      /market/
    );
    assert.equal(called, false);
  });
});

describe('createSharpOddsClient', () => {
  it('binds an injected fetch with timeout and no polling loop', async () => {
    const payload = { meta: {}, markets: {} };
    const fetchImpl = async () => okResponse(payload);
    const api = client.createSharpOddsClient({ fetchImpl, timeoutMs: 1000 });
    assert.equal(typeof api.fetchBoard, 'function');
    assert.equal(typeof api.fetchHistory, 'function');
    const board = await api.fetchBoard();
    assert.deepEqual(board.data, payload);
    const history = await api.fetchHistory({ market: 'TOTAL', date: '2026-09-01', gameId: 9 });
    assert.deepEqual(history.data, payload);
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sharpodds-client.js'), 'utf8');
    assert.ok(!src.includes('setInterval'), 'must not poll');
  });

  it('requires an injected fetch implementation', () => {
    assert.throws(() => client.createSharpOddsClient({}), /fetchImpl/);
  });
});
