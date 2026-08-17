'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  leagueFromSlug,
  marketKindFromTitle,
  leagueMarketName,
  resolveStance,
  verdictForRow,
  matchStanceToRow,
  analyzeWalletPlays
} = require('../lib/propprofessor-wallet-plays');
// Required for swap-the-fetch-layer injection in the analyzeWalletPlays tests.
// The module binds these at call time, so reassigning here is visible to it.
const polyWalletsMod = require('../lib/propprofessor-poly-wallets');

const STANCE = (over = {}) => ({
  conditionId: 'c1',
  title: 'Miami Marlins vs. Philadelphia Phillies O/U 8.5',
  outcome: 'Over',
  dollar: 5000,
  eventSlug: 'mlb-mia-phi-2026-08-17',
  ...over
});

// --- leagueFromSlug -----------------------------------------------------------

describe('leagueFromSlug', () => {
  it('maps known sport prefixes to league names', () => {
    assert.equal(leagueFromSlug('mlb-mia-phi-2026-08-17'), 'MLB');
    assert.equal(leagueFromSlug('nba-mia-bos-2026-08-17'), 'NBA');
    assert.equal(leagueFromSlug('nfl-ten-cin-2026-08-17'), 'NFL');
    assert.equal(leagueFromSlug('nhl-nyr-njd-2026-08-17'), 'NHL');
    assert.equal(leagueFromSlug('wnba-ny-ct-2026-08-17'), 'WNBA');
    assert.equal(leagueFromSlug('ncaab-duke-unc-2026-08-17'), 'NCAAB');
    assert.equal(leagueFromSlug('ncaaf-ala-uga-2026-08-17'), 'NCAAF');
    assert.equal(leagueFromSlug('nbasl-nyk-bos-2026-08-17'), 'NBASL');
    assert.equal(leagueFromSlug('mls-atx-dal-2026-08-17'), 'MLS');
    assert.equal(leagueFromSlug('tennis-atp-2026-08-17'), 'Tennis');
    assert.equal(leagueFromSlug('ufc-293-2026-08-17'), 'UFC');
    assert.equal(leagueFromSlug('soccer-eng-2026-08-17'), 'Soccer');
    assert.equal(leagueFromSlug('epl-ars-che-2026-08-17'), 'Soccer');
  });

  it('is case-insensitive', () => {
    assert.equal(leagueFromSlug('MLB-MIA-PHI-2026-08-17'), 'MLB');
    assert.equal(leagueFromSlug('Tennis-ATPLondon-2026'), 'Tennis');
  });

  it('returns null for empty or unknown slugs', () => {
    assert.equal(leagueFromSlug(''), null);
    assert.equal(leagueFromSlug(undefined), null);
    assert.equal(leagueFromSlug('cricket-ind-aus-2026-08-17'), null);
    assert.equal(leagueFromSlug('abc-def'), null);
  });
});

// --- marketKindFromTitle ------------------------------------------------------

describe('marketKindFromTitle', () => {
  it('classifies O/U and Over/Under-with-number titles as total', () => {
    assert.equal(marketKindFromTitle('Miami Marlins vs. Philadelphia Phillies O/U 8.5'), 'total');
    assert.equal(marketKindFromTitle('Over 9.5 Games'), 'total');
    assert.equal(marketKindFromTitle('Total Goals Under 2.5'), 'total');
  });

  it('classifies spread prefixes and parenthesized handicaps as spread', () => {
    assert.equal(marketKindFromTitle('Spread: Cincinnati +1.5'), 'spread');
    assert.equal(marketKindFromTitle('Brewers vs. Dodgers (-1.5)'), 'spread');
    assert.equal(marketKindFromTitle('Team A vs. Team B (+2)'), 'spread');
  });

  it('classifies plain matchups as moneyline and everything else as null', () => {
    assert.equal(marketKindFromTitle('Miami Heat vs. Boston Celtics'), 'moneyline');
    // 'ou' inside "Houston" must not trip the O/U token
    assert.equal(marketKindFromTitle('Houston Astros vs. Texas Rangers'), 'moneyline');
    assert.equal(marketKindFromTitle('Diamondbacks @ Braves'), 'moneyline');
    assert.equal(marketKindFromTitle('Will Sonego win any set?'), null);
    assert.equal(marketKindFromTitle(''), null);
    assert.equal(marketKindFromTitle(undefined), null);
  });
});

// --- leagueMarketName ------------------------------------------------------------

