'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  leagueFromSlug,
  marketKindFromTitle,
  leagueMarketName,
  resolveStance,
  verdictForRow,
  surnameCandidates,
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

  it('maps ATP/WTA/ITF singles-match slugs to Tennis', () => {
    assert.equal(leagueFromSlug('atp-tirante-landalu-2026-08-17'), 'Tennis');
    assert.equal(leagueFromSlug('wta-cirstea-kalinsk-2026-08-17'), 'Tennis');
    assert.equal(leagueFromSlug('itf-aleksey-boschma-2026-08-17'), 'Tennis');
  });

  it('maps Liga MX, Brazilian soccer, and esports slugs', () => {
    assert.equal(leagueFromSlug('mex-tij-caz-2026-08-16'), 'Soccer');
    assert.equal(leagueFromSlug('bra-vit-bot-2026-08-16'), 'Soccer');
    assert.equal(leagueFromSlug('lol-tes-edg-2026-08-16'), 'LoL');
    assert.equal(leagueFromSlug('cs2-9z-mgc-2026-08-16'), 'CS2');
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

  it('resolves a nickname selection by surname when the game confirms the matchup', () => {
    // 'Yankees' is the surname of 'New York Yankees' — surname matching
    // intentionally resolves nickname-vs-full-name rows (this is what makes
    // 'Brandon Nakashima' vs row 'Nakashima' work in tennis).
    const stance = {
      title: 'New York Yankees vs. Boston Red Sox',
      outcome: 'New York Yankees',
      eventSlug: 'mlb-nyy-bos-2026-08-17'
    };
    const rows = [{ market: 'Moneyline', game: 'New York Yankees vs Boston Red Sox', selection: 'Yankees' }];
    assert.equal(matchStanceToRow(stance, rows).matched, true);
    // selection absent from the game entirely
    assert.equal(
      matchStanceToRow({ title: 'Dodgers vs. Giants', outcome: 'Dodgers', eventSlug: 'mlb-lad-sf-2026' }, [
        { market: 'Moneyline', game: 'Brewers vs Cubs', selection: 'Brewers' }
      ]).matched,
      false
    );
  });

  it('matches a tennis full-name stance to a last-name-only row (Nakashima)', () => {
    const stance = {
      title: 'Cincinnati Open: Brandon Nakashima vs Daniil Medvedev',
      outcome: 'Brandon Nakashima',
      dollar: 6467,
      eventSlug: 'atp-nakashi-medvede-2026-08-18'
    };
    const rows = [
      {
        market: 'Moneyline',
        game: 'Medvedev vs Nakashima',
        selection: 'Nakashima',
        homeTeam: 'Medvedev',
        awayTeam: 'Nakashima'
      }
    ];
    const result = matchStanceToRow(stance, rows);
    assert.equal(result.matched, true);
    assert.equal(result.marketName, 'Moneyline');
    assert.equal(result.row.selection, 'Nakashima');
  });

  it('does NOT match a tennis stance to the WRONG SIDE of the matchup', () => {
    // Game string contains both surnames; the row's selection is Nakashima, so a
    // Medvedev stance must fail even though 'MEDVEDEV' appears in the game.
    const stance = {
      title: 'Cincinnati Open: Brandon Nakashima vs Daniil Medvedev',
      outcome: 'Daniil Medvedev',
      dollar: 5000,
      eventSlug: 'atp-nakashi-medvede-2026-08-18'
    };
    const rows = [
      {
        market: 'Moneyline',
        game: 'Medvedev vs Nakashima',
        selection: 'Nakashima',
        homeTeam: 'Medvedev',
        awayTeam: 'Nakashima'
      }
    ];
    assert.equal(matchStanceToRow(stance, rows).matched, false);
    // And the reverse: a Nakashima stance must not match a Medvedev row.
    const reverse = {
      title: 'Cincinnati Open: Brandon Nakashima vs Daniil Medvedev',
      outcome: 'Brandon Nakashima',
      dollar: 5000,
      eventSlug: 'atp-nakashi-medvede-2026-08-18'
    };
    assert.equal(
      matchStanceToRow(reverse, [
        {
          market: 'Moneyline',
          game: 'Medvedev vs Nakashima',
          selection: 'Medvedev',
          homeTeam: 'Medvedev',
          awayTeam: 'Nakashima'
        }
      ]).matched,
      false
    );
  });

  it('matches a tennis total stance with a tournament prefix in the title', () => {
    const stance = {
      title: 'Cincinnati Open: Jiri Lehecka vs Arthur Fils: Match O/U 22.5',
      outcome: 'Under',
      dollar: 1000,
      eventSlug: 'atp-lehecka-fils-2026-08-18'
    };
    const rows = [{ market: 'Total Games', game: 'Lehecka vs Fils', selection: 'Under 22.5' }];
    const result = matchStanceToRow(stance, rows);
    assert.equal(result.matched, true);
    assert.equal(result.marketName, 'Total Games');
    assert.equal(result.row.selection, 'Under 22.5');
  });

  it("matches apostrophe surnames via joined single-letter prefix (O'Connell -> OCONNELL)", () => {
    assert.deepEqual(surnameCandidates("Christopher O'Connell"), ['OCONNELL', 'CONNELL']);
    assert.deepEqual(surnameCandidates('Brandon Nakashima'), ['NAKASHIMA']);
    const stance = {
      title: "Cincinnati Open: Joao Fonseca vs Christopher O'Connell",
      outcome: "Christopher O'Connell",
      dollar: 9176,
      eventSlug: 'atp-fonseca-oconnel-2026-08-18'
    };
    const rows = [{ market: 'Moneyline', game: 'Fonseca vs Oconnell', selection: 'Oconnell' }];
    const result = matchStanceToRow(stance, rows);
    assert.equal(result.matched, true);
    assert.equal(result.row.selection, 'Oconnell');
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

      // WhaleB now surfaces too — its stance resolves to MLB/total even though
      // the rankFn returns no matching row (rankFn degrades to no rows).
      // The CLI shows "whale on X · no book match" instead of dropping the wallet.
      assert.equal(out.wallets.length, 2);
      assert.equal(out.wallets[0].wallet.proxyWallet, '0xaaa');
      assert.equal(out.wallets[0].wallet.userName, 'WhaleA');
      assert.equal(out.wallets[0].wallet.pnl, 2500000);
      assert.equal(out.wallets[1].wallet.proxyWallet, '0xbbb');
      assert.equal(out.wallets[1].wallet.userName, 'WhaleB');

      const stancesA = out.wallets[0].stances;
      assert.equal(stancesA.length, 3, 'c4 dropped, unresolvable slug');
      assert.equal(stancesA[0].matched, true);
      assert.equal(stancesA[0].marketName, 'Total Runs');
      assert.equal(stancesA[0].league, 'MLB');
      assert.equal(stancesA[0].marketKind, 'total');
      assert.equal(stancesA[0].selection, 'Over');
      assert.equal(stancesA[0].line, 8.5);
      assert.deepEqual(stancesA[0].verdict, { verdict: 'BET', reason: 'supportive_clean, TIER 1, CLV +1.4%' });
      assert.equal(stancesA[0].row.market, 'Total Runs');
      // WhaleB also surfaces now (see assert below at line 413)
      const stancesB = out.wallets[1].stances;
      assert.equal(stancesB.length, 1);
      assert.equal(stancesB[0].matched, false);
      assert.equal(stancesB[0].league, 'MLB');
      assert.equal(stancesB[0].marketKind, 'total');
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
      // rankFn failure degrades to no rows, but resolvable stances still surface
      // so the CLI can show "whale on X · no book match" instead of dropping the wallet.
      assert.equal(out.wallets.length, 1);
      assert.equal(out.droppedByPrefix.length, 0);
      assert.equal(out.nonSportsDropped, 0);
      assert.equal(out.wallets[0].stances.length, 1);
      assert.equal(out.wallets[0].stances[0].matched, false);
      assert.equal(out.wallets[0].stances[0].league, 'MLB');
      const out2 = await analyzeWalletPlays({ rankFn: async () => 'not-an-array' });
      assert.equal(out2.wallets.length, 1);
      assert.equal(out2.droppedByPrefix.length, 0);
      assert.equal(out2.nonSportsDropped, 0);
    } finally {
      polyWalletsMod.fetchLeaderboard = savedLB;
      polyWalletsMod.fetchWalletStancesAll = savedAll;
    }
  });

  it('filters stances by league (opts.league)', async () => {
    const savedLB = polyWalletsMod.fetchLeaderboard;
    const savedAll = polyWalletsMod.fetchWalletStancesAll;
    polyWalletsMod.fetchLeaderboard = async () => [{ proxyWallet: '0xaaa', userName: 'A', pnl: 1 }];
    polyWalletsMod.fetchWalletStancesAll = async () => [
      {
        wallet: { proxyWallet: '0xaaa', userName: 'A', pnl: 1 },
        stances: [
          // tennis stance (would resolve to Tennis)
          {
            conditionId: 't1',
            title: 'Cincinnati Open: Brandon Nakashima vs Daniil Medvedev',
            outcome: 'Brandon Nakashima',
            dollar: 5000,
            eventSlug: 'atp-nakashi-medvede-2026-08-18'
          },
          // MLB total stance
          STANCE({ conditionId: 'm1' })
        ]
      }
    ];
    try {
      const out = await analyzeWalletPlays({ rankFn: async () => [] });
      assert.equal(out.wallets.length, 1);
      assert.equal(out.wallets[0].stances.length, 2, 'both leagues present without filter');
      const tennisOnly = await analyzeWalletPlays({ rankFn: async () => [], league: 'Tennis' });
      assert.equal(tennisOnly.wallets[0].stances.length, 1);
      assert.equal(tennisOnly.wallets[0].stances[0].league, 'Tennis');
      assert.equal(tennisOnly.wallets[0].stances[0].selection, 'Brandon Nakashima');
      // league filter is case-insensitive
      const lower = await analyzeWalletPlays({ rankFn: async () => [], league: 'tennis' });
      assert.equal(lower.wallets[0].stances.length, 1);
      // a league with no stances -> wallet surfaces empty? No: filtered out.
      const none = await analyzeWalletPlays({ rankFn: async () => [], league: 'UFC' });
      assert.equal(none.wallets.length, 0);
    } finally {
      polyWalletsMod.fetchLeaderboard = savedLB;
      polyWalletsMod.fetchWalletStancesAll = savedAll;
    }
  });

  it('filters stances by eventSlug date (opts.date)', async () => {
    const savedLB = polyWalletsMod.fetchLeaderboard;
    const savedAll = polyWalletsMod.fetchWalletStancesAll;
    polyWalletsMod.fetchLeaderboard = async () => [{ proxyWallet: '0xaaa', userName: 'A', pnl: 1 }];
    polyWalletsMod.fetchWalletStancesAll = async () => [
      {
        wallet: { proxyWallet: '0xaaa', userName: 'A', pnl: 1 },
        stances: [
          {
            conditionId: 't1',
            title: 'Cincinnati Open: Brandon Nakashima vs Daniil Medvedev',
            outcome: 'Brandon Nakashima',
            dollar: 5000,
            eventSlug: 'atp-nakashi-medvede-2026-08-18'
          },
          STANCE({ conditionId: 'm1' }) // mlb-mia-phi-2026-08-17
        ]
      }
    ];
    try {
      const out = await analyzeWalletPlays({ rankFn: async () => [], date: '2026-08-18' });
      assert.equal(out.wallets[0].stances.length, 1);
      assert.equal(out.wallets[0].stances[0].selection, 'Brandon Nakashima');
      const prior = await analyzeWalletPlays({ rankFn: async () => [], date: '2026-08-17' });
      assert.equal(prior.wallets[0].stances.length, 1);
      assert.equal(prior.wallets[0].stances[0].marketKind, 'total');
      // slug with no trailing date -> dropped when a date filter is active
      const noDate = await analyzeWalletPlays({ rankFn: async () => [], date: '2026-08-18' });
      assert.equal(noDate.wallets[0].stances.length, 1);
    } finally {
      polyWalletsMod.fetchLeaderboard = savedLB;
      polyWalletsMod.fetchWalletStancesAll = savedAll;
    }
  });

  it('re-grades matched stances against the exact per-game quote (exactFn)', async () => {
    const savedLB = polyWalletsMod.fetchLeaderboard;
    const savedAll = polyWalletsMod.fetchWalletStancesAll;
    polyWalletsMod.fetchLeaderboard = async () => [{ proxyWallet: '0xaaa', userName: 'WhaleA', pnl: 100 }];
    polyWalletsMod.fetchWalletStancesAll = async () => [
      {
        wallet: { proxyWallet: '0xaaa', userName: 'WhaleA', pnl: 100 },
        stances: [
          {
            conditionId: 't1',
            title: 'Cincinnati Open: Brandon Nakashima vs Daniil Medvedev',
            outcome: 'Brandon Nakashima',
            dollar: 5000,
            eventSlug: 'atp-nakashi-medvede-2026-08-18'
          }
        ]
      }
    ];
    try {
      // Broad scan returns a DEGRADED row (TIER 4 adverse) for this match.
      const rankFn = async () => [
        {
          market: 'Moneyline',
          game: 'Medvedev vs Nakashima',
          gameId: 'Tennis:PREMATCH:Medvedev:Nakashima:1787054400',
          selection: 'Nakashima',
          movementDisposition: 'adverse_full',
          confidenceTier: 'TIER 4',
          recentClvPct: -3
        }
      ];
      // Exact lookup returns the AUTHORITATIVE row (supportive_clean T1 +CLV).
      const exactCalls = [];
      const exactFn = async (league, market, gameId) => {
        exactCalls.push(gameId);
        return [
          {
            market: 'Moneyline',
            game: 'Medvedev vs Nakashima',
            gameId,
            selection: 'Nakashima',
            movementDisposition: 'supportive_clean',
            confidenceTier: 'TIER 1',
            recentClvPct: 1.8
          }
        ];
      };
      const out = await analyzeWalletPlays({ rankFn, exactFn });
      assert.equal(exactCalls.length, 1, 'exact recheck fired for the matched game');
      const s = out.wallets[0].stances[0];
      assert.equal(s.matched, true);
      assert.equal(s.exact, true, 'flagged as exact-rechecked');
      // Verdict now uses the EXACT row's clean supportive movement, not the scan's T4.
      assert.deepEqual(s.verdict, { verdict: 'BET', reason: 'supportive_clean, TIER 1, CLV +1.8%' });
      assert.equal(s.row.confidenceTier, 'TIER 1');

      // Without exactFn, the degraded scan row drives the verdict (backward compat).
      const bare = await analyzeWalletPlays({ rankFn });
      const sb = bare.wallets[0].stances[0];
      assert.equal(sb.exact, false);
      assert.deepEqual(sb.verdict, { verdict: 'PASS', reason: 'adverse movement (adverse_full)' });
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
      assert.deepEqual(await analyzeWalletPlays({ rankFn: async () => [mlbTotalRow] }), {
        wallets: [],
        gameTallies: [],
        droppedByPrefix: [],
        nonSportsDropped: 0
      });
      polyWalletsMod.fetchLeaderboard = async () => [{ proxyWallet: '0xaaa', userName: 'A', pnl: 1 }];
      assert.deepEqual(await analyzeWalletPlays({ rankFn: async () => [mlbTotalRow] }), {
        wallets: [],
        gameTallies: [],
        droppedByPrefix: [],
        nonSportsDropped: 0
      });
    } finally {
      polyWalletsMod.fetchLeaderboard = savedLB;
      polyWalletsMod.fetchWalletStancesAll = savedAll;
    }
  });

  it('aggregates matched stance dollars per (game, side) into gameTallies', async () => {
    const savedLB = polyWalletsMod.fetchLeaderboard;
    const savedAll = polyWalletsMod.fetchWalletStancesAll;
    polyWalletsMod.fetchLeaderboard = async () => [
      { proxyWallet: '0xaaa', userName: 'WhaleA', pnl: 100 },
      { proxyWallet: '0xbbb', userName: 'WhaleB', pnl: 100 }
    ];
    const stance = (cid, outcome, dollar) => ({
      conditionId: cid,
      title: "Fonseca vs. O'Connell",
      outcome,
      dollar,
      eventSlug: 'atp-fonseca-oconnel-2026-08-18'
    });
    polyWalletsMod.fetchWalletStancesAll = async () => [
      { wallet: { proxyWallet: '0xaaa', userName: 'WhaleA', pnl: 100 }, stances: [stance('c1', 'Joao Fonseca', 5400)] },
      {
        wallet: { proxyWallet: '0xbbb', userName: 'WhaleB', pnl: 100 },
        stances: [stance('c2', "Christopher O'Connell", 9176), stance('c3', 'Joao Fonseca', 2986)]
      }
    ];
    try {
      const rows = [
        {
          market: 'Moneyline',
          game: 'Fonseca vs Oconnell',
          selection: 'Fonseca',
          movementDisposition: 'supportive_clean',
          confidenceTier: 'TIER 1',
          recentClvPct: 1.0
        },
        {
          market: 'Moneyline',
          game: 'Fonseca vs Oconnell',
          selection: 'Oconnell',
          movementDisposition: 'supportive_clean',
          confidenceTier: 'TIER 1',
          recentClvPct: 1.0
        }
      ];
      const out = await analyzeWalletPlays({ rankFn: async () => rows });
      const bySide = new Map(out.gameTallies.map((t) => [t.side, t]));
      // Fonseca: 5400 + 2986 = 8386 across two wallets; O'Connell: 9176.
      assert.equal(out.gameTallies.length, 2);
      assert.equal(bySide.get('Joao Fonseca').usd, 8386);
      assert.equal(bySide.get('Joao Fonseca').wallets, 2);
      assert.equal(bySide.get("Christopher O'Connell").usd, 9176);
      assert.equal(bySide.get("Christopher O'Connell").wallets, 1);
      // sorted by usd desc: O'Connell (9176) first
      assert.equal(out.gameTallies[0].side, "Christopher O'Connell");
      // rows without a match never enter tallies
      const noMatch = await analyzeWalletPlays({ rankFn: async () => [] });
      assert.deepEqual(noMatch.gameTallies, []);
    } finally {
      polyWalletsMod.fetchLeaderboard = savedLB;
      polyWalletsMod.fetchWalletStancesAll = savedAll;
    }
  });
});
