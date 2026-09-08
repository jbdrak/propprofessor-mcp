'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildRankedScreenResponse } = require('../lib/propprofessor-mcp-ranked-screen');

function spreadPayloadRow(selection, line, bookOdds) {
  return {
    gameId: 'NCAAF:GAME:Villanova:Penn_State:1788636600',
    league: 'NCAAF',
    market: 'Point Spread',
    selection1: selection,
    participant1: 'Villanova',
    selection1Id: `Point Spread:${selection}`,
    selection2: 'Penn State +26.5',
    participant2: 'Penn State',
    selection2Id: 'Point Spread:Penn State',
    line1: line,
    odds: bookOdds,
    timestamp: Date.now()
  };
}

function twoBookOdds() {
  return {
    NoVigApp: { odds1: -110, odds2: -110 },
    Pinnacle: { odds1: -112, odds2: -108 },
    Circa: { odds1: -109, odds2: -111 }
  };
}

function oneBookOdds() {
  return { NoVigApp: { odds1: -110, odds2: -110 } };
}

describe('buildRankedScreenResponse — pre-hydration alt-line prune', () => {
  it('never spends history queries on alt lines and reports the prune count', async () => {
    const historySelectionIds = [];
    const payload = {
      rows: [
        spreadPayloadRow('Villanova -26.5', -26.5, twoBookOdds()),
        spreadPayloadRow('Villanova -27.5', -27.5, oneBookOdds()),
        spreadPayloadRow('Villanova -25.5', -25.5, oneBookOdds())
      ]
    };
    const client = {
      queryOddsHistory: async (params) => {
        historySelectionIds.push(String(params.selectionId || ''));
        return [];
      }
    };

    const result = await buildRankedScreenResponse({
      client,
      payloads: [payload],
      args: { league: 'NCAAF', market: 'Point Spread', historySportsbooks: ['Pinnacle'] },
      focusBook: 'NoVigApp',
      rankRows: (rows) => rows
    });

    assert.ok(historySelectionIds.length > 0, 'main line history should be fetched');
    assert.ok(
      historySelectionIds.every((id) => !id.includes('27.5') && !id.includes('25.5')),
      `no history query for alt lines, got: ${historySelectionIds.join(', ')}`
    );
    assert.equal(result.resultMeta.preHydrationAltPruned, 2, 'expected 2 pruned alt rows');
    assert.equal(result.result.filter((r) => r.altLineFiltered).length, 0, 'no alt-line rows should survive in output');
  });
});

describe('buildRankedScreenResponse — hydration deadline', () => {
  it('returns snapshot rows with historyPartial instead of hanging', async () => {
    const payload = {
      rows: [
        {
          gameId: 'game-hang',
          league: 'NBA',
          market: 'Moneyline',
          selection1: 'Home game-hang',
          participant1: 'Home game-hang',
          selection1Id: 'Moneyline:Home_game-hang',
          selection2: 'Away game-hang',
          participant2: 'Away game-hang',
          selection2Id: 'Moneyline:Away_game-hang',
          odds: { NoVigApp: { odds1: -100, odds2: 100 } },
          timestamp: Date.now()
        }
      ]
    };
    const client = {
      // Never settles — simulates a hung upstream.
      queryOddsHistory: () => new Promise(() => {})
    };

    const startedAt = Date.now();
    const result = await buildRankedScreenResponse({
      client,
      payloads: [payload],
      args: { league: 'NBA', market: 'Moneyline', historyDeadlineMs: 300 },
      focusBook: 'NoVigApp',
      rankRows: (rows) => rows
    });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 30000, `deadline must fire fast, took ${elapsed}ms`);
    assert.equal(result.resultMeta.historyPartial, true, 'historyPartial must be flagged');
    assert.ok(result.result.length > 0, 'snapshot rows must still be returned');
  });
});