describe('leagueMarketName', () => {
  it('moneyline is always Moneyline', () => {
    assert.equal(leagueMarketName('MLB', 'moneyline'), 'Moneyline');
    assert.equal(leagueMarketName('Tennis', 'moneyline'), 'Moneyline');
    assert.equal(leagueMarketName('UFC', 'moneyline'), 'Moneyline');
  });

  it('resolves spread markets per league with fallback', () => {
    assert.equal(leagueMarketName('MLB', 'spread'), 'Run Line');
    assert.equal(leagueMarketName('NBA', 'spread'), 'Point Spread');
    assert.equal(leagueMarketName('NHL', 'spread'), 'Puck Line');
    assert.equal(leagueMarketName('Tennis', 'spread'), 'Set Handicap');
    assert.equal(leagueMarketName('Soccer', 'spread'), 'Match Handicap');
  });

  it('resolves total markets per league', () => {
    assert.equal(leagueMarketName('MLB', 'total'), 'Total Runs');
    assert.equal(leagueMarketName('Tennis', 'total'), 'Total Games');
    assert.equal(leagueMarketName('UFC', 'total'), 'Total Rounds');
  });

  it('returns null for unknown league or unknown kind', () => {
    assert.equal(leagueMarketName(null, 'moneyline'), null);
    assert.equal(leagueMarketName(undefined, 'total'), null);
    assert.equal(leagueMarketName('Cricket', 'total'), null);
    assert.equal(leagueMarketName('MLB', 'weird'), null);
  });
});

// --- resolveStance ----------------------------------------------------------------

describe('resolveStance', () => {
  it('resolves a moneyline stance to its outcome', () => {
    const r = resolveStance({
      title: 'Miami Heat vs. Boston Celtics',
      outcome: 'Miami Heat',
      eventSlug: 'nba-mia-bos-2026-08-17'
    });
    assert.deepEqual(r, { league: 'NBA', marketKind: 'moneyline', selection: 'Miami Heat', line: null });
  });

  it('resolves a total stance with line from the O/U number', () => {
    const r = resolveStance(STANCE());
    assert.deepEqual(r, { league: 'MLB', marketKind: 'total', selection: 'Over', line: 8.5 });
    // short-hand outcomes normalize
    const over = resolveStance(STANCE({ outcome: 'O' }));
    const under = resolveStance(STANCE({ outcome: 'U', title: 'Miami Marlins vs. Philadelphia Phillies O/U 8.5' }));
    assert.equal(over.selection, 'Over');
    assert.equal(under.selection, 'Under');
  });

  it('returns null for a total with no parseable line or bad outcome', () => {
    assert.equal(resolveStance(STANCE({ title: 'Miami Marlins vs. Philadelphia Phillies Over 8' })), null);
    assert.equal(resolveStance(STANCE({ outcome: 'Yes' })), null);
  });

  it('resolves a spread stance with handicap line from parentheses', () => {
    const r = resolveStance({
      title: 'Brewers vs. Dodgers (-1.5)',
      outcome: 'Brewers',
      eventSlug: 'mlb-mil-lad-2026-08-17'
    });
    assert.deepEqual(r, { league: 'MLB', marketKind: 'spread', selection: 'Brewers', line: -1.5 });
    const plus = resolveStance({ title: 'Team A vs. Team B (+2)', outcome: 'Team A', eventSlug: 'soccer-eng-2026' });
    assert.equal(plus.line, 2);
    assert.equal(plus.league, 'Soccer');
  });

  it('returns null for unknown slug or unresolvable title', () => {
    assert.equal(resolveStance({ title: 'A vs. B', outcome: 'A', eventSlug: 'cricket-x-y-2026' }), null);
    assert.equal(resolveStance({ title: 'Will X win?', outcome: 'Yes', eventSlug: 'mlb-aaa-bbb-2026' }), null);
    assert.equal(resolveStance({ title: 'A vs. B', outcome: '', eventSlug: 'mlb-aaa-bbb-2026' }), null);
  });
});

// --- verdictForRow -----------------------------------------------------------------

