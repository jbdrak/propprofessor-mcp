'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  isSettledBySlug,
  enrichScanPolyWallets,
  fetchLeaderboard,
  fetchWalletStances,
  matchPlayToWallet,
  classifyPosition,
  otherSideOfMatchup,
  normForMatch,
  matchupTeamsEqual,
  matchupTeamNorms,
  FETCH_TIMEOUT_MS,
  FALLBACK_FETCH_TIMEOUT_MS
} = require('../lib/propprofessor-poly-wallets');

// --- pure helpers -----------------------------------------------------------

/** Date suffix helper so settled/today/future slug tests never go stale at midnight. */
function slugDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
const YDAY = slugDate(-1);
const TODAY = slugDate(0);
const TOMORROW = slugDate(1);

describe('normForMatch', () => {
  it('strips punctuation and normalizes case', () => {
    assert.equal(normForMatch('Milwaukee Brewers vs. Los Angeles Dodgers'), 'MILWAUKEE BREWERS VS LOS ANGELES DODGERS');
    assert.equal(normForMatch('Badosa? / SONEgo!'), 'BADOSA SONEGO');
  });
});

describe('otherSideOfMatchup', () => {
  it('finds the other side of a vs title', () => {
    const other = otherSideOfMatchup('Milwaukee Brewers vs. Los Angeles Dodgers', 'MILWAUKEE BREWERS');
    assert.equal(other, 'LOS ANGELES DODGERS');
  });

  it('handles @ matchup titles', () => {
    const other = otherSideOfMatchup('Diamondbacks @ Braves', 'BRAVES');
    assert.equal(other, 'DIAMONDBACKS');
  });

  it('returns null for non-matchup titles', () => {
    assert.equal(otherSideOfMatchup('Will Sonego win any set?', 'SONEGO'), null);
    assert.equal(otherSideOfMatchup('Over 9.5 Games', 'SONEGO'), null);
  });
});

describe('classifyPosition', () => {
  const play = { game: 'Brewers vs Dodgers', selection: 'Milwaukee Brewers' };

  it('aligned when the wallet holds the same side', () => {
    const stance = { title: 'Milwaukee Brewers vs. Los Angeles Dodgers', outcome: 'Milwaukee Brewers', dollar: 118421 };
    assert.equal(classifyPosition(play, stance), 'aligned');
  });

  it('against when the wallet holds the other side', () => {
    const stance = {
      title: 'Milwaukee Brewers vs. Los Angeles Dodgers',
      outcome: 'Los Angeles Dodgers',
      dollar: 52000
    };
    assert.equal(classifyPosition(play, stance), 'against');
  });

  it('null when outcome is ambiguous (Yes/No prop)', () => {
    const stance = { title: 'Will Sonego beat Tiafoe?', outcome: 'Yes', dollar: 900 };
    assert.equal(classifyPosition(play, stance), null);
  });

  it('null when selection does not appear in title', () => {
    const stance = { title: 'Yankees vs Red Sox', outcome: 'Yankees', dollar: 900 };
    assert.equal(classifyPosition(play, stance), null);
  });

  it('null for short/ambiguous selections', () => {
    const shortPlay = { selection: 'LA' };
    const stance = { title: 'Los Angeles Dodgers vs. LA Lakers', outcome: 'Los Angeles Dodgers', dollar: 900 };
    assert.equal(classifyPosition(shortPlay, stance), null);
  });
});

