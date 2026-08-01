'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');

// Real Google News RSS for Frances Tiafoe (recorded during Phase 0 smoke test).
// Multiple <item> entries with title, link, pubDate, source. Some titles are
// wrapped in <![CDATA[...]]>, some are not.
const GOOGLE_NEWS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Test Feed</title>
<item>
  <title><![CDATA[French Open: Tiafoe storms back vs Faria - Yahoo Sports]]></title>
  <link>https://news.yahoo.com/french-open-tiafoe-faria-12345.html</link>
  <pubDate>Mon, 02 Jun 2026 14:23:00 GMT</pubDate>
  <source url="https://sports.yahoo.com">Yahoo Sports</source>
</item>
<item>
  <title>Roland-Garros: Arnaldi stuns Tiafoe in 5 sets</title>
  <link>https://www.espn.com/tennis/story/_/id/12345</link>
  <pubDate>Mon, 02 Jun 2026 18:45:00 GMT</pubDate>
  <source>ESPN</source>
</item>
<item>
  <title>Random unrelated article about cooking</title>
  <link>https://example.com/cooking</link>
  <pubDate>Sun, 01 Jun 2026 09:00:00 GMT</pubDate>
  <source>Example Blog</source>
</item>
</channel></rss>`;

const EMPTY_RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Empty</title></channel></rss>`;

const X_TWEET_FIXTURE = {
  data: {
    search_by_raw_query: {
      search_timeline: {
        timeline: {
          instructions: [
            {
              type: 'TimelineAddEntries',
              entries: [
                {
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          __typename: 'Tweet',
                          legacy: {
                            full_text: 'Tiafoe wins',
                            favorite_count: 100,
                            retweet_count: 20,
                            created_at: 'Mon Jun 02 12:00:00 +0000 2026'
                          },
                          core: {
                            user_results: {
                              result: { legacy: { screen_name: 'BenRothenberg', name: 'Ben Rothenberg' } }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              ]
            }
          ]
        }
      }
    }
  }
};

const X_EMPTY_FIXTURE = {
  data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [] } } } }
};

const ESPN_FIXTURE = `<html><body>
<a class="result-link" href="https://www.espn.com/tennis/story/_/id/99999-tiafoe-injury">Tiafoe injury update from ESPN</a>
<a class="result-link" href="https://www.espn.com/nba/story/_/id/88888-lebron">LeBron scores 40</a>
</body></html>`;

let originalExecFile = null;

function mockCurlSuccess(stdout) {
  cp.execFile = (file, args, arg3, arg4) => {
    const cb = typeof arg3 === 'function' ? arg3 : arg4;
    cb(null, stdout, '');
  };
}

function mockCurlFailure(message) {
  cp.execFile = (file, args, arg3, arg4) => {
    const cb = typeof arg3 === 'function' ? arg3 : arg4;
    cb(new Error(message));
  };
}

function clearModuleCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('propprofessor-news-sources') || key.includes('propprofessor-player-context')) {
      delete require.cache[key];
    }
  }
}

/**
 * Mock factory for getPlayerContext execFile calls.
 * Distinguishes between Nitter RSS (curl to localhost:8080/search/rss),
 * Google News RSS (curl to news.google.com), ESPN (curl to espn.com),
 * and X GraphQL API (python3 search).
 */
function mockPlayerContextExecFile({
  nitterRssResponse = '',
  xResponse = X_EMPTY_FIXTURE,
  newsResponse = GOOGLE_NEWS_FIXTURE,
  espnResponse = ESPN_FIXTURE,
  newsError = null,
  xError = null,
  nitterError = null
} = {}) {
  cp.execFile = (file, args, arg3, arg4) => {
    const cb = typeof arg3 === 'function' ? arg3 : arg4;

    const argStr = Array.isArray(args) ? args.join(' ') : '';
    // Nitter RSS: curl to localhost:8080/search/rss (specific URL pattern)
    const isNitterRss = argStr.includes('localhost:8080/search/rss');
    // Google News: curl to news.google.com
    const isGoogleNews = argStr.includes('news.google.com');
    // ESPN: curl to espn.com
    const isEspn = argStr.includes('espn.com');
    // X GraphQL API: python3 with 'search' arg (x-api.py script)
    const isXApi = file === 'python3' && argStr.includes('search');

    if (isNitterRss) {
      if (nitterError) return cb(nitterError);
      return cb(null, nitterRssResponse, '');
    }
    if (isGoogleNews) {
      if (newsError) return cb(newsError);
      return cb(null, newsResponse, '');
    }
    if (isEspn) {
      return cb(null, espnResponse, '');
    }
    if (isXApi) {
      if (xError) return cb(xError);
      return cb(null, JSON.stringify(xResponse), '');
    }

    // Default fallback
    cb(new Error('Unexpected execFile call: ' + argStr));
  };
}

before(() => {
  originalExecFile = cp.execFile;
});

after(() => {
  cp.execFile = originalExecFile;
});

