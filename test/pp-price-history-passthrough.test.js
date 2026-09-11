'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { stripExactLineHistoryFields } = require('../scripts/server/handlers/strip-exact-line-history');
const { rankLeagueScreenRows } = require('../lib/screen-ranker');
const { compactRow } = require('../lib/ssb-mcp-ranked-screen');
const { formatBetStandard, formatGetPlayDetailsStandard } = require('../lib/ssb-formatter');

const PRICE_FIELDS = {
  priceHistoryUsable: true,
  priceHistoryScope: 'selection_id',
  priceHistorySource: 'odds_history',
  priceHistoryPointCount: 6
};

// Tennis Total Games exact row: native PP returned timestamped odds but no
// historical line fields, so line history is degraded while selection-scoped
// price history is usable.
function exactTennisRow() {
  return {
    gameId: 'Tennis:GAME:Dencheva:Jones:1788940800',
    league: 'Tennis',
    market: 'Total Games',
    selection: 'Over 20.5',
    selectionId: 'Total Games:Over_20.5',
    line: 20.5,
    book: 'NoVigApp',
    odds: -111,
    currentOdds: -111,
    targetBookOdds: -111,
    liquidityUsd: 46,
    lineHistory: [
      { odds: -115, line: null, time: 1781397799000 },
      { odds: -111, line: null, time: 1781404060000 }
    ],
    lineHistoryAvailable: false,
    lineHistoryUsable: false,
    lineHistoryQuality: 'degraded_line_fields',
    lineFieldMissingCount: 2,
    movementDisposition: 'insufficient',
    ...PRICE_FIELDS
  };
}

describe('Task 4: price-history provenance survives output boundaries', () => {
  it('stripExactLineHistoryFields drops price fields on suppressed rows, keeps them on exact rows', () => {
    const suppressed = { ...exactTennisRow(), exactLineHistorySuppressed: true };
    const exact = { ...exactTennisRow() };
    stripExactLineHistoryFields([suppressed, exact]);
    for (const field of Object.keys(PRICE_FIELDS)) {
      assert.equal(suppressed[field], undefined, `suppressed row must not leak ${field}`);
      assert.deepEqual(exact[field], PRICE_FIELDS[field], `exact row must keep ${field}`);
    }
    // Exact row keeps its quote and liquidity untouched.
    assert.equal(exact.odds, -111);
    assert.equal(exact.liquidityUsd, 46);
  });

  it('rankLeagueScreenRows preserves provenance without changing the BET gate', () => {
    const withPrice = exactTennisRow();
    const withoutPrice = { ...exactTennisRow() };
    for (const field of Object.keys(PRICE_FIELDS)) delete withoutPrice[field];
    const rankedWith = rankLeagueScreenRows([withPrice], {
      league: 'Tennis',
      market: 'Total Games',
      books: ['NoVigApp'],
      includeAll: true
    });
    const rankedWithout = rankLeagueScreenRows([withoutPrice], {
      league: 'Tennis',
      market: 'Total Games',
      books: ['NoVigApp'],
      includeAll: true
    });
    assert.equal(rankedWith.length, 1, 'exact row must survive ranking');
    const row = rankedWith[0];
    for (const [field, value] of Object.entries(PRICE_FIELDS)) {
      assert.deepEqual(row[field], value, `ranked row must carry ${field}`);
    }
    assert.deepEqual(
      row.rankingProvenance && {
        priceHistoryUsable: row.rankingProvenance.priceHistoryUsable,
        priceHistoryScope: row.rankingProvenance.priceHistoryScope,
        priceHistorySource: row.rankingProvenance.priceHistorySource,
        priceHistoryPointCount: row.rankingProvenance.priceHistoryPointCount
      },
      PRICE_FIELDS,
      'rankingProvenance must carry price provenance'
    );
    // Price history may resolve the direction, but it must not certify line history.
    assert.equal(row.kaiCall, 'PASS', 'degraded execution/context must not read BET');
    assert.equal(row.movementDisposition, 'adverse_full');
    assert.notEqual(row.movementDisposition, rankedWithout[0].movementDisposition);
    assert.equal(row.lineHistoryUsable, false, 'price history must not promote lineHistoryUsable');
    assert.equal(row.movementHistoryUsable, false, 'mixed-book fallback is not sharp movement');
    // Quote and side liquidity preserved.
    assert.equal(row.odds, -111);
    assert.equal(row.liquidityUsd, 46);
  });

  it('compactRow keeps price provenance', () => {
    const compacted = compactRow(exactTennisRow());
    for (const [field, value] of Object.entries(PRICE_FIELDS)) {
      assert.deepEqual(compacted[field], value, `compact row must keep ${field}`);
    }
  });

  it('standard formatter keeps price provenance on exact detail rows', () => {
    const single = formatBetStandard(exactTennisRow());
    for (const [field, value] of Object.entries(PRICE_FIELDS)) {
      assert.deepEqual(single[field], value, `formatBetStandard must keep ${field}`);
    }
    const response = formatGetPlayDetailsStandard({
      ok: true,
      result: [exactTennisRow()],
      resultMeta: { matchedRows: 1 }
    });
    for (const [field, value] of Object.entries(PRICE_FIELDS)) {
      assert.deepEqual(response.result[0][field], value, `standard detail response must keep ${field}`);
    }
    assert.ok(
      response.result[0].odds !== undefined && response.result[0].odds !== null,
      'standard detail response must keep an exact quote'
    );
  });
});