describe('classifyPosition — totals (O/U)', () => {
  it('aligned when the wallet holds the same total direction', () => {
    const play = { game: 'Padres vs Mets', selection: 'Under 8.5' };
    const stance = { title: 'San Diego Padres vs. New York Mets: O/U 8.5', outcome: 'Under', dollar: 20000 };
    assert.equal(classifyPosition(play, stance), 'aligned');
  });

  it('does not align a different total line on the same game', () => {
    const play = { game: 'Padres vs Mets', selection: 'Over 9.5' };
    const stance = { title: 'San Diego Padres vs. New York Mets: O/U 8.5', outcome: 'Over', dollar: 20000 };
    assert.equal(classifyPosition(play, stance), null);
  });

  it('aligns worded total titles and rejects a different line', () => {
    const stance = { title: 'Total Goals Under 2.5', outcome: 'Under', dollar: 20000 };
    assert.equal(classifyPosition({ game: 'Team A vs Team B', selection: 'Under 2.5' }, stance), 'aligned');
    assert.equal(classifyPosition({ game: 'Team A vs Team B', selection: 'Under 3.5' }, stance), null);
  });

  it('against when the wallet holds the opposite total direction', () => {
    const play = { game: 'Padres vs Mets', selection: 'Over 8.5' };
    const stance = { title: 'San Diego Padres vs. New York Mets: O/U 8.5', outcome: 'Under', dollar: 20000 };
    assert.equal(classifyPosition(play, stance), 'against');
  });

  it('aligned for bare Over/Under selections', () => {
    const play = { game: 'Padres vs Mets', selection: 'Over' };
    const stance = { title: 'San Diego Padres vs. New York Mets: O/U 8.5', outcome: 'Over', dollar: 900 };
    assert.equal(classifyPosition(play, stance), 'aligned');
  });

  it('null when a total title is matched to a team selection', () => {
    const play = { game: 'Padres vs Mets', selection: 'San Diego Padres' };
    const stance = { title: 'San Diego Padres vs. New York Mets: O/U 8.5', outcome: 'Over', dollar: 900 };
    assert.equal(classifyPosition(play, stance), null);
  });
});

describe('classifyPosition — spreads', () => {
  it('aligned when the wallet holds the same spread side', () => {
    const play = { game: 'Whitecaps vs Timbers', selection: 'Vancouver Whitecaps FC -1.5' };
    const stance = { title: 'Spread: Vancouver Whitecaps FC (-1.5)', outcome: 'Vancouver Whitecaps FC', dollar: 15000 };
    assert.equal(classifyPosition(play, stance), 'aligned');
  });

  it('against when the wallet holds the other spread side of the same matchup', () => {
    const play = { game: 'Whitecaps vs Timbers', selection: 'Portland Timbers +1.5' };
    const stance = {
      title: 'Spread: Vancouver Whitecaps FC vs. Portland Timbers (-1.5)',
      outcome: 'Vancouver Whitecaps FC',
      dollar: 15000
    };
    assert.equal(classifyPosition(play, stance), 'against');
  });

  it('null when a spread selection cannot be tied to the matchup', () => {
    const play = { game: 'Whitecaps vs Timbers', selection: '-1.5' };
    const stance = { title: 'Spread: Vancouver Whitecaps FC (-1.5)', outcome: 'Vancouver Whitecaps FC', dollar: 15000 };
    assert.equal(classifyPosition(play, stance), null);
  });
});

// --- matchPlayToWallet ------------------------------------------------------

