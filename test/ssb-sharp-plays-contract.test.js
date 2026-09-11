'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runSharpPlays } = require('../lib/ssb-sharp-plays-service');

describe('external dashboard contract for runSharpPlays()', () => {
  it('preserves the external dashboard response contract for runSharpPlays()', async () => {
    const queryCalls = [];
    const sharedRow = {
      gameId: 'game-123',
      game: 'Stub Away vs Stub Home',
      pick: 'Stub Home ML',
      prices: [{ book: 'Fliff', odds1: 112, odds2: -118 }],
      lineHistorySummary: [{ book: 'Pinnacle', firstOdds: -118, lastOdds: -130, pointCount: 2 }],
      lineHistoryUsable: true,
      movementMode: 'same_book',
      movementSourceBook: 'Pinnacle',
      movementLabel: 'supportive',
      consensusBookCount: 2,
      marketBookCount: 2,
      supportBookCount: 2,
      executionQuality: 'best',
      odds: 112,
      currentOdds: 112,
      price: 112,
      targetBook: 'Fliff',
      executionBook: 'Fliff',
      book: 'Fliff',
      market: 'Moneyline',
      scanMarket: 'Moneyline',
      league: 'NBA'
    };

    const result = await runSharpPlays(
      {
        book: 'Fliff',
        targetBooks: ['Fliff'],
        leagues: ['NBA'],
        markets: ['Moneyline'],
        limit: 5,
        scanLimit: 5,
        minConsensusBookCount: 1,
        lookbackHours: 6,
        strict: true,
        includePasses: true
      },
      {
        queryLeagueScreen: async (rankedArgs, league) => {
          queryCalls.push({ rankedArgs, league });
          return {
            ok: true,
            result: [sharedRow]
          };
        },
        queryTennisScreen: async () => {
          throw new Error('Tennis path should not be used in this contract test');
        }
      }
    );

    assert.equal(result.ok, true, 'external dashboard contract: root.ok should be true');
    assert.equal(typeof result.count, 'number', 'external dashboard contract: root.count should be present');
    assert.ok(Array.isArray(result.result), 'external dashboard contract: root.result should be an array');
    assert.ok(
      result.resultMeta && typeof result.resultMeta === 'object',
      'external dashboard contract: root.resultMeta should be an object'
    );

    assert.equal(
      result.resultMeta.source,
      'sharp_plays_addon',
      'external dashboard contract: metadata.source should identify the sharp plays addon'
    );
    assert.deepEqual(
      result.resultMeta.targetBooks,
      ['Fliff'],
      'external dashboard contract: metadata.targetBooks should preserve the target book list'
    );
    assert.equal(
      result.resultMeta.targetBookCount,
      1,
      'external dashboard contract: metadata.targetBookCount should match the number of target books'
    );
    assert.equal(
      result.resultMeta.lookbackHoursUsed,
      6,
      'external dashboard contract: metadata.lookbackHoursUsed should reflect the requested lookback window'
    );
    assert.equal(
      result.resultMeta.scannedQueryCount,
      2,
      'external dashboard contract: metadata.scannedQueryCount includes sharp book group query'
    );
    assert.deepEqual(
      result.resultMeta.classificationSummary,
      {
        totalRowsClassified: 1,
        verdictCounts: { 'Bet candidate': 1 },
        passReasonCounts: {}
      },
      'external dashboard contract: metadata.classificationSummary should summarize classified rows'
    );
    assert.equal(
      result.resultMeta.emptyState,
      null,
      'external dashboard contract: metadata.emptyState should be null when the result is non-empty'
    );
    assert.equal(
      result.resultMeta.ufcShortlist,
      null,
      'external dashboard contract: UFC shortlist metadata should be null when no UFC rows were scanned'
    );

    // 1 main query + 1 sharp book group query (all sharp books together)
    assert.equal(
      queryCalls.length,
      2,
      'external dashboard contract: runSharpPlays makes one main query plus sharp book group query'
    );
    assert.equal(
      queryCalls[0].rankedArgs.targetBook,
      'Fliff',
      'external dashboard contract: ranked query should target the execution book'
    );
    assert.equal(
      result.resultMeta.scannedQueryCount,
      2,
      'external dashboard contract: metadata.scannedQueryCount includes sharp book group query'
    );
    assert.equal(
      result.count,
      result.result.length,
      'external dashboard contract: root.count should match result length'
    );
    assert.equal(result.result.length, 1, 'external dashboard contract: fixture should produce one rendered play');

    const [play] = result.result;
    assert.equal(play.targetBook, 'Fliff', 'external dashboard contract: row.targetBook should be preserved');
    assert.equal(play.executionBook, 'Fliff', 'external dashboard contract: row.executionBook should be preserved');
    assert.equal(
      play.verdict,
      'Bet candidate',
      'external dashboard contract: row.verdict should survive the service boundary'
    );
    assert.equal(
      play.movementSourceBook,
      'Pinnacle',
      'external dashboard contract: row.movementSourceBook should be present for dashboard display'
    );
    assert.ok(
      play.sharpPlaySupport && typeof play.sharpPlaySupport === 'object',
      'external dashboard contract: row.sharpPlaySupport should be present'
    );
    assert.equal(
      play.sharpPlaySupport.targetBook,
      'Fliff',
      'external dashboard contract: row.sharpPlaySupport.targetBook should identify the execution book'
    );
    assert.equal(
      play.sharpPlaySupport.movementSourceBook,
      'Pinnacle',
      'external dashboard contract: row.sharpPlaySupport.movementSourceBook should remain available'
    );
    assert.equal(play.game, 'Stub Away vs Stub Home', 'external dashboard contract: row.game should be preserved');
    assert.equal(play.pick, 'Stub Home ML', 'external dashboard contract: row.pick should be preserved');
    assert.ok(Array.isArray(play.prices), 'external dashboard contract: row.prices should be an array');
    assert.ok(
      Array.isArray(play.lineHistorySummary),
      'external dashboard contract: row.lineHistorySummary should be an array'
    );
    assert.equal(
      typeof play.executionQuality,
      'string',
      'external dashboard contract: row.executionQuality should be a string'
    );
    assert.equal(
      typeof play.marketBookCount,
      'number',
      'external dashboard contract: row.marketBookCount should be a number'
    );
    assert.equal(
      typeof play.supportBookCount,
      'number',
      'external dashboard contract: row.supportBookCount should be a number'
    );
  });
});
