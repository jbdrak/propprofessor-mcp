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
                              result: {
                                legacy: {
                                  screen_name: 'BenRothenberg',
                                  name: 'Ben Rothenberg'
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                },
                {
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          __typename: 'Tweet',
                          legacy: {
                            full_text: 'RT @someone: Great point by Tiafoe',
                            favorite_count: 5,
                            retweet_count: 50,
                            created_at: 'Mon Jun 02 13:00:00 +0000 2026',
                            retweeted_status_result: {}
                          },
                          core: {
                            user_results: {
                              result: {
                                legacy: {
                                  screen_name: 'tennisfan',
                                  name: 'Tennis Fan'
                                }
                              }
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

function clearModuleCache() {
  delete require.cache[require.resolve('../lib/propprofessor-player-context')];
}

// We mock execFile by directly assigning to cp.execFile.
// mock.method() from node:test does not work with built-in child_process,
// but direct property assignment does.
let originalExecFile = null;

function mockExecFileSuccess() {
  cp.execFile = (file, args, arg3, arg4) => {
    const cb = typeof arg3 === 'function' ? arg3 : arg4;
    // Match Node's real execFile signature: (err, stdout, stderr)
    cb(null, JSON.stringify(TWEET_FIXTURE), '');
  };
}

before(() => {
  originalExecFile = cp.execFile;
});

after(() => {
  cp.execFile = originalExecFile;
});

describe('extractTweets', { concurrency: false }, () => {
  it('parses a SearchTimeline response into flat tweet objects', () => {
    const { extractTweets } = require('../lib/propprofessor-player-context');
    const tweets = extractTweets(TWEET_FIXTURE);
    assert.equal(tweets.length, 2);

    const t0 = tweets[0];
    assert.equal(t0.text, 'Tiafoe wins');
    assert.equal(t0.author, 'BenRothenberg');
    assert.equal(t0.authorName, 'Ben Rothenberg');
    assert.equal(t0.createdAt, 'Mon Jun 02 12:00:00 +0000 2026');
    assert.equal(t0.favoriteCount, 100);
    assert.equal(t0.retweetCount, 20);
    assert.equal(t0.isRetweet, false);

    const t1 = tweets[1];
    assert.equal(t1.text, 'RT @someone: Great point by Tiafoe');
    assert.equal(t1.author, 'tennisfan');
    assert.equal(t1.authorName, 'Tennis Fan');
    assert.equal(t1.isRetweet, true);
    assert.equal(t1.favoriteCount, 5);
    assert.equal(t1.retweetCount, 50);
  });

  it('handles empty response gracefully', () => {
    const { extractTweets } = require('../lib/propprofessor-player-context');
    assert.deepEqual(extractTweets(null), []);
    assert.deepEqual(extractTweets({}), []);
    assert.deepEqual(extractTweets([]), []);
  });

  it('extracts verified status when present', () => {
    const { extractTweets } = require('../lib/propprofessor-player-context');
    const fixture = {
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
                                full_text: 'Verified tweet',
                                favorite_count: 0,
                                retweet_count: 0,
                                created_at: 'Mon Jun 02 12:00:00 +0000 2026'
                              },
                              core: {
                                user_results: {
                                  result: {
                                    legacy: { screen_name: 'verifiedUser', name: 'Verified User', verified: true }
                                  }
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
    const tweets = extractTweets(fixture);
    assert.equal(tweets.length, 1);
    assert.equal(tweets[0].isVerified, true);
  });
});

describe('buildQuery', { concurrency: false }, () => {
  it('for Tennis, query is just the player name', () => {
    const { buildQuery } = require('../lib/propprofessor-player-context');
    assert.equal(buildQuery({ player: 'Frances Tiafoe', sport: 'Tennis' }), 'Frances Tiafoe');
  });

  it('for other sports, query is player name plus sport', () => {
    const { buildQuery } = require('../lib/propprofessor-player-context');
    assert.equal(buildQuery({ player: 'Luka Doncic', sport: 'NBA' }), 'Luka Doncic NBA');
    assert.equal(buildQuery({ player: 'Shohei Ohtani', sport: 'MLB' }), 'Shohei Ohtani MLB');
  });

  it('returns empty string for empty player', () => {
    const { buildQuery } = require('../lib/propprofessor-player-context');
    assert.equal(buildQuery({ player: '', sport: 'Tennis' }), '');
    assert.equal(buildQuery({ player: null, sport: 'NBA' }), '');
  });
});

describe('getPlayerContext', { concurrency: false }, () => {
  beforeEach(() => {
    // Restore then apply success mock, clear cache so module re-loads with mock
    cp.execFile = originalExecFile;
    mockExecFileSuccess();
    clearModuleCache();
  });

  it('returns { player, sport, tweets, source, fetchedAt } with mocked execFile', async () => {
    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const result = await getPlayerContext({ player: 'Frances Tiafoe', sport: 'Tennis' });

    assert.equal(result.player, 'Frances Tiafoe');
    assert.equal(result.sport, 'Tennis');
    assert.equal(result.query, 'Frances Tiafoe');
    assert.ok(Array.isArray(result.tweets));
    assert.equal(result.tweets.length, 2);
    assert.equal(result.tweets[0].text, 'Tiafoe wins');
    assert.equal(result.source, 'x-direct');
    assert.ok(typeof result.fetchedAt === 'string');
    assert.ok(result.fetchedAt.length > 0);
    // error should be undefined when successful
    assert.equal(result.error, null);
  });

  it('falls back to news when Nitter RSS and X both fail', async () => {
    // Fail both Nitter RSS (curl to localhost:8080) and X GraphQL (python3)
    cp.execFile = originalExecFile;
    cp.execFile = (file, args, arg3, arg4) => {
      const cb = typeof arg3 === 'function' ? arg3 : arg4;
      const argStr = Array.isArray(args) ? args.join(' ') : '';
      // Nitter RSS: curl to localhost:8080/search/rss
      const isNitterRss = argStr.includes('localhost:8080/search/rss');
      // X GraphQL API: python3 with 'search' arg
      const isXApi = file === 'python3' && argStr.includes('search');

      if (isNitterRss || isXApi) {
        return cb(new Error('X API unavailable'));
      }
      // Allow news calls to succeed with empty
      cb(null, '', '');
    };
    clearModuleCache();

    const { getPlayerContext } = require('../lib/propprofessor-player-context');
    const result = await getPlayerContext({ player: 'Nonexistent Player', sport: 'NBA' });

    assert.equal(result.player, 'Nonexistent Player');
    assert.equal(result.sport, 'NBA');
    assert.ok(Array.isArray(result.tweets));
    assert.equal(result.tweets.length, 0);
    // With new priority chain, X errors are caught and we fall back to news
    // Since news returns empty (mock returns ''), source becomes 'empty'
    // but error is null because news fallback succeeded (just no results)
    assert.equal(result.source, 'empty');
    assert.equal(result.error, null);
  });

  it('for Tennis, query is just player name; for other sports, query includes sport', async () => {
    const { getPlayerContext } = require('../lib/propprofessor-player-context');

    const tennisResult = await getPlayerContext({ player: 'Carlos Alcaraz', sport: 'Tennis' });
    assert.equal(tennisResult.query, 'Carlos Alcaraz');

    const nbaResult = await getPlayerContext({ player: 'LeBron James', sport: 'NBA' });
    assert.equal(nbaResult.query, 'LeBron James NBA');
  });
});