describe('matchPlayToWallet', () => {
  const walletRows = [
    {
      wallet: { proxyWallet: '0xaaa', userName: 'WhaleA', pnl: 2500000 },
      stances: [
        {
          conditionId: 'c1',
          title: 'Milwaukee Brewers vs. Los Angeles Dodgers',
          outcome: 'Milwaukee Brewers',
          dollar: 118421
        },
        {
          conditionId: 'c2',
          title: 'Arizona Diamondbacks vs. Atlanta Braves',
          outcome: 'Arizona Diamondbacks',
          dollar: 1362
        }
      ]
    },
    {
      wallet: { proxyWallet: '0xbbb', userName: 'WhaleB', pnl: -5000 },
      stances: [
        {
          conditionId: 'c3',
          title: 'Milwaukee Brewers vs. Los Angeles Dodgers',
          outcome: 'Los Angeles Dodgers',
          dollar: 52000
        },
        {
          conditionId: 'c3',
          title: 'Milwaukee Brewers vs. Los Angeles Dodgers',
          outcome: 'Los Angeles Dodgers',
          dollar: 900
        }
      ]
    }
  ];

  it('aggregates aligned dollar across wallets', () => {
    const play = { game: 'Brewers vs Dodgers', selection: 'Milwaukee Brewers' };
    const result = matchPlayToWallet(play, walletRows);
    assert.equal(result.available, true);
    assert.equal(result.coverage, 'matched');
    assert.equal(result.aligned.walletCount, 1);
    assert.equal(result.aligned.totalDollars, 118421);
    assert.equal(result.against.walletCount, 1);
    assert.equal(result.against.totalDollars, 52900);
    assert.equal(result.aligned.wallets[0].userName, 'WhaleA');
    assert.equal(result.aligned.wallets[0].lifetimePnl, 2500000);
  });

  it('no_match when no wallet holds the matchup', () => {
    const play = { game: 'Something Else', selection: 'Real Madrid' };
    const result = matchPlayToWallet(play, walletRows);
    assert.equal(result.available, true);
    assert.equal(result.coverage, 'no_match');
    assert.equal(result.aligned, null);
    assert.equal(result.against, null);
  });

  it('small stances below MIN_STANCE_USDC are excluded by the fetch layer', () => {
    const rows = [
      {
        wallet: { proxyWallet: '0xccc', userName: 'DustTrader', pnl: 100 },
        stances: [{ conditionId: 'c9', title: 'Brewers vs Dodgers', outcome: 'Milwaukee Brewers', dollar: 25 }]
      }
    ];
    const play = { selection: 'Milwaukee Brewers' };
    const result = matchPlayToWallet(play, rows);
    // match layer itself doesn't filter by size (fetch layer does) — but a
    // sub-threshold stance should never machine into a claim either.
    const { MIN_STANCE_USDC } = require('../lib/propprofessor-poly-wallets');
    assert.ok(MIN_STANCE_USDC >= 25, 'threshold sanity');
    assert.equal(result.available, true);
  });
});

// --- enrichment contract -----------------------------------------------------

describe('enrichScanPolyWallets', () => {
  it('attaches polyWallet and never throws on enricher errors', async () => {
    const results = [
      {
        league: 'mlb',
        market: 'Moneyline',
        plays: [{ game: 'Yankees vs Red Sox', selection: 'Yankees', market: 'Moneyline' }]
      }
    ];
    const out = await enrichScanPolyWallets(results, {
      limit: 2,
      leaderboardCache: { at: Date.now(), value: [{ proxyWallet: '0xaaa', userName: 'WhaleA', pnl: 1000 }] },
      fetchImpl: async (_url) => {
        const body = JSON.stringify([
          {
            type: 'TRADE',
            side: 'BUY',
            conditionId: 'c1',
            title: 'Yankees vs Red Sox',
            outcome: 'Yankees',
            usdcSize: 5000
          }
        ]);
        return { ok: true, status: 200, json: async () => JSON.parse(body) };
      }
    });
    assert.equal(out[0].plays[0].polyWallet.available, true);
    assert.equal(out[0].plays[0].polyWallet.aligned.totalDollars, 5000);
  });

  it('never clobbers an existing polyWallet', async () => {
    const results = [
      {
        league: 'mlb',
        market: 'Moneyline',
        plays: [{ game: 'A vs B', selection: 'A', polyWallet: { preexisting: true } }]
      }
    ];
    const out = await enrichScanPolyWallets(results, {
      limit: 1,
      leaderboardCache: { at: Date.now(), value: [] },
      fetchImpl: async () => {
        throw new Error('fetch should not run when the leaderboard cache is empty');
      }
    });
    assert.equal(out[0].plays[0].polyWallet.preexisting, true);
  });

  it('passes through untouched when the leaderboard fetch fails', async () => {
    const results = [{ league: 'mlb', market: 'Moneyline', plays: [{ game: 'A vs B', selection: 'A' }] }];
    const out = await enrichScanPolyWallets(results, {
      limit: 1,
      fetchImpl: async () => ({ ok: false, status: 500 })
    });
    assert.equal(out[0].plays[0].polyWallet, undefined);
  });

  it('leaves plays untouched when activity yields no usable stances', async () => {
    const results = [{ league: 'mlb', market: 'Moneyline', plays: [{ game: 'A vs B', selection: 'A' }] }];
    const out = await enrichScanPolyWallets(results, {
      limit: 1,
      leaderboardCache: { at: 0, value: [{ proxyWallet: '0xaaa', userName: 'W', pnl: 1 }] },
      fetchImpl: async () => {
        // garbage trade rows -> fetchWalletStances filters them out -> no
        // stances -> nothing attached, scan not broken
        return {
          ok: true,
          status: 200,
          json: async () => [{ type: 'TRADE', side: null, conditionId: null, outcome: null, title: null, usdcSize: 10 }]
        };
      }
    });
    assert.equal(out[0].plays[0].polyWallet, undefined);
  });
});