describe('verdictForRow', () => {
  it('PASSes on adverse movement with the actual value in the reason', () => {
    assert.deepEqual(verdictForRow({ movementDisposition: 'adverse_full' }), {
      verdict: 'PASS',
      reason: 'adverse movement (adverse_full)'
    });
    assert.deepEqual(verdictForRow({ movementDisposition: 'adverse_recent' }), {
      verdict: 'PASS',
      reason: 'adverse movement (adverse_recent)'
    });
  });

  it('PASSes on insufficient or missing movement data', () => {
    assert.deepEqual(verdictForRow({ movementDisposition: 'insufficient' }), {
      verdict: 'PASS',
      reason: 'insufficient movement data'
    });
    assert.deepEqual(verdictForRow({}), { verdict: 'PASS', reason: 'insufficient movement data' });
  });

  it('BETs on supportive movement with TIER 1/2 and non-negative CLV', () => {
    assert.deepEqual(
      verdictForRow({
        movementDisposition: 'supportive_clean',
        confidenceTier: 'TIER 1',
        recentClvPct: 1.4,
        odds: -120
      }),
      { verdict: 'BET', reason: 'supportive_clean, TIER 1, CLV +1.4%' }
    );
    assert.deepEqual(
      verdictForRow({ movementDisposition: 'supportive_bouncy', confidenceTier: 'TIER 2', recentClvPct: 0 }),
      { verdict: 'BET', reason: 'supportive_bouncy, TIER 2, CLV +0.0%' }
    );
  });

  it('CONSIDERs supportive movement when the tier is too low', () => {
    assert.deepEqual(
      verdictForRow({ movementDisposition: 'supportive_clean', confidenceTier: 'TIER 3', recentClvPct: 5 }),
      { verdict: 'CONSIDER', reason: 'supportive but tier below TIER 2' }
    );
  });

  it('CONSIDERs supportive movement when CLV is missing or negative', () => {
    assert.deepEqual(
      verdictForRow({ movementDisposition: 'supportive_clean', confidenceTier: 'TIER 1', recentClvPct: -2 }),
      { verdict: 'CONSIDER', reason: 'supportive but CLV below 0%' }
    );
    assert.deepEqual(verdictForRow({ movementDisposition: 'supportive_clean', confidenceTier: 'TIER 1' }), {
      verdict: 'CONSIDER',
      reason: 'supportive but CLV below 0%'
    });
  });

  it('PASSes any other movement disposition', () => {
    assert.deepEqual(verdictForRow({ movementDisposition: 'neutral' }), {
      verdict: 'PASS',
      reason: 'movement neutral'
    });
  });
});

// --- matchStanceToRow ----------------------------------------------------------------

const mlbTotalRow = {
  market: 'Total Runs',
  game: 'Miami Marlins vs Philadelphia Phillies',
  selection: 'Over 8.5',
  movementDisposition: 'supportive_clean',
  confidenceTier: 'TIER 1',
  recentClvPct: 1.4,
  odds: -120
};

describe('matchStanceToRow', () => {
  it('matches a moneyline stance by exact selection within the right market', () => {
    const stance = {
      title: 'Miami Heat vs. Boston Celtics',
      outcome: 'Miami Heat',
      eventSlug: 'nba-mia-bos-2026-08-17'
    };
    const rows = [
      { market: 'Point Spread', game: 'Miami Heat vs Boston Celtics', selection: 'Miami Heat -2.5' },
      { market: 'Moneyline', game: 'Miami Heat vs Boston Celtics', selection: 'Miami Heat' }
    ];
    const result = matchStanceToRow(stance, rows);
    assert.equal(result.matched, true);
    assert.equal(result.marketName, 'Moneyline');
    assert.equal(result.row.selection, 'Miami Heat');
  });

  it('falls back to game containment plus an exact side field', () => {
    const stance = {
      title: 'New York Yankees vs. Boston Red Sox',
      outcome: 'New York Yankees',
      eventSlug: 'mlb-nyy-bos-2026-08-17'
    };
    const rows = [
      {
        market: 'Moneyline',
        game: 'Boston Red Sox at New York Yankees',
        selection: 'Yankees',
        homeTeam: 'New York Yankees',
        awayTeam: 'Boston Red Sox'
      }
    ];
    const result = matchStanceToRow(stance, rows);
    assert.equal(result.matched, true);
    assert.equal(result.marketName, 'Moneyline');
  });

  it('does not match when the team appears in the game but no side field matches', () => {
    const stance = {
      title: 'New York Yankees vs. Boston Red Sox',
      outcome: 'New York Yankees',
      eventSlug: 'mlb-nyy-bos-2026-08-17'
    };
    const rows = [{ market: 'Moneyline', game: 'New York Yankees vs Boston Red Sox', selection: 'Yankees' }];
    assert.equal(matchStanceToRow(stance, rows).matched, false);
    // selection absent from the game entirely
    assert.equal(
      matchStanceToRow({ title: 'Dodgers vs. Giants', outcome: 'Dodgers', eventSlug: 'mlb-lad-sf-2026' }, [
        { market: 'Moneyline', game: 'Brewers vs Cubs', selection: 'Brewers' }
      ]).matched,
      false
    );
  });

  it('matches a total stance on direction, team context, and best-effort line', () => {
    const result = matchStanceToRow(STANCE(), [mlbTotalRow]);
    assert.equal(result.matched, true);
    assert.equal(result.marketName, 'Total Runs');
  });

  it('rejects a total stance on wrong direction or wrong game', () => {
    assert.equal(matchStanceToRow(STANCE({ outcome: 'Under' }), [mlbTotalRow]).matched, false);
    const otherGame = STANCE({ title: 'St. Louis Cardinals vs. Chicago Cubs O/U 8.5', eventSlug: 'mlb-stl-chc-2026' });
    assert.equal(matchStanceToRow(otherGame, [mlbTotalRow]).matched, false);
  });

  it('matches a spread stance via the handicap market name', () => {
    const stance = { title: 'Brewers vs. Dodgers (-1.5)', outcome: 'Brewers', eventSlug: 'mlb-mil-lad-2026-08-17' };
    const rows = [
      { market: 'Run Line', game: 'Brewers vs Dodgers', selection: 'Brewers', homeTeam: 'Milwaukee Brewers' }
    ];
    const result = matchStanceToRow(stance, rows);
    assert.equal(result.matched, true);
    assert.equal(result.marketName, 'Run Line');
  });

  it('returns unmatched for unresolvable stances or empty rows', () => {
    assert.deepEqual(
      matchStanceToRow({ title: 'Will X win?', outcome: 'Yes', eventSlug: 'mlb-a-b-2026' }, [mlbTotalRow]),
      { matched: false }
    );
    assert.deepEqual(matchStanceToRow(STANCE(), []), { matched: false });
    assert.deepEqual(
      matchStanceToRow(STANCE(), [{ market: 'Total Runs', selection: 'Over 8.5' }]).matched,
      false,
      'no game reference on the row -> cannot confirm matchup'
    );
  });
});