describe('fetchGoogleNews', { concurrency: false }, () => {
  beforeEach(() => {
    clearModuleCache();
  });

  it('parses Google News RSS into flat article objects', async () => {
    mockCurlSuccess(GOOGLE_NEWS_FIXTURE);
    const { fetchGoogleNews } = require('../lib/propprofessor-news-sources');
    const articles = await fetchGoogleNews('Frances Tiafoe', 10);
    assert.equal(articles.length, 3);
    assert.equal(articles[0].title, 'French Open: Tiafoe storms back vs Faria - Yahoo Sports');
    assert.equal(articles[0].link, 'https://news.yahoo.com/french-open-tiafoe-faria-12345.html');
    assert.equal(articles[0].source, 'Yahoo Sports');
    assert.equal(articles[1].title, 'Roland-Garros: Arnaldi stuns Tiafoe in 5 sets');
    assert.equal(articles[1].source, 'ESPN');
  });

  it('respects maxResults cap', async () => {
    mockCurlSuccess(GOOGLE_NEWS_FIXTURE);
    const { fetchGoogleNews } = require('../lib/propprofessor-news-sources');
    const articles = await fetchGoogleNews('Frances Tiafoe', 2);
    assert.equal(articles.length, 2);
  });

  it('returns empty array when curl fails (graceful degradation)', async () => {
    mockCurlFailure('Connection refused');
    const { fetchGoogleNews } = require('../lib/propprofessor-news-sources');
    const articles = await fetchGoogleNews('Frances Tiafoe');
    assert.deepEqual(articles, []);
  });

  it('returns empty array on empty RSS', async () => {
    mockCurlSuccess(EMPTY_RSS);
    const { fetchGoogleNews } = require('../lib/propprofessor-news-sources');
    const articles = await fetchGoogleNews('Frances Tiafoe');
    assert.deepEqual(articles, []);
  });
});

describe('fetchEspnSearch', { concurrency: false }, () => {
  beforeEach(() => {
    clearModuleCache();
  });

  it('parses ESPN search HTML for relevant article links', async () => {
    mockCurlSuccess(ESPN_FIXTURE);
    const { fetchEspnSearch } = require('../lib/propprofessor-news-sources');
    const articles = await fetchEspnSearch('Tiafoe');
    assert.ok(articles.length >= 1);
    // Should include the Tiafoe link
    const tiafoeLink = articles.find((a) => a.link.includes('tiafoe-injury'));
    assert.ok(tiafoeLink, 'Expected tiafoe article in results');
    assert.equal(tiafoeLink.title, 'Tiafoe injury update from ESPN');
    assert.equal(tiafoeLink.source, 'ESPN');
  });

  it('returns empty array when curl fails', async () => {
    mockCurlFailure('ESPN search timed out');
    const { fetchEspnSearch } = require('../lib/propprofessor-news-sources');
    const articles = await fetchEspnSearch('Tiafoe');
    assert.deepEqual(articles, []);
  });
});

describe('getPlayerContext with news fallback', { concurrency: false }, () => {
  beforeEach(() => {
    clearModuleCache();
  });

  it('returns source "nitter-combined" when Nitter RSS returns tweets and news also returns data', async () => {
    mockPlayerContextExecFile({
      nitterRssResponse: GOOGLE_NEWS_FIXTURE, // reuse RSS fixture as Nitter RSS (same format)
      xResponse: X_EMPTY_FIXTURE
    });
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const result = await getPlayerContext({ player: 'Frances Tiafoe', sport: 'Tennis' });
    assert.equal(result.source, 'nitter-combined');
    assert.ok(result.tweets.length > 0);
    assert.ok(result.news.length > 0);
  });

  it('returns source "nitter-rss" when Nitter RSS returns tweets but news is empty', async () => {
    mockPlayerContextExecFile({
      nitterRssResponse: GOOGLE_NEWS_FIXTURE,
      xResponse: X_EMPTY_FIXTURE,
      newsResponse: '' // empty news
    });
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const result = await getPlayerContext({ player: 'Frances Tiafoe', sport: 'Tennis' });
    assert.equal(result.source, 'nitter-rss');
    assert.ok(result.tweets.length > 0);
  });

  it('returns source "combined" when Nitter RSS empty, X returns tweets, and news returns data', async () => {
    mockPlayerContextExecFile({
      nitterRssResponse: '',
      xResponse: X_TWEET_FIXTURE
    });
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const result = await getPlayerContext({ player: 'Frances Tiafoe', sport: 'Tennis' });
    assert.equal(result.source, 'combined');
    assert.equal(result.tweets.length, 1);
    assert.ok(result.news.length > 0);
  });

  it('returns source "x-direct" when Nitter RSS empty, X returns tweets, but news is empty', async () => {
    mockPlayerContextExecFile({
      nitterRssResponse: '',
      xResponse: X_TWEET_FIXTURE,
      newsResponse: ''
    });
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const result = await getPlayerContext({ player: 'Frances Tiafoe', sport: 'Tennis' });
    assert.equal(result.source, 'x-direct');
    assert.equal(result.tweets.length, 1);
  });

  it('returns source "news-fallback" when Nitter RSS and X both empty', async () => {
    mockPlayerContextExecFile({
      nitterRssResponse: '',
      xResponse: X_EMPTY_FIXTURE
    });
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const result = await getPlayerContext({ player: 'Frances Tiafoe', sport: 'Tennis' });
    assert.equal(result.source, 'news-fallback');
    assert.equal(result.tweets.length, 0);
    assert.ok(result.news.length > 0, 'Expected news to be populated from fallback');
  });

  it('returns source "empty" when Nitter RSS, X, and news all fail', async () => {
    mockPlayerContextExecFile({
      nitterRssResponse: '',
      xResponse: X_EMPTY_FIXTURE,
      newsError: new Error('Network failure'),
      espnResponse: '' // also fail ESPN
    });
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const result = await getPlayerContext({ player: 'Frances Tiafoe', sport: 'Tennis' });
    assert.equal(result.source, 'empty');
    assert.equal(result.tweets.length, 0);
    assert.equal(result.news.length, 0);
  });
});
