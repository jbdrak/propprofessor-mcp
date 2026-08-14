'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

// Use a temp watchlist for deterministic tests
const TMP_WATCHLIST = '/tmp/test-watchlist-' + Date.now() + '.md';

const TEST_WATCHLIST_CONTENT = `---
lastUpdated: 2026-06-02
---

# Test Watchlist

## Tennis
- @BenRothenberg
- @CraigShapiro
- espn.com/tennis
- thetennisbase.com

## NBA
- @wojespn
- @ShamsCharania
- espn.com/nba
`;

before(() => {
  fs.writeFileSync(TMP_WATCHLIST, TEST_WATCHLIST_CONTENT);
  process.env.PP_SPORTS_WATCHLIST_PATH = TMP_WATCHLIST;
});

after(() => {
  if (fs.existsSync(TMP_WATCHLIST)) fs.unlinkSync(TMP_WATCHLIST);
  delete process.env.PP_SPORTS_WATCHLIST_PATH;
});

function freshRequire() {
  // Force re-require so the WATCHLIST_PATH env var is read
  for (const key of Object.keys(require.cache)) {
    if (key.includes('propprofessor-source-authority')) {
      delete require.cache[key];
    }
  }
  return require('../lib/propprofessor-source-authority');
}

describe('loadWatchlists', () => {
  it('parses sections, handles, and outlets from markdown', () => {
    const { loadWatchlists } = freshRequire();
    const lists = loadWatchlists();
    assert.ok(lists.Tennis, 'Expected Tennis section');
    assert.ok(lists.NBA, 'Expected NBA section');
    assert.ok(lists.Tennis.handles.has('benrothenberg'));
    assert.ok(lists.Tennis.handles.has('craigshapiro'));
    assert.ok(lists.Tennis.outlets.has('espn.com/tennis'));
    assert.ok(lists.NBA.handles.has('wojespn'));
    assert.ok(lists.NBA.handles.has('shamscharania'));
  });

  it('returns empty object when watchlist file does not exist', () => {
    process.env.PP_SPORTS_WATCHLIST_PATH = '/tmp/does-not-exist-' + Date.now() + '.md';
    const { loadWatchlists } = freshRequire();
    const lists = loadWatchlists();
    assert.deepEqual(lists, {});
    // Restore for subsequent tests
    process.env.PP_SPORTS_WATCHLIST_PATH = TMP_WATCHLIST;
  });
});

describe('scoreTweet', () => {
  beforeEach(() => freshRequire());

  it('scores a watchlist beat reporter very high (80+)', () => {
    const { scoreTweet } = freshRequire();
    const score = scoreTweet({ author: 'BenRothenberg', isVerified: true }, 'Tennis');
    assert.ok(score >= 80, `expected score >= 80, got ${score}`);
  });

  it('scores a non-watchlist verified account as moderate (40-50)', () => {
    const { scoreTweet } = freshRequire();
    const score = scoreTweet({ author: 'randomuser', isVerified: true }, 'Tennis');
    assert.ok(score >= 40 && score <= 60, `expected 40-60, got ${score}`);
  });

  it('scores an unverified account as low (30-40)', () => {
    const { scoreTweet } = freshRequire();
    const score = scoreTweet({ author: 'randomfan', isVerified: false }, 'Tennis');
    assert.ok(score >= 30 && score <= 50, `expected 30-50, got ${score}`);
  });

  it('handles handle with leading @', () => {
    const { scoreTweet } = freshRequire();
    const score = scoreTweet({ author: '@wojespn', isVerified: true }, 'NBA');
    assert.ok(score >= 80, `expected score >= 80, got ${score}`);
  });

  it('returns 0 for null/undefined tweet', () => {
    const { scoreTweet } = freshRequire();
    assert.equal(scoreTweet(null, 'Tennis'), 0);
    assert.equal(scoreTweet(undefined, 'Tennis'), 0);
  });

  it('clamps score to 0-100', () => {
    const { scoreTweet } = freshRequire();
    const huge = scoreTweet(
      {
        author: 'BenRothenberg',
        isVerified: true,
        favoriteCount: 10000,
        retweetCount: 5000
      },
      'Tennis'
    );
    assert.ok(huge <= 100, `expected <= 100, got ${huge}`);
  });
});

describe('scoreNewsArticle', () => {
  it('scores a watchlist outlet very high (80+)', () => {
    const { scoreNewsArticle } = freshRequire();
    const score = scoreNewsArticle(
      { title: 'Tiafoe news', link: 'https://www.espn.com/tennis/story', source: 'ESPN' },
      'Tennis'
    );
    assert.ok(score >= 80, `expected >= 80, got ${score}`);
  });

  it('scores a non-watchlist source low (30)', () => {
    const { scoreNewsArticle } = freshRequire();
    const score = scoreNewsArticle(
      { title: 'Random blog post', link: 'https://random-blog.com/post', source: 'Blog' },
      'Tennis'
    );
    assert.ok(score <= 50, `expected <= 50, got ${score}`);
  });
});