// --- analyzeWalletPlays -------------------------------------------------------------

describe('analyzeWalletPlays', () => {
  it('runs the full loop: groups by league|market, caches rankFn, emits verdicts', async () => {
    const savedLB = polyWalletsMod.fetchLeaderboard;
    const savedAll = polyWalletsMod.fetchWalletStancesAll;
    polyWalletsMod.fetchLeaderboard = async () => [
      { proxyWallet: '0xaaa', userName: 'WhaleA', pnl: 2500000 },
      { proxyWallet: '0xbbb', userName: 'WhaleB', pnl: -5000 }
    ];
    polyWalletsMod.fetchWalletStancesAll = async () => [
      {
        wallet: { proxyWallet: '0xaaa', userName: 'WhaleA', pnl: 2500000 },
        stances: [
          STANCE({ conditionId: 'c1' }),
          STANCE({ conditionId: 'c2' }),
          {
            conditionId: 'c3',
            title: 'Miami Heat vs. Boston Celtics',
            outcome: 'Miami Heat',
            dollar: 3000,
            eventSlug: 'nba-mia-bos-2026-08-17'
          },
          // unresolvable (no eventSlug) -> skipped, never in output
          { conditionId: 'c4', title: 'Miami Marlins vs. Philadelphia Phillies O/U 8.5', outcome: 'Over', dollar: 2000 }
        ]
      },
      {
        wallet: { proxyWallet: '0xbbb', userName: 'WhaleB', pnl: -5000 },
        stances: [
          {
            conditionId: 'c5',
            title: 'St. Louis Cardinals vs. Chicago Cubs O/U 8.5',
            outcome: 'Over',
            dollar: 900,
            eventSlug: 'mlb-stl-chc-2026'
          }
        ]
      }
    ];
    try {
      const rankCalls = [];
      const rankFn = async (league, marketName) => {
        rankCalls.push(`${league}|${marketName}`);
        if (league === 'MLB' && marketName === 'Total Runs') {
          return [mlbTotalRow];
        }
        if (league === 'NBA' && marketName === 'Moneyline') {
          return [
            {
              market: 'Moneyline',
              game: 'Miami Heat vs Boston Celtics',
              selection: 'Miami Heat',
              movementDisposition: 'supportive_bouncy',
              confidenceTier: 'TIER 2',
              recentClvPct: 0.5
            }
          ];
        }
        return [];
      };
      const out = await analyzeWalletPlays({ limit: 10, rankFn });

      assert.equal(
        rankCalls.length,
        2,
        'one rank call per distinct (league, market): MLB|Total Runs cached across both stances'
      );
      assert.ok(rankCalls.includes('MLB|Total Runs'));
      assert.ok(rankCalls.includes('NBA|Moneyline'));

      // WhaleB matched nothing (its run-line row set exists but its game is different)
      assert.equal(out.length, 1);
      assert.equal(out[0].wallet.proxyWallet, '0xaaa');
      assert.equal(out[0].wallet.userName, 'WhaleA');
      assert.equal(out[0].wallet.pnl, 2500000);

      const stances = out[0].stances;
      assert.equal(stances.length, 3, 'c4 dropped, unresolvable slug');
      assert.equal(stances[0].matched, true);
      assert.equal(stances[0].marketName, 'Total Runs');
      assert.equal(stances[0].league, 'MLB');
      assert.equal(stances[0].marketKind, 'total');
      assert.equal(stances[0].selection, 'Over');
      assert.equal(stances[0].line, 8.5);
      assert.deepEqual(stances[0].verdict, { verdict: 'BET', reason: 'supportive_clean, TIER 1, CLV +1.4%' });
      assert.equal(stances[0].row.market, 'Total Runs');

      assert.equal(stances[1].matched, true, 'same group reuses cached rows');
      assert.equal(stances[2].matched, true);
      assert.equal(stances[2].marketName, 'Moneyline');
      assert.deepEqual(stances[2].verdict, { verdict: 'BET', reason: 'supportive_bouncy, TIER 2, CLV +0.5%' });
    } finally {
      polyWalletsMod.fetchLeaderboard = savedLB;
      polyWalletsMod.fetchWalletStancesAll = savedAll;
    }
  });

  it('returns [] when rankFn throws or returns garbage', async () => {
    const savedLB = polyWalletsMod.fetchLeaderboard;
    const savedAll = polyWalletsMod.fetchWalletStancesAll;
    polyWalletsMod.fetchLeaderboard = async () => [{ proxyWallet: '0xaaa', userName: 'A', pnl: 1 }];
    polyWalletsMod.fetchWalletStancesAll = async () => [
      { wallet: { proxyWallet: '0xaaa', userName: 'A', pnl: 1 }, stances: [STANCE()] }
    ];
    try {
      const out = await analyzeWalletPlays({
        rankFn: async () => {
          throw new Error('rank down');
        }
      });
      assert.deepEqual(out, []);
      const out2 = await analyzeWalletPlays({ rankFn: async () => 'not-an-array' });
      assert.deepEqual(out2, []);
    } finally {
      polyWalletsMod.fetchLeaderboard = savedLB;
      polyWalletsMod.fetchWalletStancesAll = savedAll;
    }
  });

  it('returns [] on empty leaderboard or empty stances', async () => {
    const savedLB = polyWalletsMod.fetchLeaderboard;
    const savedAll = polyWalletsMod.fetchWalletStancesAll;
    polyWalletsMod.fetchLeaderboard = async () => [];
    polyWalletsMod.fetchWalletStancesAll = async () => [];
    try {
      assert.deepEqual(await analyzeWalletPlays({ rankFn: async () => [mlbTotalRow] }), []);
      polyWalletsMod.fetchLeaderboard = async () => [{ proxyWallet: '0xaaa', userName: 'A', pnl: 1 }];
      assert.deepEqual(await analyzeWalletPlays({ rankFn: async () => [mlbTotalRow] }), []);
    } finally {
      polyWalletsMod.fetchLeaderboard = savedLB;
      polyWalletsMod.fetchWalletStancesAll = savedAll;
    }
  });

  it('threads an injected fetchImpl through the real wallet fetch layer (no network)', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.includes('/leaderboard')) {
        return { ok: true, status: 200, json: async () => [{ proxyWallet: '0x1', userName: 'A', pnl: 100 }] };
      }
      // activity rows currently carry no eventSlug (sibling change pending) ->
      // stances are unresolvable -> graceful [] until the contract lands
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            type: 'TRADE',
            side: 'BUY',
            conditionId: 'c1',
            title: 'Miami Marlins vs. Philadelphia Phillies O/U 8.5',
            outcome: 'Over',
            usdcSize: 5000
          }
        ]
      };
    };
    const out = await analyzeWalletPlays({ limit: 5, rankFn: async () => [mlbTotalRow], fetchImpl });
    assert.deepEqual(out, []);
    assert.equal(calls.length, 2, 'leaderboard fetch + per-wallet activity fetch');
  });
});
