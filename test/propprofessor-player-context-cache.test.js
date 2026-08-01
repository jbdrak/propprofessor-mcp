'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');

const TWEET_FIXTURE = {
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

let originalExecFile = null;

function mockExecSuccess() {
  cp.execFile = (file, args, arg3, arg4) => {
    const cb = typeof arg3 === 'function' ? arg3 : arg4;
    cb(null, JSON.stringify(TWEET_FIXTURE), '');
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

describe('getPlayerContext — cache behavior', { concurrency: false }, () => {
  beforeEach(() => {
    clearModuleCache();
    mockExecSuccess();
  });

  it('caches result and returns cached:true on second call', async () => {
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const first = await getPlayerContext({ player: 'Frances Tiafoe', sport: 'Tennis' });
    assert.equal(first.cached, false);
    assert.equal(first.tweets.length, 1);

    const second = await getPlayerContext({ player: 'Frances Tiafoe', sport: 'Tennis' });
    assert.equal(second.cached, true);
    // Same data, no re-fetch
    assert.equal(second.tweets.length, 1);
    assert.equal(second.tweets[0].text, 'Tiafoe wins');
  });

  it('different gameTime does not hit the same cache entry', async () => {
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const a = await getPlayerContext({ player: 'Frances Tiafoe', sport: 'Tennis', gameTime: '2026-06-02T15:00:00Z' });
    const b = await getPlayerContext({ player: 'Frances Tiafoe', sport: 'Tennis', gameTime: '2026-06-02T18:00:00Z' });
    assert.equal(a.cached, false);
    assert.equal(b.cached, false);
  });

  it('case-insensitive player/sport key normalization', async () => {
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const a = await getPlayerContext({ player: 'Frances Tiafoe', sport: 'Tennis' });
    const b = await getPlayerContext({ player: 'frances tiafoe', sport: 'tennis' });
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
  });

  it('_bypassCache=true forces a fresh fetch', async () => {
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const a = await getPlayerContext({ player: 'Tiafoe', sport: 'Tennis' });
    const b = await getPlayerContext({ player: 'Tiafoe', sport: 'Tennis', _bypassCache: true });
    assert.equal(a.cached, false);
    assert.equal(b.cached, false);
  });

  it('invalidatePlayer removes cached entries', async () => {
    const { getPlayerContext, invalidatePlayer, _ctxCache } = require('../lib/propprofessor-player-context');
    await getPlayerContext({ player: 'Carlos Alcaraz', sport: 'Tennis' });
    assert.ok(_ctxCache.size() > 0);
    invalidatePlayer('Carlos Alcaraz', 'Tennis');
    // After invalidate, next call should miss
    const next = await getPlayerContext({ player: 'Carlos Alcaraz', sport: 'Tennis' });
    assert.equal(next.cached, false);
  });
});

describe('getPlayerContext — TTL behavior', { concurrency: false }, () => {
  beforeEach(() => {
    clearModuleCache();
    mockExecSuccess();
  });

  it('uses short TTL when riskFlag is "high"', async () => {
    // We can't easily test wall-clock TTL behavior in unit tests without faking
    // time, but we can verify the constants are exported correctly and the
    // HIGH_RISK_TTL_MS is significantly shorter than DEFAULT_TTL_MS.
    const { HIGH_RISK_TTL_MS, DEFAULT_TTL_MS } = require('../lib/propprofessor-player-context');
    assert.ok(HIGH_RISK_TTL_MS < DEFAULT_TTL_MS, 'high-risk TTL should be shorter than default');
    assert.equal(HIGH_RISK_TTL_MS, 5 * 60 * 1000, 'high-risk TTL should be 5 minutes');
    assert.equal(DEFAULT_TTL_MS, 30 * 60 * 1000, 'default TTL should be 30 minutes');
  });

  it('cache key format is deterministic', () => {
    const { cacheKey } = require('../lib/propprofessor-player-context');
    const a = cacheKey('Frances Tiafoe', 'Tennis', null, 60);
    const b = cacheKey('frances tiafoe', 'tennis', '', 60);
    assert.equal(a, b, 'cache keys should normalize case');
    const c = cacheKey('Tiafoe', 'Tennis', '2026-06-02', 60);
    assert.notEqual(a, c, 'gameTime should differentiate keys');
  });
});
