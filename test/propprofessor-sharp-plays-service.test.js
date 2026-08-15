'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runSharpPlays } = require('../lib/propprofessor-sharp-plays-service');

/**
 * Stub screen deps for runSharpPlays. Records every main ranked query's
 * (league, market) pair so tests can assert the fan-out shape without any
 * live backend calls.
 */
function buildScreenDeps() {
  const mainQueries = [];
  const allQueries = [];
  const queryLeagueScreen = async (rankedArgs, league) => {
    allQueries.push({ rankedArgs, league });
    if (!rankedArgs.compact) mainQueries.push({ league, market: rankedArgs.market });
    return { ok: true, result: [] };
  };
  const queryTennisScreen = async (rankedArgs) => {
    allQueries.push({ rankedArgs, league: 'Tennis' });
    if (!rankedArgs.compact) mainQueries.push({ league: 'Tennis', market: rankedArgs.market });
    return { ok: true, result: [] };
  };
  return { queryLeagueScreen, queryTennisScreen, mainQueries, allQueries };
}

describe('runSharpPlays per-league market resolution', () => {
  it('fans out per-league registry defaults when no explicit markets are given', async () => {
    const deps = buildScreenDeps();
    await runSharpPlays(
      {
        book: 'NoVigApp',
        targetBooks: ['NoVigApp'],
        leagues: ['Tennis', 'MLB'],
        limit: 5,
        scanLimit: 5,
        minConsensusBookCount: 1,
        lookbackHours: 6,
        strict: false,
        includePasses: true
      },
      deps
    );

    assert.deepEqual(
      deps.mainQueries.map(({ league, market }) => `${league}:${market}`).sort(),
      [
        'MLB:Moneyline',
        'MLB:Run Line',
        'MLB:Total Runs',
        'Tennis:Moneyline',
        'Tennis:Set Handicap',
        'Tennis:Total Games'
      ].sort()
    );
  });

  it('scans UFC with Moneyline and Total Rounds when given as a single league', async () => {
    const deps = buildScreenDeps();
    await runSharpPlays(
      {
        book: 'NoVigApp',
        leagues: ['UFC'],
        limit: 5,
        scanLimit: 5,
        minConsensusBookCount: 1,
        lookbackHours: 6,
        strict: false,
        includePasses: true
      },
      deps
    );

    assert.deepEqual(deps.mainQueries.map(({ league, market }) => `${league}:${market}`).sort(), [
      'UFC:Moneyline',
      'UFC:Total Rounds'
    ]);
  });

  it('keeps explicit markets identical for every league', async () => {
    const deps = buildScreenDeps();
    const result = await runSharpPlays(
      {
        book: 'NoVigApp',
        targetBooks: ['NoVigApp'],
        leagues: ['Tennis', 'MLB'],
        markets: ['Moneyline'],
        limit: 5,
        scanLimit: 5,
        minConsensusBookCount: 1,
        lookbackHours: 6,
        strict: false,
        includePasses: true
      },
      deps
    );

    assert.deepEqual(deps.mainQueries.map(({ league, market }) => `${league}:${market}`).sort(), [
      'MLB:Moneyline',
      'Tennis:Moneyline'
    ]);
    assert.deepEqual(result.resultMeta.markets, ['Moneyline']);
  });

  it('reports the union of per-league default markets plus a per-league breakdown in resultMeta', async () => {
    const deps = buildScreenDeps();
    const result = await runSharpPlays(
      {
        book: 'NoVigApp',
        targetBooks: ['NoVigApp'],
        leagues: ['Tennis', 'MLB'],
        limit: 5,
        scanLimit: 5,
        minConsensusBookCount: 1,
        lookbackHours: 6,
        strict: false,
        includePasses: true
      },
      deps
    );

    assert.deepEqual(result.resultMeta.markets, ['Moneyline', 'Total Games', 'Set Handicap', 'Run Line', 'Total Runs']);
    assert.deepEqual(result.resultMeta.marketsByLeague, {
      Tennis: ['Moneyline', 'Total Games', 'Set Handicap'],
      MLB: ['Moneyline', 'Run Line', 'Total Runs']
    });
  });

  it('sizes aggregate-mode budget by the true per-league market pair count', async () => {
    const deps = buildScreenDeps();
    const result = await runSharpPlays(
      {
        book: 'NoVigApp',
        targetBooks: ['NoVigApp'],
        leagues: ['Tennis', 'UFC'],
        quickScreenAggregate: true,
        limit: 5,
        scanLimit: 5,
        minConsensusBookCount: 1,
        lookbackHours: 6,
        strict: false,
        includePasses: true
      },
      deps
    );

    // Tennis contributes 3 markets, UFC 2 — 5 pairs total. Aggregate mode
    // skips the sharp-only cross-reference, so main queries alone.
    assert.equal(deps.mainQueries.length, 5);
    assert.equal(deps.allQueries.length, 5);
    assert.equal(result.resultMeta.scannedQueryCount, 5);
    assert.equal(result.resultMeta.historyBudget.pairCount, 5);
  });
});
