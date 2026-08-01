'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');

// Realistic X v2 search response shape (truncated)
const XURL_SUCCESS_RESPONSE = {
  data: [
    {
      id: '1234567890',
      text: 'Carlos Alcaraz is OUT for Wimbledon with a wrist injury',
      author_id: '111',
      created_at: '2026-06-02T12:00:00.000Z',
      public_metrics: { like_count: 2500, retweet_count: 800 }
    },
    {
      id: '1234567891',
      text: 'Alcaraz just won the French Open. Incredible.',
      author_id: '222',
      created_at: '2026-06-02T11:00:00.000Z',
      public_metrics: { like_count: 100, retweet_count: 20 }
    }
  ],
  includes: {
    users: [
      { id: '111', username: 'josemorgado', name: 'José Morgado' },
      { id: '222', username: 'tennis_fan', name: 'Tennis Fan' }
    ]
  }
};

const XURL_AUTH_ERROR = {
  title: 'Unauthorized',
  type: 'about:blank',
  status: 401,
  detail: 'Unauthorized'
};

let originalExecFile = null;

function mockExecResponse(stdout) {
  cp.execFile = (file, args, arg3, arg4) => {
    const cb = typeof arg3 === 'function' ? arg3 : arg4;
    cb(null, stdout, '');
  };
}

function mockExecError(message) {
  cp.execFile = (file, args, arg3, arg4) => {
    const cb = typeof arg3 === 'function' ? arg3 : arg4;
    cb(new Error(message));
  };
}

function clearModuleCache() {
  for (const key of Object.keys(require.cache)) {
    if (
      key.includes('propprofessor-news-sources') ||
      key.includes('propprofessor-player-context') ||
      key.includes('propprofessor-source-authority')
    ) {
      delete require.cache[key];
    }
  }
}

before(() => {
  originalExecFile = cp.execFile;
});
after(() => {
  cp.execFile = originalExecFile;
});

describe('fetchViaXurl', { concurrency: false }, () => {
  beforeEach(() => {
    clearModuleCache();
  });

  it('returns source: "xurl-failed" with hint when xurl returns 401', async () => {
    mockExecResponse(JSON.stringify(XURL_AUTH_ERROR));
    const { fetchViaXurl } = require('../lib/propprofessor-player-context');
    const result = await fetchViaXurl({ player: 'Alcaraz', sport: 'Tennis' });
    assert.equal(result.source, 'xurl-failed');
    assert.ok(result.error.includes('401'));
    assert.ok(result.error.includes('xurl auth oauth2'));
  });

  it('returns source: "xurl" with raw response on success', async () => {
    mockExecResponse(JSON.stringify(XURL_SUCCESS_RESPONSE));
    const { fetchViaXurl } = require('../lib/propprofessor-player-context');
    const result = await fetchViaXurl({ player: 'Alcaraz', sport: 'Tennis' });
    assert.equal(result.source, 'xurl');
    assert.ok(result.raw);
    assert.equal(result.raw.data.length, 2);
  });

  it('returns source: "xurl-failed" when xurl is not installed (executable error)', async () => {
    mockExecError('spawn xurl ENOENT');
    const { fetchViaXurl } = require('../lib/propprofessor-player-context');
    const result = await fetchViaXurl({ player: 'Alcaraz', sport: 'Tennis' });
    assert.equal(result.source, 'xurl-failed');
    assert.ok(result.error.includes('ENOENT'));
  });

  it('returns source: "xurl-failed" on non-JSON output', async () => {
    mockExecResponse('not valid json');
    const { fetchViaXurl } = require('../lib/propprofessor-player-context');
    const result = await fetchViaXurl({ player: 'Alcaraz', sport: 'Tennis' });
    assert.equal(result.source, 'xurl-failed');
    assert.ok(result.error.includes('non-JSON'));
  });

  // SEC-001 (June 8 audit): the player name is passed as a positional arg to
  // the xurl CLI via cp.execFile. Even though execFile doesn't shell-exec,
  // the input is still user-controlled and could trigger flag-style parsing
  // or break the CLI in subtle ways. The sanitizer rejects anything outside
  // the allowlist before the subprocess is invoked.
  it('rejects player names with shell-meta or flag-like characters', async () => {
    const { fetchViaXurl } = require('../lib/propprofessor-player-context');
    const malicious = 'Lakers; rm -rf /';
    const result = await fetchViaXurl({ player: malicious, sport: 'NBA' });
    assert.equal(result.source, 'xurl-failed');
    assert.ok(result.error.includes('rejected by sanitizer'));
  });

  it('rejects player names starting with -- (xurl flag-injection guard)', async () => {
    const { fetchViaXurl } = require('../lib/propprofessor-player-context');
    const result = await fetchViaXurl({ player: '--help', sport: 'NBA' });
    assert.equal(result.source, 'xurl-failed');
    assert.ok(result.error.includes('rejected by sanitizer'));
  });

  it('rejects empty / non-string player names', async () => {
    const { fetchViaXurl } = require('../lib/propprofessor-player-context');
    assert.equal((await fetchViaXurl({ player: '' })).source, 'xurl-failed');
    assert.equal((await fetchViaXurl({ player: null })).source, 'xurl-failed');
    assert.equal((await fetchViaXurl({ player: undefined })).source, 'xurl-failed');
    assert.equal((await fetchViaXurl({ player: 12345 })).source, 'xurl-failed');
  });
});