// --- settled filter ----------------------------------------------------------

describe('isSettledBySlug', () => {
  it('true when the slug date is before today', () => {
    assert.equal(isSettledBySlug('mlb-sea-hou-' + YDAY), true);
  });

  it('false when the slug date is today or in the future', () => {
    assert.equal(isSettledBySlug('mlb-mil-lad-' + TODAY), false);
    assert.equal(isSettledBySlug('mlb-mil-lad-' + TOMORROW), false);
  });

  it('false when the slug has no parseable trailing date', () => {
    assert.equal(isSettledBySlug('politics'), false);
    assert.equal(isSettledBySlug('crypto'), false);
  });

  it('false on a missing slug (never false-drop a real position)', () => {
    assert.equal(isSettledBySlug(''), false);
    assert.equal(isSettledBySlug(undefined), false);
    assert.equal(isSettledBySlug(null), false);
  });
});

// --- fetch layer (no network: injected fetch) --------------------------------

describe('fetch layer with injected fetch', () => {
  it('uses the current positions endpoint instead of inferring holdings from recent activity', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.startsWith('https://data-api.polymarket.com/positions')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              conditionId: 'c-ryba',
              title: 'Rybakina vs Swiatek',
              outcome: 'Elena Rybakina',
              eventSlug: 'wta-ryba-swiatek-' + TODAY,
              size: 140,
              currentValue: 202
            }
          ]
        };
      }
      throw new Error('activity should not be used when positions succeeds');
    };
    const stances = await fetchWalletStances('0xaddr', { fetchImpl });
    assert.equal(stances.length, 1);
    assert.equal(stances[0].conditionId, 'c-ryba');
    assert.equal(stances[0].dollar, 202);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /sizeThreshold=0/);
  });

  it('converts shares to dollars when currentValue is missing', async () => {
    const fetchImpl = async (url) => {
      assert.match(url, /\/positions/);
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            conditionId: 'c-value-fallback',
            title: 'A vs B',
            outcome: 'A',
            eventSlug: 'mlb-a-b-' + TODAY,
            size: 1000,
            avgPrice: 0.25
          }
        ]
      };
    };
    const stances = await fetchWalletStances('0xaddr', { fetchImpl });
    assert.equal(stances.length, 1);
    assert.equal(stances[0].dollar, 250);
  });

  it('drops positions with an explicit zero currentValue instead of using cost basis', async () => {
    const fetchImpl = async (url) => {
      assert.match(url, /\/positions/);
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            conditionId: 'c-zero-value',
            title: 'Yankees vs Red Sox',
            outcome: 'Yankees',
            eventSlug: 'mlb-nyy-bos-' + TODAY,
            size: 1000,
            avgPrice: 3,
            initialValue: 3000,
            currentValue: 0
          }
        ]
      };
    };
    const stances = await fetchWalletStances('0xaddr', { fetchImpl });
    assert.deepEqual(stances, []);
  });

  it('fetchLeaderboard parses rows and caches', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => [
          { proxyWallet: '0x1', userName: 'A', pnl: 100 },
          { proxyWallet: '0x2', userName: 'B', pnl: 50 }
        ]
      };
    };
    const cache = { at: 0, value: null };
    const lb1 = await fetchLeaderboard(2, { fetchImpl, leaderboardCache: cache });
    const lb2 = await fetchLeaderboard(2, { fetchImpl, leaderboardCache: cache });
    assert.equal(lb1.length, 2);
    assert.equal(lb2.length, 2);
    assert.equal(calls.length, 1, 'second call served from cache');
    assert.equal(lb1[0].userName, 'A');
  });

  it('fetchWalletStances nets BUY vs SELL and drops REDEEMed stances', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          type: 'TRADE',
          side: 'BUY',
          conditionId: 'c1',
          title: 'Brewers vs Dodgers',
          outcome: 'Milwaukee Brewers',
          usdcSize: 50000
        },
        {
          type: 'TRADE',
          side: 'BUY',
          conditionId: 'c1',
          title: 'Brewers vs Dodgers',
          outcome: 'Milwaukee Brewers',
          usdcSize: 30000
        },
        {
          type: 'TRADE',
          side: 'SELL',
          conditionId: 'c1',
          title: 'Brewers vs Dodgers',
          outcome: 'Milwaukee Brewers',
          usdcSize: 10000
        },
        {
          type: 'TRADE',
          side: 'BUY',
          conditionId: 'c2',
          title: 'Yankees vs Red Sox',
          outcome: 'Yankees',
          usdcSize: 50
        },
        { type: 'TRADE', side: 'BUY', conditionId: 'c3', title: 'A vs B', outcome: 'A', usdcSize: 2000 },
        { type: 'REDEEM', conditionId: 'c3', outcome: 'A' }
      ]
    });
    const stances = await fetchWalletStances('0xaddr', { fetchImpl });
    assert.equal(stances.length, 1, 'only c1 remains above threshold');
    assert.equal(stances[0].conditionId, 'c1');
    assert.equal(stances[0].dollar, 70000);
    assert.equal(stances[0].outcome, 'Milwaukee Brewers');
  });

  it('fetchWalletStances preserves eventSlug (latest row wins, slug fallback)', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          type: 'TRADE',
          side: 'BUY',
          conditionId: 'c1',
          title: 'Brewers vs Dodgers',
          outcome: 'Milwaukee Brewers',
          usdcSize: 50000,
          eventSlug: 'mlb-mil-lad-' + YDAY,
          timestamp: 100
        },
        {
          type: 'TRADE',
          side: 'BUY',
          conditionId: 'c1',
          title: 'Brewers vs Dodgers',
          outcome: 'Milwaukee Brewers',
          usdcSize: 25000,
          slug: 'mlb-mil-lad-' + TOMORROW,
          timestamp: 200
        }
      ]
    });
    const stances = await fetchWalletStances('0xaddr', { fetchImpl });
    assert.equal(stances.length, 1);
    assert.equal(stances[0].eventSlug, 'mlb-mil-lad-' + TOMORROW, 'latest row value wins');
  });

  it('fetchWalletStances drops stances on settled (yesterday) markets', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          type: 'TRADE',
          side: 'BUY',
          conditionId: 'c-settled',
          title: 'Seattle Mariners vs. Houston Astros',
          outcome: 'Houston Astros',
          usdcSize: 4779,
          eventSlug: 'mlb-sea-hou-' + YDAY
        },
        {
          type: 'TRADE',
          side: 'BUY',
          conditionId: 'c-live',
          title: 'Baltimore Orioles vs Tampa Bay Rays',
          outcome: 'Baltimore Orioles',
          usdcSize: 17000,
          eventSlug: 'mlb-bal-tbr-' + TODAY
        }
      ]
    });
    const stances = await fetchWalletStances('0xaddr', { fetchImpl });
    // Astros stance (settled) dropped; Orioles stance (today, live) kept.
    assert.equal(stances.length, 1);
    assert.equal(stances[0].conditionId, 'c-live');
    assert.equal(stances[0].outcome, 'Baltimore Orioles');
  });

  it('fetchWalletStances falls back to slug when eventSlug is absent', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => [
        {
          type: 'TRADE',
          side: 'BUY',
          conditionId: 'c2',
          title: 'Yankees vs Red Sox',
          outcome: 'Yankees',
          usdcSize: 5000,
          slug: 'mlb-nyy-bos-' + TODAY
        }
      ]
    });
    const stances = await fetchWalletStances('0xaddr', { fetchImpl });
    assert.equal(stances.length, 1);
    assert.equal(stances[0].eventSlug, 'mlb-nyy-bos-' + TODAY);
  });
});

