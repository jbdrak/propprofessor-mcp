'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { extractScreenRows } = require('../lib/screen-parser');
const { rankLeagueScreenRows } = require('../lib/screen-ranker');
const { mapCandidateRow } = require('../lib/propprofessor-mcp-candidate-mapper');
const { NBA_MONEYLINE_PAYLOAD } = require('./fixtures/screen-payloads');

/**
 * Task 7 — preserve real per-book dollar liquidity/depth in MCP candidate
 * output. The /screen backend payload carries per-book, per-side dollar
 * liquidity (`liquidity1`/`liquidity2` on each book's odds entry; verified
 * in real payloads). These tests lock in that the value follows the
 * SELECTED side at the SELECTED book — the opposite side's volume must
 * never be assigned to the selected side.
 */

describe('liquidity preservation: extractScreenRows (parser)', () => {
  it('stamps per-side liquidityUsd on expanded rows (liquidity1 → side 1, liquidity2 → side 2)', () => {
    const rows = extractScreenRows(NBA_MONEYLINE_PAYLOAD);
    const lakersPinnacle = rows.find((r) => r.book === 'Pinnacle' && r.selection === 'Los Angeles Lakers');
    const celticsPinnacle = rows.find((r) => r.book === 'Pinnacle' && r.selection === 'Boston Celtics');
    assert.ok(lakersPinnacle, 'Lakers/Pinnacle row should exist');
    assert.ok(celticsPinnacle, 'Celtics/Pinnacle row should exist');
    assert.equal(lakersPinnacle.liquidityUsd, 48200, 'side 1 gets liquidity1');
    assert.equal(celticsPinnacle.liquidityUsd, 9650, 'side 2 gets liquidity2');
  });

  it("never assigns the opposite side's liquidity to the selected side", () => {
    const rows = extractScreenRows(NBA_MONEYLINE_PAYLOAD);
    // BookMaker has liquidity1=7600 < liquidity2=8900 — a swapped mapping
    // would surface 8900 on the Lakers (side 1) row.
    const lakersBookMaker = rows.find((r) => r.book === 'BookMaker' && r.selection === 'Los Angeles Lakers');
    const celticsBookMaker = rows.find((r) => r.book === 'BookMaker' && r.selection === 'Boston Celtics');
    assert.ok(lakersBookMaker, 'Lakers/BookMaker row should exist');
    assert.ok(celticsBookMaker, 'Celtics/BookMaker row should exist');
    assert.equal(lakersBookMaker.liquidityUsd, 7600, 'side 1 must NOT receive liquidity2 (8900)');
    assert.equal(celticsBookMaker.liquidityUsd, 8900, 'side 2 gets the deeper BookMaker pool');
  });

  it('keeps liquidityUsd null when the backend provides no liquidity for the book/side', () => {
    const payload = {
      game_data: [
        {
          gameId: 'g1',
          league: 'NBA',
          market: 'Moneyline',
          homeTeam: 'A',
          awayTeam: 'B',
          selections: {
            ml: {
              selection1: 'A',
              selection2: 'B',
              odds: {
                NoVigApp: { odds1: -110, odds2: 105 } // no liquidity fields
              }
            }
          }
        }
      ]
    };
    const rows = extractScreenRows(payload);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.liquidityUsd, null, 'no liquidity field → null, never fabricated');
    }
  });

  it('coerces string liquidity to a number and rejects non-numeric values', () => {
    const payload = {
      game_data: [
        {
          gameId: 'g2',
          league: 'NBA',
          market: 'Moneyline',
          homeTeam: 'A',
          awayTeam: 'B',
          selections: {
            ml: {
              selection1: 'A',
              selection2: 'B',
              odds: {
                NoVigApp: { odds1: -110, odds2: 105, liquidity1: '12345', liquidity2: 'oops' }
              }
            }
          }
        }
      ]
    };
    const rows = extractScreenRows(payload);
    const side1 = rows.find((r) => r.selection === 'A');
    const side2 = rows.find((r) => r.selection === 'B');
    assert.equal(side1.liquidityUsd, 12345, 'numeric strings are real backend values');
    assert.equal(side2.liquidityUsd, null, 'non-numeric → null, never fabricated');
  });
});

describe('liquidity preservation: rankLeagueScreenRows (ranker)', () => {
  // rankLeagueScreenRows operates on extracted rows (the real pipeline is
  // extractScreenRows(payload) → rank), so expand the fixture first.
  const rows = extractScreenRows(NBA_MONEYLINE_PAYLOAD);

  it("ranked rows carry the selected side's dollar liquidity at the resolved book", () => {
    const ranked = rankLeagueScreenRows(rows, {
      league: 'NBA',
      market: 'Moneyline',
      books: ['NoVigApp'],
      includeAll: true
    });
    const expectations = {
      'Los Angeles Lakers': 15420,
      'Boston Celtics': 3100,
      'Golden State Warriors': 8600,
      'Denver Nuggets': 12200, // side 2 carries MORE depth than side 1 here
      'Milwaukee Bucks': 5400,
      'Miami Heat': 4100
    };
    for (const [selection, expected] of Object.entries(expectations)) {
      const row = ranked.find((r) => r.selection === selection);
      assert.ok(row, `expected a ranked row for ${selection}`);
      assert.equal(row.book, 'NoVigApp');
      assert.equal(
        row.liquidityUsd,
        expected,
        `${selection} must carry its own side's liquidity, not the opposite side's`
      );
    }
  });

  it('leaves liquidityUsd null when the payload has no depth fields', () => {
    const payload = {
      game_data: [
        {
          gameId: 'g3',
          league: 'NBA',
          market: 'Moneyline',
          homeTeam: 'A',
          awayTeam: 'B',
          selections: {
            ml: {
              selection1: 'A',
              selection2: 'B',
              odds: { NoVigApp: { odds1: -110, odds2: 105 } }
            }
          }
        }
      ]
    };
    const ranked = rankLeagueScreenRows(extractScreenRows(payload), {
      league: 'NBA',
      market: 'Moneyline',
      books: ['NoVigApp'],
      includeAll: true
    });
    assert.ok(ranked.length >= 1, 'expected at least one ranked row');
    for (const row of ranked) {
      assert.equal(row.liquidityUsd, null, 'absent backend depth → null, never fabricated');
    }
  });
});

describe('liquidity preservation: mapCandidateRow (MCP candidate output)', () => {
  it('surfaces liquidityUsd on the standardized candidate', () => {
    const out = mapCandidateRow({
      selection: 'Los Angeles Lakers',
      book: 'NoVigApp',
      liquidityUsd: 15420
    });
    assert.equal(out.liquidityUsd, 15420);
  });

  it('preserves a real zero and rejects missing/null/non-numeric values', () => {
    assert.equal(mapCandidateRow({ liquidityUsd: 0 }).liquidityUsd, 0, '0 is real depth, keep it');
    assert.equal(mapCandidateRow({}).liquidityUsd, null, 'absent → null, never fabricated');
    assert.equal(mapCandidateRow({ liquidityUsd: null }).liquidityUsd, null, 'null must stay null, not 0');
    assert.equal(mapCandidateRow({ liquidityUsd: 'not-a-number' }).liquidityUsd, null);
  });
});