describe('sanitizePlayerName', { concurrency: false }, () => {
  it('accepts typical player names with spaces, hyphens, apostrophes, dots', () => {
    const { sanitizePlayerName } = require('../lib/propprofessor-player-context');
    assert.equal(sanitizePlayerName('LeBron James'), 'LeBron James');
    assert.equal(sanitizePlayerName("D'Angelo Russell"), "D'Angelo Russell");
    assert.equal(sanitizePlayerName('J.T. Realmuto'), 'J.T. Realmuto');
    assert.equal(sanitizePlayerName('Karl-Anthony Towns'), 'Karl-Anthony Towns');
  });

  it('rejects shell-meta, flag-like, and Unicode noise', () => {
    const { sanitizePlayerName } = require('../lib/propprofessor-player-context');
    assert.equal(sanitizePlayerName('a; b'), '');
    assert.equal(sanitizePlayerName('$(whoami)'), '');
    assert.equal(sanitizePlayerName('--help'), '');
    assert.equal(sanitizePlayerName('-flag'), ''); // any leading hyphen rejected
    assert.equal(sanitizePlayerName('Lakers 🏀'), '');
    assert.equal(sanitizePlayerName('name\u200Bwith\u200Bzwsp'), ''); // zero-width space
  });

  it('accepts internal hyphens (Karl-Anthony Towns style)', () => {
    const { sanitizePlayerName } = require('../lib/propprofessor-player-context');
    assert.equal(sanitizePlayerName('Karl-Anthony Towns'), 'Karl-Anthony Towns');
    assert.equal(sanitizePlayerName('Jean-Luc Picard'), 'Jean-Luc Picard');
  });

  it('rejects inputs over 100 chars', () => {
    const { sanitizePlayerName } = require('../lib/propprofessor-player-context');
    assert.equal(sanitizePlayerName('A'.repeat(101)), '');
    assert.equal(sanitizePlayerName('A'.repeat(100)), 'A'.repeat(100));
  });

  it('trims surrounding whitespace', () => {
    const { sanitizePlayerName } = require('../lib/propprofessor-player-context');
    assert.equal(sanitizePlayerName('  Alcaraz  '), 'Alcaraz');
  });

  it('returns empty string for non-string input', () => {
    const { sanitizePlayerName } = require('../lib/propprofessor-player-context');
    assert.equal(sanitizePlayerName(null), '');
    assert.equal(sanitizePlayerName(undefined), '');
    assert.equal(sanitizePlayerName(42), '');
    assert.equal(sanitizePlayerName({}), '');
  });
});