// --- bounded timeout (fail-closed) -------------------------------------------

// A fetch shim that mirrors real `fetch`: it resolves/rejects normally, but if
// the request is aborted (our timeout signal or a caller signal) it rejects
// with an AbortError so the caller's catch degrades to its empty value.
function makeFetch({ mode }) {
  return (url, init) => {
    const signal = init && init.signal;
    if (mode === 'never') {
      return new Promise((_resolve, reject) => {
        if (signal) {
          if (signal.aborted) return reject(abortError());
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        }
      });
    }
    if (mode === 'fast') {
      if (signal && signal.aborted) return Promise.reject(abortError());
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    }
    return Promise.resolve({ ok: false, status: 500, json: async () => [] });
  };
}
function abortError() {
  return typeof DOMException === 'function'
    ? new DOMException('The operation was aborted', 'AbortError')
    : new Error('The operation was aborted');
}

describe('fetch timeouts (bounded, fail-closed)', () => {
  it('gives up and returns [] when the leaderboard fetch never resolves', async () => {
    const fetchImpl = makeFetch({ mode: 'never' });
    const start = Date.now();
    const lb = await fetchLeaderboard(5, { fetchImpl, timeoutMs: 150 });
    const elapsed = Date.now() - start;
    assert.deepEqual(lb, []);
    assert.ok(elapsed < 1200, 'must not hang; aborted within ~1s, got ' + elapsed + 'ms');
    assert.ok(elapsed >= 120, 'should wait at least the timeout window');
  });

  it('gives up and returns [] when positions + activity both never resolve', async () => {
    const fetchImpl = makeFetch({ mode: 'never' });
    const start = Date.now();
    const stances = await fetchWalletStances('0xaddr', { fetchImpl, timeoutMs: 150, fallbackTimeoutMs: 150 });
    const elapsed = Date.now() - start;
    assert.deepEqual(stances, []);
    assert.ok(elapsed < 1200, 'must not hang; aborted within ~1s, got ' + elapsed + 'ms');
  });

  it('honors a caller-provided AbortSignal alongside the timeout', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const fetchImpl = makeFetch({ mode: 'never' });
    const stances = await fetchWalletStances('0xaddr', { fetchImpl, timeoutMs: 5000, signal: ac.signal });
    assert.deepEqual(stances, []);
  });

  it('completes a fast resolve well under the timeout budget', async () => {
    const fetchImpl = makeFetch({ mode: 'fast' });
    const start = Date.now();
    const stances = await fetchWalletStances('0xaddr', { fetchImpl, timeoutMs: 5000 });
    assert.deepEqual(stances, []);
    assert.ok(Date.now() - start < 1000, 'fast path is not delayed by the timeout');
  });

  it('exposes sane default timeout constants', () => {
    assert.ok(FETCH_TIMEOUT_MS >= 1000 && FETCH_TIMEOUT_MS <= 30000, 'leaderboard/positions timeout');
    assert.ok(FALLBACK_FETCH_TIMEOUT_MS >= 1000 && FALLBACK_FETCH_TIMEOUT_MS < FETCH_TIMEOUT_MS, 'tighter fallback');
  });
});

