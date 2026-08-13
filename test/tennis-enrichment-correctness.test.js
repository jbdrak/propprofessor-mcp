'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { enrichTennisEvCandidates } = require('../lib/screen-tennis');

function candidate(sportsbookData) {
  return {
    gameId: 'Tennis:PREMATCH:Player_A:Player_B:1786017600',
    selectionId: 'Moneyline:Player_A',
    selection: 'Player A',
    market: 'Moneyline',
    sportsbookData
  };
}

function historyResponse() {
  return {
    Pinnacle: [
      { odds: -150, start_ts: 1 },
      { odds: -175, start_ts: 2 }
    ]
  };
}

const client = {
  queryOddsHistory: async () => historyResponse()
};

describe('tennis enrichment execution and movement correctness', () => {
  it('normalizes book-keyed history and treats -150 to -175 as supportive', async () => {
    const [row] = await enrichTennisEvCandidates(
      [
        candidate([
          { book: 'NoVigApp', odds: -170 },
          { book: 'Pinnacle', odds: -175 }
        ])
      ],
      client,
      { preferredBook: 'NoVigApp' }
    );
    assert.equal(row.lineHistoryAvailable, true);
    assert.ok(row.clvProxyPct > 0);
    assert.match(row.movementDisposition, /^supportive/);
  });

  it('uses noVigOdds as the preferred execution quote', async () => {
    const [row] = await enrichTennisEvCandidates(
      [
        candidate([
          { book: 'NoVigApp', noVigOdds: -120 },
          { book: 'Pinnacle', odds: -115 }
        ])
      ],
      client
    );
    assert.equal(row.targetBookOdds, -120);
    assert.equal(row.isActionable, true);
  });

  it('fails closed when the preferred execution quote is missing', async () => {
    const [row] = await enrichTennisEvCandidates([candidate([{ book: 'Pinnacle', odds: -110 }])], client);
    assert.equal(row.targetBookOdds, null);
    assert.equal(row.isActionable, false);
    assert.equal(row.executionUnavailable, true);
  });
});