describe('extractXurlTweets', { concurrency: false }, () => {
  it('normalizes v2 response to extractTweets shape', () => {
    const { extractXurlTweets } = require('../lib/propprofessor-player-context');
    const tweets = extractXurlTweets(XURL_SUCCESS_RESPONSE);
    assert.equal(tweets.length, 2);
    assert.equal(tweets[0].text, 'Carlos Alcaraz is OUT for Wimbledon with a wrist injury');
    assert.equal(tweets[0].author, 'josemorgado');
    assert.equal(tweets[0].authorName, 'José Morgado');
    assert.equal(tweets[0].favoriteCount, 2500);
    assert.equal(tweets[0].retweetCount, 800);
    assert.equal(tweets[0].isRetweet, false);
  });

  it('handles missing includes.users gracefully', () => {
    const { extractXurlTweets } = require('../lib/propprofessor-player-context');
    const noUsers = {
      data: [{ id: '1', text: 'orphan tweet', author_id: '999', created_at: '2026-06-02T12:00:00.000Z' }]
    };
    const tweets = extractXurlTweets(noUsers);
    assert.equal(tweets.length, 1);
    assert.equal(tweets[0].author, '');
    assert.equal(tweets[0].authorName, '');
  });

  it('returns [] on null/missing data', () => {
    const { extractXurlTweets } = require('../lib/propprofessor-player-context');
    assert.deepEqual(extractXurlTweets(null), []);
    assert.deepEqual(extractXurlTweets({}), []);
    assert.deepEqual(extractXurlTweets({ data: 'not an array' }), []);
  });

  it('marks tweets starting with "RT " as isRetweet', () => {
    const { extractXurlTweets } = require('../lib/propprofessor-player-context');
    const rt = {
      data: [{ id: '1', text: 'RT @someone: hello', author_id: '1', created_at: '2026-06-02T12:00:00.000Z' }]
    };
    const tweets = extractXurlTweets(rt);
    assert.equal(tweets[0].isRetweet, true);
  });
});

describe('getPlayerContext with useXurl', { concurrency: false }, () => {
  beforeEach(() => {
    clearModuleCache();
  });

  it('routes to xurl when useXurl=true, returns source: "xurl"', async () => {
    mockExecResponse(JSON.stringify(XURL_SUCCESS_RESPONSE));
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const result = await getPlayerContext({ player: 'Alcaraz', sport: 'Tennis', useXurl: true });
    assert.equal(result.source, 'xurl');
    assert.equal(result.tweets.length, 2);
    assert.equal(result.cached, false);
    // Source-authority scoring still applies
    assert.ok(typeof result.tweets[0].authorityScore === 'number');
  });

  it('returns source: "xurl-failed" when xurl errors, with helpful error string', async () => {
    mockExecResponse(JSON.stringify(XURL_AUTH_ERROR));
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const result = await getPlayerContext({ player: 'Alcaraz', sport: 'Tennis', useXurl: true });
    assert.equal(result.source, 'xurl-failed');
    assert.equal(result.riskFlag, 'unknown');
    assert.equal(result.tweets.length, 0);
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
  });

  it('useXurl=false (default) does NOT route to xurl, uses free X path', async () => {
    // Mock the X path (python3) to return tweets, curl to return empty
    const X_FIXTURE = {
      data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [] } } } }
    };
    cp.execFile = (file, args, arg3, arg4) => {
      const cb = typeof arg3 === 'function' ? arg3 : arg4;
      const isX = file === 'python3';
      const stdout = isX ? JSON.stringify(X_FIXTURE) : '';
      cb(null, stdout, '');
    };
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const result = await getPlayerContext({ player: 'Alcaraz', sport: 'Tennis' });
    // Not xurl — should be the free X path
    assert.notEqual(result.source, 'xurl');
    assert.notEqual(result.source, 'xurl-failed');
  });

  it('useXurl=true bypasses the cache (always fresh)', async () => {
    // First call uses free path, populates cache
    cp.execFile = (file, args, arg3, arg4) => {
      const cb = typeof arg3 === 'function' ? arg3 : arg4;
      const isX = file === 'python3';
      const stdout = isX
        ? JSON.stringify({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [] } } } } })
        : '';
      cb(null, stdout, '');
    };
    const { getPlayerContext, _ctxCache } = require('../lib/propprofessor-player-context');
    await getPlayerContext({ player: 'Sinner', sport: 'Tennis' });
    const sizeBefore = _ctxCache.size();
    // Now call with useXurl — should NOT read from cache
    mockExecResponse(JSON.stringify(XURL_SUCCESS_RESPONSE));
    const result = await getPlayerContext({ player: 'Sinner', sport: 'Tennis', useXurl: true });
    assert.equal(result.cached, false);
    assert.equal(result.source, 'xurl');
    // Cache size should be unchanged — useXurl path doesn't write to cache
    assert.equal(_ctxCache.size(), sizeBefore);
  });
});