// --- matchup attribution (cross-game) ----------------------------------------

describe('classifyPosition — cross-game attribution', () => {
  it('does NOT attribute a Lakers play to a Lakers-vs-Celtics stance', () => {
    const play = { game: 'Los Angeles Lakers vs Denver Nuggets', selection: 'Los Angeles Lakers' };
    const stance = { title: 'Los Angeles Lakers vs. Boston Celtics', outcome: 'Los Angeles Lakers', dollar: 9000 };
    assert.equal(classifyPosition(play, stance), null, 'different opponent -> no claim');
  });

  it('DOES attribute a Lakers play to a Lakers-vs-Nuggets stance', () => {
    const play = { game: 'Los Angeles Lakers vs Denver Nuggets', selection: 'Los Angeles Lakers' };
    const stance = { title: 'Los Angeles Lakers vs. Denver Nuggets', outcome: 'Los Angeles Lakers', dollar: 9000 };
    assert.equal(classifyPosition(play, stance), 'aligned');
  });

  it('against on the correct game only (not a different Lakers game)', () => {
    const play = { game: 'Los Angeles Lakers vs Denver Nuggets', selection: 'Denver Nuggets' };
    const wrong = { title: 'Los Angeles Lakers vs. Boston Celtics', outcome: 'Los Angeles Lakers', dollar: 9000 };
    const right = { title: 'Los Angeles Lakers vs. Denver Nuggets', outcome: 'Los Angeles Lakers', dollar: 9000 };
    assert.equal(classifyPosition(play, wrong), null);
    assert.equal(classifyPosition(play, right), 'against');
  });

  it('still falls back to selection-containment when the play has no matchup', () => {
    // No game context: legacy conservative rule must still attribute on a
    // shared selection name so single-team / title-only scans keep working.
    const play = { selection: 'Milwaukee Brewers' };
    const stance = { title: 'Milwaukee Brewers vs. Los Angeles Dodgers', outcome: 'Milwaukee Brewers', dollar: 5000 };
    assert.equal(classifyPosition(play, stance), 'aligned');
  });
});

