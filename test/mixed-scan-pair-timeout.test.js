'use strict';

// Focused coverage for withPairTimeout integration into the mixed-scan fan-out
// (queryRankedSharpPlayResponses in propprofessor-sharp-plays-service.js).
//
// PAIR_TIMEOUT_MS is read once at module load, so we set the env var and
// cache-bust the module to exercise the timeout path deterministically.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapCandidateRow } = require('../lib/propprofessor-mcp-candidate-mapper');

function loadServiceWithTimeout(ms) {
  const prev = process.env.PP_PAIR_TIMEOUT_MS;
  process.env.PP_PAIR_TIMEOUT_MS = String(ms);
  // Drop any cached copy so the module-load const picks up the new env.
  for (const key of Object.keys(require.cache)) {
    if (key.includes('propprofessor-sharp-plays-service')) delete require.cache[key];
  }
  const svc = require('../lib/propprofessor-sharp-plays-service');
  if (prev === undefined) delete process.env.PP_PAIR_TIMEOUT_MS;
  else process.env.PP_PAIR_TIMEOUT_MS = prev;
  return svc.runSharpPlays;
}

describe('mixed-scan pair timeout isolation', () => {
  it('isolates a hung league×market pair and preserves sibling-league rows', async () => {
    const runSharpPlays = loadServiceWithTimeout(80); // extremely tight cap

    const queryLeagueScreen = async (rankedArgs, league) => {
      if (league === 'MLB') {
        // Simulate a slow/never-resolving pair.
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
      return {
        ok: true,
        result: [
          {
            gameId: `${league}-game`,
            league,
            market: rankedArgs.market,
            selection: 'Side A',
            participant: 'Side A',
            book: 'NoVigApp',
            odds: -110,
            executionQuality: 'best',
            consensusBookCount: 2,
            allBookOdds: { DraftKings: -110, FanDuel: -108, NoVigApp: -110 }
          }
        ]
      };
    };
    const queryTennisScreen = async (rankedArgs) => ({
      ok: true,
      result: [
        {
          gameId: 'Tennis-game',
          league: 'Tennis',
          market: rankedArgs.market,
          selection: 'Player A',
          participant: 'Player A',
          book: 'NoVigApp',
          odds: -120,
          executionQuality: 'best',
          consensusBookCount: 2,
          allBookOdds: { DraftKings: -120, FanDuel: -118, NoVigApp: -120 }
        }
      ]
    });

    const result = await runSharpPlays(
      {
        book: 'NoVigApp',
        targetBooks: ['NoVigApp'],
        leagues: ['Tennis', 'MLB', 'UFC'],
        quickScreenAggregate: true,
        limit: 5,
        scanLimit: 5,
        minConsensusBookCount: 1,
        lookbackHours: 6,
        strict: false,
        includePasses: true
      },
      { queryLeagueScreen, queryTennisScreen }
    );

    // The scan must NOT throw — the hung MLB pair is isolated.
    assert.equal(result.ok, true);

    // Tennis and UFC rows must survive the MLB timeout.
    const leaguesWithRows = new Set(result.result.map((r) => r.scanLeague || r.league));
    assert.ok(leaguesWithRows.has('Tennis'), 'Tennis rows preserved despite MLB hang');
    assert.ok(leaguesWithRows.has('UFC'), 'UFC rows preserved despite MLB hang');
    assert.ok(!leaguesWithRows.has('MLB'), 'MLB pair timed out and yields no rows');

    // The timed-out pair must surface as a failure in perPairDiagnostics
    // (not silently dropped, not crash the scan).
    const mlbDiag = result.resultMeta.perPairDiagnostics.find((d) => d.league === 'MLB');
    assert.ok(mlbDiag, 'MLB present in perPairDiagnostics');
    assert.ok(mlbDiag.failureReason || mlbDiag.scannedRowCount === 0, 'MLB failure recorded');

    // The surviving sibling row carries its full allBookOdds map. proxyOdds is
    // attached later by mapCandidateRow (in handlers.js), not inside runSharpPlays,
    // so verify the proxy-metadata derivation + executable-odds integrity on the
    // mapped candidate rather than the raw fan-out result.
    const tennisRow = result.result.find((r) => r.scanLeague === 'Tennis');
    assert.ok(tennisRow, 'a Tennis row survived');
    const mapped = mapCandidateRow(tennisRow);
    assert.ok(mapped.proxyOdds && mapped.proxyOdds.book === 'DraftKings', 'DK proxy odds exposed via mapper');

    // Executable odds on the surviving row must remain the execution-book price,
    // NOT a proxy book price, and must not be altered by proxy derivation.
    assert.equal(mapped.odds, -120, 'executable odds untouched by proxy metadata');
    assert.equal(mapped.book, 'NoVigApp', 'executable book untouched by proxy metadata');
  });
});
