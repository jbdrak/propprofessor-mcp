'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');

describe('recommended_bets default league set', () => {
  it('defaults to all 12 DEFAULT_LEAGUES when none passed', async () => {
    const handlers = createMcpHandlers({ client: {} });
    const leaguesSeen = [];
    handlers.screen_ranked = async (args) => {
      leaguesSeen.push(args.league);
      return { ok: true, result: [] };
    };
    await handlers.recommended_bets({ book: 'NoVigApp', limit: 2 });
    const expected = ['NBA', 'NBASL', 'MLB', 'NFL', 'NHL', 'WNBA', 'NCAAB', 'NCAAF', 'Soccer', 'MLS', 'Tennis', 'UFC'];
    for (const l of expected) {
      assert.ok(leaguesSeen.includes(l), `should scan ${l}`);
    }
    const uniqueLeagues = [...new Set(leaguesSeen)];
    assert.equal(
      uniqueLeagues.length,
      12,
      `expected exactly 12 leagues, got ${uniqueLeagues.length}: ${uniqueLeagues}`
    );
  });
});

describe('recommended_bets resilience (no single hung call hangs the tool)', () => {
  it('returns (does not hang) when every screen_ranked call stalls', async () => {
    const handlers = createMcpHandlers({ client: {} });
    // Simulate a backend that never resolves screen_ranked
    handlers.screen_ranked = () => new Promise(() => {});

    const start = Date.now();
    await handlers.recommended_bets({ leagues: ['NBA'], book: 'NoVigApp', limit: 2 });
    const elapsed = Date.now() - start;

    // Either outcome is fine (ok:false or ok:true with empty) — the contract
    // is that it RETURNS, not hangs.
    assert.ok(elapsed < 40000, `should return within the 25s per-market timeout, took ${elapsed}ms`);
  });

  it('returns empty (not hang) when one league stalls and others resolve', async () => {
    const handlers = createMcpHandlers({ client: {} });
    let nbaCalls = 0;
    handlers.screen_ranked = async (args) => {
      if (args.league === 'NBA') {
        nbaCalls++;
        // first market resolves, second stalls
        if (nbaCalls <= 1) return { ok: true, result: [{ gameId: 'g1', selection: 'A', screenScore: 80 }] };
        return new Promise(() => {});
      }
      return { ok: true, result: [] };
    };

    const start = Date.now();
    const r = await handlers.recommended_bets({ leagues: ['NBA', 'MLB'], book: 'NoVigApp', limit: 2 });
    const elapsed = Date.now() - start;

    assert.equal(r.ok, true, 'partial failure should still produce a result');
    assert.ok(elapsed < 40000, `should not hang on the stalled NBA market, took ${elapsed}ms`);
  });
});