describe('matchupTeamsEqual', () => {
  it('treats a short and a full matchup as the same game', () => {
    assert.equal(matchupTeamsEqual('Brewers vs Dodgers', 'Milwaukee Brewers vs Los Angeles Dodgers'), true);
  });
  it('rejects two different games sharing a team', () => {
    assert.equal(matchupTeamsEqual('Lakers vs Nuggets', 'Lakers vs Celtics'), false);
    assert.equal(matchupTeamsEqual('Yankees vs Red Sox', 'Yankees vs Mets'), false);
  });
  it('returns false for non-matchup strings', () => {
    assert.equal(matchupTeamsEqual('Will Sonego win?', 'Sonego vs Tiafoe'), false);
    assert.equal(matchupTeamsEqual('Over 9.5 Games', 'Lakers vs Nuggets'), false);
  });
  it('matchupTeamNorms returns the normalized teams', () => {
    assert.deepEqual(matchupTeamNorms('Milwaukee Brewers vs Los Angeles Dodgers'), [
      'MILWAUKEE BREWERS',
      'LOS ANGELES DODGERS'
    ]);
  });
});

// --- totals: line fidelity preserved -----------------------------------------

describe('classifyPosition — totals line mismatch (regression)', () => {
  it('null when the total line differs even on the correct game (8.5 vs 9.5)', () => {
    const play = { game: 'Padres vs Mets', selection: 'Over 9.5' };
    const stance = { title: 'San Diego Padres vs. New York Mets: O/U 8.5', outcome: 'Over', dollar: 20000 };
    assert.equal(classifyPosition(play, stance), null);
  });

  it('aligned when the total line matches on the correct game', () => {
    const play = { game: 'Padres vs Mets', selection: 'Over 8.5' };
    const stance = { title: 'San Diego Padres vs. New York Mets: O/U 8.5', outcome: 'Over', dollar: 20000 };
    assert.equal(classifyPosition(play, stance), 'aligned');
  });

  it('null when a total stance on the wrong game shares the team', () => {
    // Padres-vs-Mets stance must not attribute to a Padres-vs-Dodgers play.
    const play = { game: 'Padres vs Dodgers', selection: 'Over 8.5' };
    const stance = { title: 'San Diego Padres vs. New York Mets: O/U 8.5', outcome: 'Over', dollar: 20000 };
    assert.equal(classifyPosition(play, stance), null);
  });
});
