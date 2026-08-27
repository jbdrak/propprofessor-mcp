'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runResearchOnTopRows } = require('../lib/propprofessor-research-runner');

describe('runResearchOnTopRows', () => {
  it('returns empty results for empty rows', async () => {
    const out = await runResearchOnTopRows({ rows: [], playerContextFn: async () => null });
    assert.deepEqual(out.results, []);
    assert.equal(out.errors, 0);
  });

  it('returns empty results when playerContextFn is missing', async () => {
    const out = await runResearchOnTopRows({ rows: [{ selection: 'A' }] });
    assert.deepEqual(out.results, []);
  });

  it('runs player_context on each top row, sorted by screenScore desc', async () => {
    const calls = [];
    const playerContextFn = async (args) => {
      calls.push({ player: args.player, sport: args.sport });
      return {
        player: args.player,
        sport: args.sport || null,
        riskFlag: 'low',
        summary: `${args.player} looks fine`,
        tweets: [],
        news: [],
        cached: false,
        fetchedAt: new Date().toISOString()
      };
    };
    const rows = [
      { selection: 'Low Score', screenScore: 1.0, league: 'NBA' },
      { selection: 'High Score', screenScore: 9.0, league: 'NBA' },
      { selection: 'Mid Score', screenScore: 5.0, league: 'NBA' }
    ];
    const { results, errors } = await runResearchOnTopRows({
      rows,
      limit: 3,
      playerContextFn
    });
    assert.equal(errors, 0);
    assert.equal(results.length, 3);
    // Sorted by screenScore desc: High, Mid, Low
    assert.equal(results[0].player, 'High Score');
    assert.equal(results[1].player, 'Mid Score');
    assert.equal(results[2].player, 'Low Score');
    assert.deepEqual(
      calls.map((c) => c.player),
      ['High Score', 'Mid Score', 'Low Score']
    );
  });

  it('respects the limit argument', async () => {
    const calls = [];
    const playerContextFn = async ({ player }) => {
      calls.push(player);
      return { riskFlag: 'low', tweets: [], news: [], cached: true };
    };
    const rows = Array.from({ length: 20 }, (_, i) => ({
      selection: `P${i}`,
      screenScore: 20 - i,
      league: 'NBA'
    }));
    const { results } = await runResearchOnTopRows({
      rows,
      limit: 5,
      playerContextFn
    });
    assert.equal(results.length, 5);
    assert.equal(calls.length, 5);
  });

  it('captures riskFlag, summary, and topTweet from the player_context response', async () => {
    const playerContextFn = async () => ({
      riskFlag: 'high',
      summary: 'Questionable status — questionable',
      tweets: [{ text: 'Breaking: questionable tag on player' }, { text: 'second tweet' }],
      news: [],
      cached: false
    });
    const { results } = await runResearchOnTopRows({
      rows: [{ selection: 'Injured Star', screenScore: 8, league: 'NBA' }],
      limit: 1,
      playerContextFn
    });
    assert.equal(results[0].riskFlag, 'high');
    assert.equal(results[0].riskSummary, 'Questionable status — questionable');
    assert.equal(results[0].topTweet, 'Breaking: questionable tag on player');
    assert.equal(results[0].cached, false);
  });

  it('counts errors and continues on per-row failure', async () => {
    let callCount = 0;
    const playerContextFn = async () => {
      callCount += 1;
      if (callCount === 2) throw new Error('upstream timeout');
      return { riskFlag: 'low', tweets: [], news: [], cached: true };
    };
    const { results, errors } = await runResearchOnTopRows({
      rows: [
        { selection: 'A', screenScore: 5, league: 'NBA' },
        { selection: 'B', screenScore: 4, league: 'NBA' },
        { selection: 'C', screenScore: 3, league: 'NBA' }
      ],
      limit: 3,
      playerContextFn
    });
    assert.equal(results.length, 3);
    assert.equal(errors, 1);
    const errored = results.find((r) => r.riskFlag === 'error');
    assert.ok(errored, 'one result should have riskFlag=error');
    assert.match(errored.error, /upstream timeout/);
  });

  it('skips rows with no selection/participant/pick', async () => {
    const playerContextFn = async () => ({ riskFlag: 'low', tweets: [], news: [] });
    const { results } = await runResearchOnTopRows({
      rows: [
        { screenScore: 5, league: 'NBA' }, // no selection
        { selection: 'OK', screenScore: 3, league: 'NBA' }
      ],
      limit: 5,
      playerContextFn
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].player, 'OK');
  });

  it('truncates topTweet to 200 characters', async () => {
    const longText = 'a'.repeat(500);
    const playerContextFn = async () => ({
      riskFlag: 'low',
      tweets: [{ text: longText }],
      news: []
    });
    const { results } = await runResearchOnTopRows({
      rows: [{ selection: 'X', screenScore: 5, league: 'NBA' }],
      limit: 1,
      playerContextFn
    });
    assert.equal(results[0].topTweet.length, 200);
  });

  it('routes non-player selections to gameContextFn', async () => {
    const playerCalls = [];
    const gameCalls = [];
    const playerContextFn = async ({ player }) => {
      playerCalls.push(player);
      return { riskFlag: 'low', tweets: [], news: [], cached: true };
    };
    const gameContextFn = async ({ selection }) => {
      gameCalls.push(selection);
      return { riskFlag: 'low', riskSummary: 'game context ok', cached: true };
    };
    const { results } = await runResearchOnTopRows({
      rows: [{ selection: 'New York Mets', screenScore: 9, league: 'MLB' }],
      limit: 1,
      playerContextFn,
      gameContextFn
    });
    assert.equal(gameCalls.length, 1);
    assert.equal(gameCalls[0], 'New York Mets');
    assert.equal(playerCalls.length, 0);
    assert.equal(results.length, 1);
  });

  it('routes player selections to playerContextFn when both functions are provided', async () => {
    const playerCalls = [];
    const gameCalls = [];
    const playerContextFn = async ({ player }) => {
      playerCalls.push(player);
      return { riskFlag: 'low', tweets: [], news: [], cached: true };
    };
    const gameContextFn = async ({ selection }) => {
      gameCalls.push(selection);
      return { riskFlag: 'low', riskSummary: 'game context ok', cached: true };
    };
    const { results } = await runResearchOnTopRows({
      rows: [{ selection: 'LeBron James', screenScore: 9, league: 'NBA' }],
      limit: 1,
      playerContextFn,
      gameContextFn
    });
    assert.equal(playerCalls.length, 1);
    assert.equal(playerCalls[0], 'LeBron James');
    assert.equal(gameCalls.length, 0);
    assert.equal(results.length, 1);
  });

  it('attaches contextType: "game" for team selections', async () => {
    const gameContextFn = async () => ({ riskFlag: 'low', riskSummary: 'all clear', cached: true });
    const playerContextFn = async () => ({ riskFlag: 'low', tweets: [], news: [], cached: true });
    const { results } = await runResearchOnTopRows({
      rows: [{ selection: 'Los Angeles Lakers', screenScore: 8, league: 'NBA' }],
      limit: 1,
      playerContextFn,
      gameContextFn
    });
    assert.equal(results[0].contextType, 'game');
  });

  it('attaches contextType: "player" for player selections', async () => {
    const gameContextFn = async () => ({ riskFlag: 'low', riskSummary: 'all clear', cached: true });
    const playerContextFn = async () => ({ riskFlag: 'low', tweets: [], news: [], cached: true });
    const { results } = await runResearchOnTopRows({
      rows: [{ selection: 'Stephen Curry', screenScore: 8, league: 'NBA' }],
      limit: 1,
      playerContextFn,
      gameContextFn
    });
    assert.equal(results[0].contextType, 'player');
  });

  it('falls back to stub when gameContextFn is missing', async () => {
    const playerContextFn = async () => ({ riskFlag: 'low', tweets: [], news: [], cached: true });
    const { results } = await runResearchOnTopRows({
      rows: [{ selection: 'New York Yankees', screenScore: 8, league: 'MLB' }],
      limit: 1,
      playerContextFn
      // no gameContextFn
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].riskFlag, 'unknown');
    assert.equal(results[0].riskSummary, 'no game context handler');
    assert.equal(results[0].contextType, 'game');
  });
});
