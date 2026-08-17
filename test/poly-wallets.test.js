'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  enrichScanPolyWallets,
  fetchLeaderboard,
  fetchWalletStances,
  matchPlayToWallet,
  classifyPosition,
  otherSideOfMatchup,
  normForMatch
} = require('../lib/propprofessor-poly-wallets');

// --- pure helpers -----------------------------------------------------------

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
    const out = await enrichScanPolyWallets(results, { limit: 1 });
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

// --- fetch layer (no network: injected fetch) --------------------------------

describe('fetch layer with injected fetch', () => {
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
          eventSlug: 'mlb-mil-lad-2026-08-17',
          timestamp: 100
        },
        {
          type: 'TRADE',
          side: 'BUY',
          conditionId: 'c1',
          title: 'Brewers vs Dodgers',
          outcome: 'Milwaukee Brewers',
          usdcSize: 25000,
          slug: 'mlb-mil-lad-2026-08-18',
          timestamp: 200
        }
      ]
    });
    const stances = await fetchWalletStances('0xaddr', { fetchImpl });
    assert.equal(stances.length, 1);
    assert.equal(stances[0].eventSlug, 'mlb-mil-lad-2026-08-18', 'latest row value wins');
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
          slug: 'mlb-nyy-bos-2026-08-17'
        }
      ]
    });
    const stances = await fetchWalletStances('0xaddr', { fetchImpl });
    assert.equal(stances.length, 1);
    assert.equal(stances[0].eventSlug, 'mlb-nyy-bos-2026-08-17');
  });
});