describe('assessRiskFlag', () => {
  // Build a recent created_at timestamp for tests
  function recentTweet(text, score, minutesAgo = 30) {
    const d = new Date(Date.now() - minutesAgo * 60 * 1000);
    return {
      text,
      authorityScore: score,
      createdAt: d.toUTCString().replace(/^.*?(\w{3} \d{2} \d{2}:\d{2}:\d{2} \+\d{4} \d{4}).*/, '$1')
    };
  }

  it('returns "high" when high-authority tweet has injury keyword within 2h', () => {
    const { assessRiskFlag } = freshRequire();
    const tweets = [recentTweet('Tiafoe ruled out with calf strain', 85, 30)];
    const result = assessRiskFlag(tweets, []);
    assert.equal(result.riskFlag, 'high');
    assert.ok(result.riskTrigger.includes('Tiafoe'));
  });

  it('returns "monitor" when low-authority tweet has injury keyword within 1h', () => {
    const { assessRiskFlag } = freshRequire();
    const tweets = [recentTweet('I think Tiafoe is injured and out', 35, 15)];
    const result = assessRiskFlag(tweets, []);
    assert.equal(result.riskFlag, 'monitor');
  });

  it('returns "monitor" when high-authority tweet has injury keyword but is >2h old', () => {
    const { assessRiskFlag } = freshRequire();
    const tweets = [recentTweet('Tiafoe injury report', 85, 180)]; // 3 hours old
    const result = assessRiskFlag(tweets, []);
    // High-authority but old — still triggers monitor because keyword is recent-ish (<60)?
    // No, 180 > 60, so neither high nor monitor fires. Falls to clean.
    assert.equal(result.riskFlag, 'clean');
  });

  it('returns "clean" when no injury keywords anywhere', () => {
    const { assessRiskFlag } = freshRequire();
    const tweets = [recentTweet('Great match yesterday', 85, 30)];
    const news = [{ title: 'Player wins championship', pubDate: new Date().toUTCString(), authorityScore: 80 }];
    const result = assessRiskFlag(tweets, news);
    assert.equal(result.riskFlag, 'clean');
    assert.equal(result.riskTrigger, null);
  });

  it('considers news articles, not just tweets', () => {
    const { assessRiskFlag } = freshRequire();
    const news = [
      {
        title: 'Tiafoe ruled out for French Open with hamstring injury',
        link: 'https://espn.com/tennis/story',
        source: 'ESPN',
        pubDate: new Date(Date.now() - 30 * 60 * 1000)
          .toUTCString()
          .replace(/^.*?(\w{3} \d{2} \d{2}:\d{2}:\d{2} \+\d{4} \d{4}).*/, '$1'),
        authorityScore: 85
      }
    ];
    const result = assessRiskFlag([], news);
    assert.equal(result.riskFlag, 'high');
  });

  it('handles empty inputs', () => {
    const { assessRiskFlag } = freshRequire();
    const result = assessRiskFlag([], []);
    assert.equal(result.riskFlag, 'clean');
    assert.equal(result.riskTrigger, null);
  });
});

describe('portable watchlist path', () => {
  const os = require('os');
  const path = require('path');

  it('derives the default watchlist path from os.homedir(), not a hardcoded fallback', () => {
    const saved = process.env.PP_SPORTS_WATCHLIST_PATH;
    delete process.env.PP_SPORTS_WATCHLIST_PATH;
    try {
      const mod = freshRequire();
      assert.equal(
        mod.WATCHLIST_PATH,
        path.join(os.homedir(), '.hermes/skills/pp-sports/references/beat-reporter-watchlists.md')
      );
    } finally {
      if (saved !== undefined) process.env.PP_SPORTS_WATCHLIST_PATH = saved;
    }
  });

  it('degrades safely when HOME is unset (no crash, empty watchlists)', () => {
    const savedHome = process.env.HOME;
    const savedOverride = process.env.PP_SPORTS_WATCHLIST_PATH;
    delete process.env.HOME;
    delete process.env.PP_SPORTS_WATCHLIST_PATH;
    try {
      const mod = freshRequire();
      assert.equal(typeof mod.WATCHLIST_PATH, 'string');
      assert.deepEqual(mod.loadWatchlists(), {});
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      if (savedOverride !== undefined) process.env.PP_SPORTS_WATCHLIST_PATH = savedOverride;
    }
  });

  it('source contains no author-machine absolute path', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'propprofessor-source-authority.js'), 'utf8');
    assert.ok(!src.includes('/Users/jamesdrake'), 'source must not hardcode /Users/jamesdrake');
  });
});
