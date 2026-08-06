'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildPropProfessorCookieHeader,
  createPropProfessorClient,
  createTimeoutError,
  fetchAccessToken,
  isAbortLikeError,
  normalizeSelectionId,
  parseRetryAfterDelayMs,
  readAuthState,
  __getOddsHistoryGateStateForTests
} = require('../lib/propprofessor-api');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');
const { getLookbackHours, DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS } = require('../lib/propprofessor-mcp-ranked-screen');

function makeTempAuthState(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-auth-'));
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  return { dir, file };
}

describe('readAuthState', () => {
  it('reads a saved auth.json payload', () => {
    const { dir, file } = makeTempAuthState({ cookies: [{ name: 'x', value: '1' }], origins: [] });

    try {
      const state = readAuthState(file);
      assert.equal(state.cookies.length, 1);
      assert.equal(state.cookies[0].name, 'x');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildPropProfessorCookieHeader', () => {
  it('keeps only propprofessor cookies', () => {
    const header = buildPropProfessorCookieHeader({
      cookies: [
        { domain: '.propprofessor.com', name: 'a', value: '1' },
        { domain: 'app.propprofessor.com', name: 'b', value: '2' },
        { domain: '.google.com', name: 'c', value: '3' },
        { domain: 'notpropprofessor.com', name: 'd', value: '4' }
      ]
    });

    assert.equal(header, 'a=1; b=2');
  });
});

describe('normalizeSelectionId', () => {
  it('strips a sportsbook prefix when the id has more than two colon-delimited parts', () => {
    assert.equal(
      normalizeSelectionId('Rebet:Point_Spread:San_Antonio_Spurs_-5.5'),
      'Point_Spread:San_Antonio_Spurs_-5.5'
    );
    assert.equal(
      normalizeSelectionId('DraftKings:Player_Points:Jalen_Brunson_26.5'),
      'Player_Points:Jalen_Brunson_26.5'
    );
  });

  it('leaves already-normalized ids unchanged', () => {
    assert.equal(normalizeSelectionId('Point_Spread:San_Antonio_Spurs_-5.5'), 'Point_Spread:San_Antonio_Spurs_-5.5');
  });
});

describe('timeout helpers', () => {
  it('recognizes abort-like errors and tags timeout failures', () => {
    assert.equal(isAbortLikeError({ name: 'AbortError' }), true);
    assert.equal(isAbortLikeError({ code: 'ABORT_ERR' }), true);
    assert.equal(isAbortLikeError({ message: 'boom' }), false);

    const error = createTimeoutError({ source: 'HTTP', timeoutMs: 3210, cause: new Error('aborted') });
    assert.equal(error.code, 'PROPPROFESSOR_TIMEOUT_ERROR');
    assert.equal(error.category, 'transport');
    assert.equal(error.retryable, true);
    assert.match(error.message, /3210ms/);
  });
});

describe('fetchAccessToken', () => {
  it('uses the auth cookies and returns the token payload', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [
        { domain: '.propprofessor.com', name: '__Secure-next-auth.session-token', value: 'abc' },
        { domain: '.example.com', name: 'ignore', value: 'nope' }
      ],
      origins: []
    });

    const calls = [];
    const result = await fetchAccessToken({
      authFile: file,
      gotScrapingImpl: async (options) => {
        calls.push(options);
        return {
          body: JSON.stringify({
            token: 'jwt-token',
            exp: Math.floor(Date.now() / 1000) + 600,
            perm: { sportsbook: true, fantasy: true }
          }),
          statusCode: 200
        };
      }
    });

    try {
      assert.equal(result.token, 'jwt-token');
      assert.equal(result.perm.sportsbook, true);
      assert.equal(calls.length, 1);
      assert.match(calls[0].headers.Cookie, /__Secure-next-auth\.session-token=abc/);
      assert.equal(calls[0].url, 'https://app.propprofessor.com/api/access-token');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mentions the resolved auth file path when no PropProfessor cookies are present', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.example.com', name: 'ignore', value: 'nope' }],
      origins: []
    });

    try {
      await assert.rejects(fetchAccessToken({ authFile: file }), (error) => {
        assert.match(error.message, /No PropProfessor cookies found/);
        assert.match(
          error.message,
          new RegExp(path.escape ? path.escape(file) : file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        );
        return true;
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ranked screen lookback defaults', () => {
  it('uses the shared default lookback when args omit lookbackHours', () => {
    assert.equal(getLookbackHours({}), DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS);
  });

  it('keeps explicit lookbackHours overrides', () => {
    assert.equal(getLookbackHours({ lookbackHours: 8 }), 8);
  });
});

describe('createPropProfessorClient', () => {
  let nowMs;
  beforeEach(() => {
    nowMs = Date.parse('2026-04-20T22:58:00.000Z');
  });

  it('caches access tokens until close to expiry and posts JSON requests with bearer auth', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });

    const tokenCalls = [];
    const fetchCalls = [];
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async (options) => {
        tokenCalls.push(options);
        return {
          body: JSON.stringify({
            token: 'jwt-1',
            exp: Math.floor((nowMs + 10 * 60 * 1000) / 1000),
            perm: { sportsbook: true, fantasy: true }
          }),
          statusCode: 200
        };
      },
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([{ id: 'row-1', player: 'James Harden' }])
        };
      },
      now: () => nowMs
    });

    try {
      const first = await client.querySportsbook({ leagues: ['NBA'] });
      const second = await client.querySportsbook({ leagues: ['NBA'] });

      assert.equal(tokenCalls.length, 1);
      assert.equal(fetchCalls.length, 2);
      assert.equal(first[0].player, 'James Harden');
      assert.equal(second[0].player, 'James Harden');
      assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer jwt-1');
      assert.equal(fetchCalls[0].options.headers['Content-Type'], 'application/json');
      assert.equal(fetchCalls[0].options.headers.Origin, 'https://app.propprofessor.com');
      assert.equal(fetchCalls[0].options.headers.Referer, 'https://app.propprofessor.com/');
      assert.equal(fetchCalls[0].url, 'https://backend.propprofessor.com/sportsbook');
      assert.equal(JSON.parse(fetchCalls[0].options.body).leagues[0], 'NBA');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('posts odds screen queries to the screen retrieve endpoint', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });

    const fetchCalls = [];
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({
          token: 'jwt-screen',
          exp: Math.floor(Date.now() / 1000) + 600,
          perm: { sportsbook: true }
        }),
        statusCode: 200
      }),
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'row-1', updatedAt: new Date().toISOString() }]
        };
      }
    });

    try {
      const rows = await client.queryScreenOdds({ market: 'Moneyline', league: 'NBA', books: ['FanDuel'] });
      assert.equal(fetchCalls[0].url, 'https://backend.propprofessor.com/screen');
      assert.equal(JSON.parse(fetchCalls[0].options.body).books[0], 'FanDuel');
      assert.equal(JSON.parse(fetchCalls[0].options.body).market, 'Moneyline');
      assert.equal(rows[0].id, 'row-1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes screen league names to the backend-supported casing', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });

    const fetchCalls = [];
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({
          token: 'jwt-screen',
          exp: Math.floor(Date.now() / 1000) + 600,
          perm: { sportsbook: true }
        }),
        statusCode: 200
      }),
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => []
        };
      }
    });

    try {
      await client.queryScreenOdds({ market: 'Moneyline', league: 'SOCCER', books: ['NoVigApp'] });
      await client.queryScreenOdds({ market: 'Moneyline', league: 'TENNIS', books: ['NoVigApp'] });
      await client.queryScreenOddsBestComps({ market: 'Moneyline', league: 'SOCCER' });
      const first = JSON.parse(fetchCalls[0].options.body);
      const second = JSON.parse(fetchCalls[1].options.body);
      const third = JSON.parse(fetchCalls[2].options.body);
      assert.equal(first.league, 'Soccer');
      assert.equal(second.league, 'Tennis');
      assert.equal(third.league, 'Soccer');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('canonicalizes MLS screen league aliases before posting', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });

    const fetchCalls = [];
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({
          token: 'jwt-screen',
          exp: Math.floor(Date.now() / 1000) + 600,
          perm: { sportsbook: true }
        }),
        statusCode: 200
      }),
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => []
        };
      }
    });

    try {
      await client.queryScreenOdds({ market: 'Moneyline', league: 'MLS', books: ['NoVigApp'] });
      await client.queryScreenOdds({ market: 'Moneyline', league: 'Major League Soccer', books: ['NoVigApp'] });
      await client.queryScreenOdds({ market: 'Moneyline', league: 'mls', books: ['NoVigApp'] });
      await client.queryScreenOdds({ market: 'Moneyline', league: 'Soccer', books: ['NoVigApp'] });
      assert.equal(JSON.parse(fetchCalls[0].options.body).league, 'MLS');
      assert.equal(JSON.parse(fetchCalls[1].options.body).league, 'MLS');
      assert.equal(JSON.parse(fetchCalls[2].options.body).league, 'MLS');
      assert.equal(JSON.parse(fetchCalls[3].options.body).league, 'Soccer');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('canonicalizes sportsbook aliases like ReBet before posting screen queries', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });

    const fetchCalls = [];
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({
          token: 'jwt-screen',
          exp: Math.floor(Date.now() / 1000) + 600,
          perm: { sportsbook: true }
        }),
        statusCode: 200
      }),
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => []
        };
      }
    });

    try {
      await client.queryScreenOdds({ market: 'Moneyline', league: 'MLB', books: ['ReBet'] });
      const first = JSON.parse(fetchCalls[0].options.body);
      assert.deepEqual(first.books, ['Rebet']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('queryScreenOddsBestComps keeps default books when books is omitted, but allows explicit undefined to pass through', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });

    const fetchCalls = [];
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({
          token: 'jwt-screen',
          exp: Math.floor(Date.now() / 1000) + 600,
          perm: { sportsbook: true }
        }),
        statusCode: 200
      }),
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => []
        };
      }
    });

    try {
      await client.queryScreenOddsBestComps({ market: 'Moneyline', league: 'NBA' });
      await client.queryScreenOddsBestComps({ market: 'Player Points', league: 'NBA' });
      await client.queryScreenOddsBestComps({ market: 'Moneyline', league: 'NBA', books: [] });
      const first = JSON.parse(fetchCalls[0].options.body);
      const second = JSON.parse(fetchCalls[1].options.body);
      const third = JSON.parse(fetchCalls[2].options.body);
      assert.deepEqual(first.books, ['Circa', 'Pinnacle', 'BookMaker', 'BetOnline', 'DraftKings']);
      assert.deepEqual(second.books, ['FanDuel', 'BookMaker', 'PropBuilder', 'NoVigApp', 'Pinnacle']);
      assert.deepEqual(third.books, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes a raw fantasy query helper that posts to the slipgen fantasy endpoint', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });

    const fetchCalls = [];
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({
          token: 'jwt-fantasy',
          exp: Math.floor(Date.now() / 1000) + 600,
          perm: { sportsbook: true, fantasy: true }
        }),
        statusCode: 200
      }),
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => ({ rows: [{ id: 'fantasy-row-1' }] })
        };
      }
    });

    try {
      assert.equal(typeof client.queryFantasyPicks, 'function');
      const payload = await client.queryFantasyPicks({
        sportsbook: 'DraftKings6',
        league: 'NBA',
        market: 'Fantasy Points'
      });
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, 'https://slipgen.propprofessor.com/fantasy-picks');
      const body = JSON.parse(fetchCalls[0].options.body);
      assert.equal(body.sportsbook, 'DraftKings6');
      assert.equal(body.league, 'NBA');
      assert.equal(body.market, 'Fantasy Points');
      assert.deepEqual(payload, { rows: [{ id: 'fantasy-row-1' }] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('posts odds-history queries to the backend odds history endpoint', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });

    const fetchCalls = [];
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({
          token: 'jwt-history',
          exp: Math.floor(Date.now() / 1000) + 600,
          perm: { sportsbook: true }
        }),
        statusCode: 200
      }),
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            FanDuel: [
              { odds: -110, start_ts: 1 },
              { odds: -120, start_ts: 2 }
            ]
          })
        };
      }
    });

    try {
      const payload = await client.queryOddsHistory({
        gameId: 'game-1',
        selectionId: 'Rebet:Point_Spread:San_Antonio_Spurs_-5.5',
        sportsbooks: ['Rebet'],
        startTimestamp: 123
      });
      assert.equal(fetchCalls[0].url, 'https://backend.propprofessor.com/odds_history_new');
      const body = JSON.parse(fetchCalls[0].options.body);
      assert.equal(body.gameId, 'game-1');
      assert.equal(body.selectionId, 'Point_Spread:San_Antonio_Spurs_-5.5');
      assert.deepEqual(body.sportsbooks, ['Rebet']);
      assert.equal(body.startTimestamp, 123);
      assert.equal(payload.FanDuel[0].odds, -110);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops before exceeding the per-account odds-history request budget', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    let fetchAttempts = 0;
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt-history-budget', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => {
        fetchAttempts += 1;
        return { ok: true, status: 200, json: async () => ({ NoVigApp: [] }) };
      },
      retryDelaysMs: [0]
    });

    try {
      const results = await Promise.allSettled(
        Array.from({ length: 76 }, (_, index) =>
          client.queryOddsHistory({
            gameId: `game-budget-${index}`,
            selectionId: `Moneyline:Side_${index}`,
            sportsbooks: ['NoVigApp'],
            startTimestamp: 123000
          })
        )
      );
      assert.equal(fetchAttempts, 75);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 75);
      const rejected = results.find((result) => result.status === 'rejected');
      assert.equal(rejected?.reason?.code, 'ODDS_HISTORY_BUDGET_EXHAUSTED');
      const gateState = __getOddsHistoryGateStateForTests(file);
      assert.equal(gateState?.requestsStarted, 75);
      assert.equal(gateState?.haltedError, null, 'local budget exhaustion must not persist a stale halt error');
      assert.equal(gateState?.haltedUntil, 0, 'local budget exhaustion must rely on the real window rollover');
      await assert.rejects(
        client.queryOddsHistory({
          gameId: 'game-budget-follow-on',
          selectionId: 'Moneyline:Follow_On',
          sportsbooks: ['NoVigApp'],
          startTimestamp: 123000
        }),
        (error) => error?.code === 'ODDS_HISTORY_BUDGET_EXHAUSTED'
      );
      assert.equal(fetchAttempts, 75, 'follow-on calls must fail fast without bypassing the real 75-call window');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deduplicates concurrent odds-history requests across clients', async () => {
    const { getOddsHistoryCache } = require('../lib/mcp-runtime-config');
    getOddsHistoryCache().clear();
    const auth = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    let fetchAttempts = 0;
    const fetchImpl = async () => {
      fetchAttempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, status: 200, json: async () => ({ NoVigApp: [{ odds: -110, start_ts: 1 }] }) };
    };
    const clientOptions = {
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt-shared-history-cache', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl,
      retryDelaysMs: [0]
    };
    const clientA = createPropProfessorClient({ ...clientOptions, authFile: auth.file });
    const clientB = createPropProfessorClient({ ...clientOptions, authFile: auth.file });
    const params = {
      gameId: 'game-shared-cache',
      selectionId: 'Moneyline:Shared',
      sportsbooks: ['NoVigApp'],
      startTimestamp: 123000
    };

    try {
      const [first, second] = await Promise.all([clientA.queryOddsHistory(params), clientB.queryOddsHistory(params)]);
      assert.deepEqual(first, second);
      assert.equal(fetchAttempts, 1);
    } finally {
      getOddsHistoryCache().clear();
      fs.rmSync(auth.dir, { recursive: true, force: true });
    }
  });

  it('shares odds-history throttle state across clients for the same account', async () => {
    const auth = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    let fetchAttempts = 0;
    const fetchImpl = async () => {
      fetchAttempts += 1;
      return { ok: false, status: 429, text: async () => 'rate limited' };
    };
    const clientOptions = {
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt-shared-history-429', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl,
      retryDelaysMs: [0]
    };
    const clientA = createPropProfessorClient({ ...clientOptions, authFile: auth.file });
    const clientB = createPropProfessorClient({ ...clientOptions, authFile: auth.file });

    try {
      await assert.rejects(
        clientA.queryOddsHistory({ gameId: 'game-a', selectionId: 'Moneyline:Side_A' }),
        (error) => error?.status === 429
      );
      await assert.rejects(
        clientB.queryOddsHistory({ gameId: 'game-b', selectionId: 'Moneyline:Side_B' }),
        (error) => error?.status === 429
      );
      assert.equal(fetchAttempts, 1, 'the second client must honor the process-wide history cooldown');
      const gateState = __getOddsHistoryGateStateForTests(auth.file);
      const remainingCooldown = Number(gateState?.haltedUntil || 0) - Date.now();
      assert.ok(
        remainingCooldown > 0 && remainingCooldown <= 30_000,
        `expected bounded 429 cooldown, got ${remainingCooldown}`
      );
    } finally {
      fs.rmSync(auth.dir, { recursive: true, force: true });
    }
  });

  it('does not retry odds-history 429 responses without Retry-After', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    let fetchAttempts = 0;
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt-history-429', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => {
        fetchAttempts += 1;
        return { ok: false, status: 429, text: async () => 'rate limited' };
      },
      retryDelaysMs: [0, 0, 0]
    });

    try {
      await assert.rejects(
        () =>
          client.queryOddsHistory({
            gameId: 'game-429',
            selectionId: 'selection-429',
            sportsbooks: ['FanDuel']
          }),
        (error) => {
          assert.equal(error.status, 429);
          assert.equal(error.code, 'PROPPROFESSOR_BACKEND_ERROR');
          assert.equal(error.retryable, true);
          return true;
        }
      );
      assert.equal(fetchAttempts, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the original odds-history 429 throughout the shared cooldown', async () => {
    const { resetAllBreakers } = require('../lib/propprofessor-circuit-breaker');
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    resetAllBreakers();
    let fetchAttempts = 0;
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt-history-breaker', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => {
        fetchAttempts += 1;
        return { ok: false, status: 429, text: async () => 'rate limited' };
      },
      retryDelaysMs: []
    });

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await assert.rejects(
          () =>
            client.queryOddsHistory({
              gameId: `game-breaker-${attempt}`,
              selectionId: `selection-breaker-${attempt}`,
              sportsbooks: ['FanDuel']
            }),
          (error) => {
            assert.equal(error.status, 429);
            assert.equal(error.retryable, true);
            return true;
          }
        );
      }
      assert.equal(fetchAttempts, 1, 'follow-on history calls must fail fast during cooldown');
    } finally {
      resetAllBreakers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not add a five-minute gate halt when the odds-history circuit is already open', async () => {
    const { getOrCreateBreaker, resetAllBreakers } = require('../lib/propprofessor-circuit-breaker');
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    resetAllBreakers();
    const breaker = getOrCreateBreaker('https://backend.propprofessor.com/odds_history_new');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        breaker.recordFailure();
      } catch {
        // Expected when the fifth failure opens the circuit.
      }
    }
    let fetchAttempts = 0;
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt-open-history-circuit', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => {
        fetchAttempts += 1;
        return { ok: true, status: 200, json: async () => ({ NoVigApp: [] }) };
      },
      retryDelaysMs: [0]
    });

    try {
      await assert.rejects(
        client.queryOddsHistory({ gameId: 'game-open-circuit', selectionId: 'Moneyline:Side' }),
        (error) => error?.code === 'CIRCUIT_BREAKER_OPEN'
      );
      assert.equal(fetchAttempts, 0, 'open circuit must fail before network');
      const gateState = __getOddsHistoryGateStateForTests(file);
      assert.equal(gateState?.haltedError, null);
      assert.equal(gateState?.haltedUntil, 0, 'circuit timing must be owned by the breaker, not a second gate halt');
      assert.equal(gateState?.requestsStarted, 0, 'non-network circuit rejection must refund the local budget slot');
    } finally {
      resetAllBreakers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns screen-only health status when the screen endpoint fails', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });

    const fetchCalls = [];
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({
          token: 'jwt-health',
          exp: Math.floor(Date.now() / 1000) + 600,
          perm: { sportsbook: true, fantasy: true }
        }),
        statusCode: 200
      }),
      fetchImpl: async (url) => {
        fetchCalls.push(String(url));
        return {
          ok: false,
          status: 500,
          text: async () => 'screen failed'
        };
      },
      retryDelaysMs: [0]
    });

    try {
      const health = await client.healthStatus();
      assert.equal(health.ok, false);
      assert.equal(health.endpoints.screen, 'error');
      assert.equal('fantasy' in health.endpoints, false);
      assert.match(health.errors.screen, /500|screen failed/);
      assert.equal('fantasy' in health.errors, false);
      assert.equal('fantasy' in health.freshness, false);
      assert.equal(fetchCalls.length, 2);
      assert.ok(fetchCalls.every((url) => /\/screen/.test(url)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('healthStatus reports non-null freshness ages and timestamp sources for screen rows', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });

    const nowMs = Date.parse('2026-04-20T22:58:00.000Z');
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({
          token: 'jwt-health-rows',
          exp: Math.floor(nowMs / 1000) + 600,
          perm: { sportsbook: true }
        }),
        statusCode: 200
      }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          game_data: [
            { id: 'row-1', updatedAt: new Date(nowMs - 12 * 1000).toISOString() },
            { id: 'row-2', payload: { updatedAt: new Date(nowMs - 40 * 1000).toISOString() } },
            { id: 'row-3', meta: { timestamp: new Date(nowMs - 25 * 1000).toISOString() } }
          ]
        })
      }),
      now: () => nowMs
    });

    try {
      const health = await client.healthStatus();
      assert.equal(health.ok, true);
      assert.equal(health.freshness.screen.rowCount, 3);
      assert.equal(health.freshness.screen.newestAgeMs, 12000);
      assert.equal(health.freshness.screen.oldestAgeMs, 40000);
      assert.equal(health.freshness.screen.freshnessFallbackUsed, false);
      assert.deepEqual(health.freshness.screen.timestampSources, {
        updatedAt: 1,
        'payload.updatedAt': 1,
        'meta.timestamp': 1
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refreshes the token once it is near expiry', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });

    const tokenCalls = [];
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async (options) => {
        tokenCalls.push(options);
        const token = tokenCalls.length === 1 ? 'jwt-1' : 'jwt-2';
        return {
          body: JSON.stringify({
            token,
            exp: Math.floor((nowMs + 5000) / 1000),
            perm: { sportsbook: true }
          }),
          statusCode: 200
        };
      },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => '[]'
      }),
      now: () => nowMs
    });

    try {
      await client.querySmartMoney({ leagues: ['NBA'] });
      nowMs += 6000;
      await client.querySmartMoney({ leagues: ['NBA'] });

      assert.equal(tokenCalls.length, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes trpc hide payloads with dates as ISO strings', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });

    const fetchCalls = [];
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({
          token: 'jwt-hide',
          exp: Math.floor(Date.now() / 1000) + 600,
          perm: { fantasy: true }
        }),
        statusCode: 200
      }),
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true })
        };
      }
    });

    try {
      await client.hideBet({ id: 'row-1', start: new Date('2026-04-21T12:00:00.000Z') });
      const parsedInput = JSON.parse(new URL(fetchCalls[0].url).searchParams.get('input'));
      const payload = JSON.parse(parsedInput['0'].json);
      assert.equal(payload.start, '2026-04-21T12:00:00.000Z');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('screen_ranked uses the shared ranked screen flow with hydration and freshness', async () => {
    const screenCalls = [];
    const historyCalls = [];
    const handlers = createMcpHandlers({
      client: {
        queryScreenOddsBestComps: async (filters) => {
          screenCalls.push(filters);
          return {
            game_data: [
              {
                gameId: 'game-ranked-1',
                league: 'NBA',
                market: 'Moneyline',
                updatedAt: new Date(Date.now() - 30 * 1000).toISOString(),
                homeTeam: 'Boston Celtics',
                awayTeam: 'Miami Heat',
                selections: {
                  a: {
                    selection1: 'Boston Celtics',
                    participant1: 'Boston Celtics',
                    selection1Id: 'Moneyline:Boston_Celtics',
                    selection2: 'Miami Heat',
                    participant2: 'Miami Heat',
                    selection2Id: 'Moneyline:Miami_Heat',
                    odds: {
                      NoVigApp: { odds1: -142, odds2: 122 },
                      Polymarket: { odds1: -150, odds2: 128 }
                    }
                  }
                },
                defaultKey: 'a'
              }
            ]
          };
        },
        queryOddsHistory: async ({ gameId, selectionId, sportsbooks }) => {
          historyCalls.push({ gameId, selectionId, sportsbooks });
          return {
            NoVigApp: String(selectionId).includes('Boston_Celtics')
              ? [
                  { odds: -142, start_ts: 1 },
                  { odds: -155, start_ts: 2 }
                ]
              : [
                  { odds: 122, start_ts: 1 },
                  { odds: 135, start_ts: 2 }
                ],
            Polymarket: [{ odds: -150, start_ts: 3 }],
            meta: { gameId }
          };
        }
      }
    });

    const result = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Moneyline',
      books: ['NoVigApp'],
      lookbackHours: 6,
      debug: true
    });
    assert.equal(result.ok, true);
    assert.equal(result.freshness.rowCount, 2);
    assert.equal(result.freshness.newestAgeMs !== null, true);
    assert.equal(result.resultMeta.lookbackHoursUsed, 6);
    // Audit 2026-06-15: screen_ranked augments historySportsbooks with the
    // NBA Moneyline sharp-book set so the hydration step can fetch line
    // history from the consensus reference books.
    assert.deepEqual(result.resultMeta.historySportsbooksRequested, [
      'NoVigApp',
      'Circa',
      'Pinnacle',
      'BookMaker',
      'BetOnline',
      'DraftKings'
    ]);
    assert.equal(result.resultMeta.debugEnabled, true);
    assert.equal(result.resultMeta.freshnessFallbackUsed, false);
    assert.deepEqual(result.resultMeta.timestampSources, { updatedAt: 2 });
    assert.equal(result.result[0].lineHistoryAvailable, true);
    assert.equal(result.result[0].lineHistorySource, 'odds_history');
    assert.equal(result.result[0].historyGameId, 'game-ranked-1');
    assert.equal(result.result[0].normalizedSelectionId, 'Moneyline:Boston_Celtics');
    assert.equal(result.result[0].historyMatchedBy, 'selectionId');
    assert.equal(result.result[0].lineHistoryLookbackHours, 6);
    assert.equal(result.result[0].freshnessSource, 'updatedAt');
    assert.equal(result.result[0].freshnessFallbackUsed, false);
    assert.equal(typeof result.result[0].freshnessAgeMs, 'number');
    assert.equal(typeof result.result[0].clvProxyPct, 'number');
    assert.equal(result.result[0].movementMode, 'same_book');
    assert.equal(result.result[0].movementSourceBook, 'NoVigApp');
    assert.equal(result.result[0].lineHistoryUsable, true);
    assert.equal(Array.isArray(result.result[0].historySportsbooksRequested), true);
    assert.equal(typeof result.result[0].movementDebug, 'object');
    assert.equal(Array.isArray(result.result[0].filteredLineHistory), true);
    assert.equal(typeof result.result[0].openToCurrentClvPct, 'number');
    assert.equal(result.result[0].rankingProvenance.focusBook, 'NoVigApp');
    assert.equal(result.result[0].rankingProvenance.historyMatchedBy, 'selectionId');
    assert.equal(result.result[0].rankingProvenance.lineHistorySource, 'odds_history');
    assert.equal(result.result[0].rankingProvenance.normalizedSelectionId, 'Moneyline:Boston_Celtics');
    // Audit 2026-06-15: screen_ranked now augments the backend query with the
    // league's sharp-book set so consensus data populates. Previously the
    // backend was called with only the user-requested book, which left
    // consensusBookCount=0 on every row for non-sharp books (e.g. Fliff).
    assert.deepEqual(screenCalls[0].books, ['NoVigApp', 'Circa', 'Pinnacle', 'BookMaker', 'BetOnline', 'DraftKings']);
    assert.equal(historyCalls.length >= 1, true);
    assert.deepEqual(historyCalls[0].sportsbooks, [
      'NoVigApp',
      'Circa',
      'Pinnacle',
      'BookMaker',
      'BetOnline',
      'DraftKings'
    ]);
  });

  it('screen_ranked canonicalizes ReBet aliases for screen filtering and history hydration', async () => {
    const screenCalls = [];
    const historyCalls = [];
    const handlers = createMcpHandlers({
      client: {
        queryScreenOddsBestComps: async (filters) => {
          screenCalls.push(filters);
          return {
            game_data: [
              {
                gameId: 'game-rebet-1',
                league: 'MLB',
                market: 'Moneyline',
                updatedAt: new Date(Date.now() - 15 * 1000).toISOString(),
                homeTeam: 'Arizona Diamondbacks',
                awayTeam: 'Texas Rangers',
                selections: {
                  a: {
                    selection1: 'Arizona Diamondbacks',
                    participant1: 'Arizona Diamondbacks',
                    selection1Id: 'Moneyline:Arizona_Diamondbacks',
                    selection2: 'Texas Rangers',
                    participant2: 'Texas Rangers',
                    selection2Id: 'Moneyline:Texas_Rangers',
                    odds: {
                      Rebet: { odds1: -110, odds2: -110 },
                      Pinnacle: { odds1: -108, odds2: 100 }
                    }
                  }
                },
                defaultKey: 'a'
              }
            ]
          };
        },
        queryOddsHistory: async ({ gameId, selectionId, sportsbooks }) => {
          historyCalls.push({ gameId, selectionId, sportsbooks });
          return {
            Rebet: String(selectionId).includes('Arizona_Diamondbacks')
              ? [
                  { odds: -112, start_ts: 1 },
                  { odds: -110, start_ts: 2 }
                ]
              : [
                  { odds: 100, start_ts: 1 },
                  { odds: -110, start_ts: 2 }
                ]
          };
        }
      }
    });

    const result = await handlers.screen_ranked({
      league: 'MLB',
      market: 'Moneyline',
      books: ['ReBet'],
      lookbackHours: 6
    });

    assert.equal(result.ok, true);
    // Audit 2026-06-15: ReBet is canonicalized to NoVigApp for book-matching
    // purposes (see assert below: result.result[0].book === 'Rebet'), but the
    // raw books list still includes the user-requested 'Rebet' string. The
    // screen_ranked handler augments with the MLB Moneyline sharp-book set
    // so consensus data populates.
    assert.deepEqual(screenCalls[0].books, [
      'Rebet',
      'Pinnacle',
      'Circa',
      'BookMaker',
      'BetOnline',
      'DraftKings',
      'BetMGM'
    ]);
    assert.deepEqual(result.resultMeta.historySportsbooksRequested, [
      'Rebet',
      'Pinnacle',
      'Circa',
      'BookMaker',
      'BetOnline',
      'DraftKings',
      'BetMGM'
    ]);
    assert.equal(result.result.length >= 1, true);
    assert.equal(result.result[0].book, 'Rebet');
    assert.equal(historyCalls.length >= 1, true);
    assert.deepEqual(historyCalls[0].sportsbooks, [
      'Rebet',
      'Pinnacle',
      'Circa',
      'BookMaker',
      'BetOnline',
      'DraftKings',
      'BetMGM'
    ]);
  });

  it('screen_ranked omits verbose movement debug when disabled', async () => {
    const handlers = createMcpHandlers({
      client: {
        queryScreenOddsBestComps: async () => ({
          game_data: [
            {
              gameId: 'game-ranked-2',
              league: 'NBA',
              market: 'Moneyline',
              updatedAt: new Date(Date.now() - 20 * 1000).toISOString(),
              homeTeam: 'Cleveland Cavaliers',
              awayTeam: 'Detroit Pistons',
              selections: {
                a: {
                  selection1: 'Cleveland Cavaliers',
                  participant1: 'Cleveland Cavaliers',
                  selection1Id: 'Moneyline:Cleveland_Cavaliers',
                  selection2: 'Detroit Pistons',
                  participant2: 'Detroit Pistons',
                  selection2Id: 'Moneyline:Detroit_Pistons',
                  odds: {
                    NoVigApp: { odds1: -130, odds2: 110 },
                    Polymarket: { odds1: -138, odds2: 118 }
                  }
                }
              },
              defaultKey: 'a'
            }
          ]
        }),
        queryOddsHistory: async ({ gameId }) => ({
          NoVigApp: [
            { odds: -125, start_ts: 1 },
            { odds: -130, start_ts: 2 }
          ],
          meta: { gameId }
        })
      }
    });

    const result = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Moneyline',
      books: ['NoVigApp'],
      debug: false
    });

    assert.equal(result.resultMeta.debugEnabled, false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.result[0], 'movementDebug'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.result[0], 'filteredLineHistory'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.result[0], 'droppedHistoryReasons'), false);
    assert.ok(result.result[0].rankingProvenance);
  });

  it('retries once after a 401 by refreshing the access token', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    let fetchAttempts = 0;
    const tokenCalls = [];
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async (options) => {
        tokenCalls.push(options);
        return {
          body: JSON.stringify({
            token: tokenCalls.length === 1 ? 'jwt-1' : 'jwt-2',
            exp: Math.floor(Date.now() / 1000) + 600
          }),
          statusCode: 200
        };
      },
      fetchImpl: async () => {
        fetchAttempts += 1;
        if (fetchAttempts === 1) {
          return { ok: false, status: 401, text: async () => 'unauthorized' };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      retryDelaysMs: [0, 0]
    });

    try {
      const result = await client.queryScreenOdds({});
      assert.deepEqual(result, { ok: true });
      assert.equal(fetchAttempts, 2);
      assert.equal(tokenCalls.length, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries retryable rate-limit responses', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    let fetchAttempts = 0;
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => {
        fetchAttempts += 1;
        if (fetchAttempts < 3) {
          return { ok: false, status: 429, text: async () => 'rate limited' };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      retryDelaysMs: [0, 0]
    });

    try {
      const result = await client.queryScreenOdds({});
      assert.deepEqual(result, { ok: true });
      assert.equal(fetchAttempts, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records exactly one circuit breaker failure for a terminal 429 response (no double count)', async () => {
    const { resetAllBreakers, getAllBreakersInfo } = require('../lib/propprofessor-circuit-breaker');
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    resetAllBreakers();
    let fetchAttempts = 0;
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => {
        fetchAttempts += 1;
        return { ok: false, status: 429, text: async () => 'rate limited' };
      },
      retryDelaysMs: []
    });

    try {
      await assert.rejects(
        () => client.querySportsbook({ leagues: ['NBA'] }),
        (error) => {
          assert.equal(error.status, 429);
          assert.equal(error.retryable, true);
          return true;
        }
      );
      assert.equal(fetchAttempts, 1);
      const breakers = getAllBreakersInfo();
      const breaker = breakers.find((b) => b.name === 'https://backend.propprofessor.com/sportsbook');
      assert.ok(breaker, 'expected a circuit breaker for the sportsbook endpoint');
      assert.equal(breaker.failureCount, 1, 'one logical request must count as one breaker failure');
    } finally {
      resetAllBreakers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still retries 429 responses and counts one breaker failure per logical request', async () => {
    const { resetAllBreakers, getAllBreakersInfo } = require('../lib/propprofessor-circuit-breaker');
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    resetAllBreakers();
    let fetchAttempts = 0;
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => {
        fetchAttempts += 1;
        return { ok: false, status: 429, text: async () => 'rate limited' };
      },
      retryDelaysMs: [0, 0]
    });

    try {
      await assert.rejects(
        () => client.querySportsbook({ leagues: ['NBA'] }),
        (error) => {
          assert.equal(error.status, 429);
          assert.equal(error.retryable, true);
          return true;
        }
      );
      // Retry behavior preserved: retryDelaysMs [0, 0] => 3 attempts, all 429
      assert.equal(fetchAttempts, 3);
      const breakers = getAllBreakersInfo();
      const breaker = breakers.find((b) => b.name === 'https://backend.propprofessor.com/sportsbook');
      assert.ok(breaker, 'expected a circuit breaker for the sportsbook endpoint');
      assert.equal(breaker.failureCount, 1, 'one logical request must count as one breaker failure');
    } finally {
      resetAllBreakers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries timeout failures and reports them as transport errors when retries are exhausted', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });

    let fetchAttempts = 0;
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => {
        fetchAttempts += 1;
        const error = new Error('request aborted');
        error.name = 'AbortError';
        throw error;
      },
      retryDelaysMs: [0],
      requestTimeoutMs: 1
    });

    try {
      await assert.rejects(
        () => client.queryScreenOdds({}),
        (error) => {
          assert.equal(error.category, 'transport');
          assert.equal(error.code, 'PROPPROFESSOR_TIMEOUT_ERROR');
          assert.equal(error.retryable, true);
          assert.match(error.message, /timed out/i);
          return true;
        }
      );
      assert.equal(fetchAttempts, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tags 401 screen failures as auth errors with status metadata', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
      retryDelaysMs: [0]
    });

    try {
      await assert.rejects(
        () => client.queryScreenOdds({}),
        (error) => {
          assert.equal(error.category, 'auth');
          assert.equal(error.code, 'PROPPROFESSOR_AUTH_ERROR');
          assert.equal(error.status, 401);
          assert.equal(error.retryable, true);
          assert.match(error.message, /401/);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tags HTML checkpoint responses as transport errors', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        text: async () => '<html><title>Just a moment...</title></html>'
      }),
      retryDelaysMs: [0]
    });

    try {
      await assert.rejects(
        () => client.queryScreenOdds({}),
        (error) => {
          assert.equal(error.category, 'transport');
          assert.equal(error.code, 'PROPPROFESSOR_TRANSPORT_ERROR');
          assert.equal(error.status, 429);
          assert.equal(error.retryable, true);
          assert.match(error.message, /checkpoint|429|Just a moment/i);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tags 5xx TRPC failures as backend errors with status metadata', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'service unavailable' }),
      retryDelaysMs: [0]
    });

    try {
      await assert.rejects(
        () => client.getHiddenBets(),
        (error) => {
          assert.equal(error.category, 'backend');
          assert.equal(error.code, 'PROPPROFESSOR_BACKEND_ERROR');
          assert.equal(error.status, 503);
          assert.equal(error.retryable, true);
          assert.match(error.message, /503|service unavailable/i);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Retry-After handling', () => {
  it('parses numeric Retry-After seconds into a millisecond delay', () => {
    const headers = { get: (name) => (name === 'Retry-After' ? '2' : null) };
    assert.equal(parseRetryAfterDelayMs(headers), 2000);
    assert.equal(parseRetryAfterDelayMs({ get: () => '3' }), 3000);
  });

  it('returns null when the response has no headers object', () => {
    assert.equal(parseRetryAfterDelayMs(undefined), null);
    assert.equal(parseRetryAfterDelayMs(null), null);
    assert.equal(parseRetryAfterDelayMs({}), null);
  });

  it('returns null for malformed or non-positive Retry-After values', () => {
    assert.equal(parseRetryAfterDelayMs({ get: () => 'abc' }), null);
    assert.equal(parseRetryAfterDelayMs({ get: () => '0' }), null);
    assert.equal(parseRetryAfterDelayMs({ get: () => '-3' }), null);
    assert.equal(parseRetryAfterDelayMs({ get: () => 'Wed, 21 Oct 2015 07:28:00 GMT' }), null);
    assert.equal(parseRetryAfterDelayMs({ get: () => null }), null);
  });

  it('caps the Retry-After delay at 30 seconds', () => {
    assert.equal(parseRetryAfterDelayMs({ get: () => '45' }), 30_000);
    assert.equal(parseRetryAfterDelayMs({ get: () => '120' }), 30_000);
    assert.equal(parseRetryAfterDelayMs({ get: () => '3600' }), 30_000);
  });

  it('uses the 429 Retry-After header instead of the shorter generic retry delay', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    let fetchAttempts = 0;
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => {
        fetchAttempts += 1;
        if (fetchAttempts === 1) {
          return {
            ok: false,
            status: 429,
            text: async () => 'rate limited',
            headers: { get: (name) => (name === 'Retry-After' ? '1' : null) }
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      // Generic retry delays are 0 — only the Retry-After hint can explain a ~1s pause.
      retryDelaysMs: [0]
    });

    try {
      const started = Date.now();
      const result = await client.queryScreenOdds({});
      const elapsed = Date.now() - started;
      assert.deepEqual(result, { ok: true });
      assert.equal(fetchAttempts, 2);
      assert.ok(elapsed >= 900, `expected >= 900ms wait from Retry-After, got ${elapsed}ms`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries 429 responses when mocks omit headers entirely', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    let fetchAttempts = 0;
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => {
        fetchAttempts += 1;
        if (fetchAttempts < 3) {
          // Plain mock response: no headers property at all.
          return { ok: false, status: 429, text: async () => 'rate limited' };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      retryDelaysMs: [0, 0]
    });

    try {
      const result = await client.queryScreenOdds({});
      assert.deepEqual(result, { ok: true });
      assert.equal(fetchAttempts, 3, '429 without headers must still retry');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores Retry-After on non-429 responses and keeps the generic retry schedule', async () => {
    const { dir, file } = makeTempAuthState({
      cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'cookie-value' }],
      origins: []
    });
    let fetchAttempts = 0;
    const client = createPropProfessorClient({
      authFile: file,
      gotScrapingImpl: async () => ({
        body: JSON.stringify({ token: 'jwt', exp: Math.floor(Date.now() / 1000) + 600 }),
        statusCode: 200
      }),
      fetchImpl: async () => {
        fetchAttempts += 1;
        if (fetchAttempts === 1) {
          return {
            ok: false,
            status: 503,
            text: async () => 'service unavailable',
            headers: { get: (name) => (name === 'Retry-After' ? '5' : null) }
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      retryDelaysMs: [0]
    });

    try {
      const started = Date.now();
      const result = await client.queryScreenOdds({});
      const elapsed = Date.now() - started;
      assert.deepEqual(result, { ok: true });
      assert.equal(fetchAttempts, 2);
      assert.ok(elapsed < 3000, `5xx Retry-After must be ignored (would sleep 5s); got ${elapsed}ms`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('token refresh mutex', () => {
  it('only calls fetchAccessToken once when multiple concurrent getAccessToken calls happen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mutex-'));
    const authFile = path.join(dir, 'auth.json');
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        cookies: [
          { name: '__Secure-next-auth.session-token', value: 'tok', domain: 'app.propprofessor.com', expires: -1 }
        ]
      }),
      'utf8'
    );

    let fetchCount = 0;
    const fakeGotScraping = async () => {
      fetchCount += 1;
      await new Promise((r) => setTimeout(r, 200));
      return {
        statusCode: 200,
        body: JSON.stringify({ token: 'fresh_token', exp: Math.floor(Date.now() / 1000) + 3600 })
      };
    };

    try {
      const client = createPropProfessorClient({
        authFile,
        gotScrapingImpl: fakeGotScraping,
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) })
      });

      // Fire 5 concurrent requests — each will need a token
      const results = await Promise.all([
        client.getAccessToken(),
        client.getAccessToken(),
        client.getAccessToken(),
        client.getAccessToken(),
        client.getAccessToken()
      ]);

      // All should get the same token
      for (const result of results) {
        assert.equal(result.token, 'fresh_token');
      }

      // But fetchAccessToken should only have been called ONCE
      assert.equal(fetchCount, 1, `Expected 1 fetchAccessToken call, got ${fetchCount}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows a new refresh after the previous one completes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mutex-2-'));
    const authFile = path.join(dir, 'auth.json');
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        cookies: [
          { name: '__Secure-next-auth.session-token', value: 'tok', domain: 'app.propprofessor.com', expires: -1 }
        ]
      }),
      'utf8'
    );

    let fetchCount = 0;
    const fakeGotScraping = async () => {
      fetchCount += 1;
      return {
        statusCode: 200,
        body: JSON.stringify({ token: `token_${fetchCount}`, exp: Math.floor(Date.now() / 1000) + 1 })
      };
    };

    try {
      const client = createPropProfessorClient({
        authFile,
        gotScrapingImpl: fakeGotScraping,
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) })
      });

      const t1 = await client.getAccessToken();
      assert.equal(t1.token, 'token_1');
      assert.equal(fetchCount, 1);

      await new Promise((r) => setTimeout(r, 1500));

      const t2 = await client.getAccessToken();
      assert.equal(t2.token, 'token_2');
      assert.equal(fetchCount, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('concurrent calls after invalidation all wait for the same refresh', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mutex-3-'));
    const authFile = path.join(dir, 'auth.json');
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        cookies: [
          { name: '__Secure-next-auth.session-token', value: 'tok', domain: 'app.propprofessor.com', expires: -1 }
        ]
      }),
      'utf8'
    );

    let fetchCount = 0;
    const fakeGotScraping = async () => {
      fetchCount += 1;
      await new Promise((r) => setTimeout(r, 150));
      return {
        statusCode: 200,
        body: JSON.stringify({ token: `refreshed_${fetchCount}`, exp: Math.floor(Date.now() / 1000) + 3600 })
      };
    };

    try {
      const client = createPropProfessorClient({
        authFile,
        gotScrapingImpl: fakeGotScraping,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => '{"ok":true}',
          json: async () => ({ ok: true })
        })
      });

      await client.getAccessToken();
      assert.equal(fetchCount, 1);

      // Fire concurrent requests — all should wait for the same refresh
      const [t1, t2, t3] = await Promise.all([
        client.getAccessToken(),
        client.getAccessToken(),
        client.getAccessToken()
      ]);

      // Token is still valid (hasn't expired), so no new refresh should happen
      assert.equal(fetchCount, 1);
      assert.equal(t1.token, t2.token);
      assert.equal(t2.token, t3.token);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
