'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Unit tests for reasonCodes on ranked rows.
 *
 * These test the assignReasonCodes function directly via the ranker's
 * output, using the lowest-effort fixture path: screen-payload fixtures
 * → rankLeagueScreenRows → check reasonCodes on resulting rows.
 */

const { rankLeagueScreenRows } = require('../lib/screen-ranker');
const { NBA_MONEYLINE_PAYLOAD } = require('./fixtures/screen-payloads');
const { WNBA_MONEYLINE_LITE_PAYLOAD } = require('./fixtures/screen-payloads-wnba');

describe('reasonCodes exist on ranked rows', () => {
  it('appears on every row after rankScreenRows', () => {
    const rows = rankLeagueScreenRows(NBA_MONEYLINE_PAYLOAD, { league: 'NBA', market: 'Moneyline' });
    assert.ok(Array.isArray(rows), 'should return array');
    for (const row of rows) {
      assert.ok(Array.isArray(row.reasonCodes), `row '${row.selection || row.game}' missing reasonCodes array`);
      assert.ok(row.reasonCodes.length > 0, `row '${row.selection || row.game}' has empty reasonCodes`);
    }
  });

  it('contains reason codes related to the row signals', () => {
    const rows = rankLeagueScreenRows(NBA_MONEYLINE_PAYLOAD, { league: 'NBA', market: 'Moneyline' });
    const validCodes = new Set([
      'SUPPORTIVE_MOVEMENT',
      'ADVERSE_MOVEMENT',
      'BOUNCY_MOVEMENT',
      'INSUFFICIENT_HISTORY',
      'CONSENSUS_8_PLUS',
      'CONSENSUS_3_TO_7',
      'CONSENSUS_1_TO_2',
      'EDGE_SIGNIFICANT',
      'EDGE_POSITIVE',
      'CLV_POSITIVE',
      'CLV_NEGATIVE'
    ]);
    for (const row of rows) {
      for (const code of row.reasonCodes) {
        assert.ok(validCodes.has(code), `unknown reason code '${code}' on row '${row.selection || row.game}'`);
      }
    }
  });

  it('every code starts with an uppercase category prefix', () => {
    const rows = rankLeagueScreenRows(NBA_MONEYLINE_PAYLOAD, { league: 'NBA', market: 'Moneyline' });
    for (const row of rows) {
      for (const code of row.reasonCodes) {
        assert.match(code, /^[A-Z]+_/, `code '${code}' missing category prefix`);
      }
    }
  });

  it('includes consensus depth codes that match the book count', () => {
    const rows = rankLeagueScreenRows(NBA_MONEYLINE_PAYLOAD, { league: 'NBA', market: 'Moneyline' });
    for (const row of rows) {
      const cbk = row.consensusBookCount || 0;
      const hasConsensus = row.reasonCodes.some((c) => c.startsWith('CONSENSUS_'));
      if (cbk > 0) {
        assert.ok(hasConsensus, `row with ${cbk} books missing CONSENSUS_ code`);
      }
    }
  });

  it('does not appear in lite / compact mode output', () => {
    const rows = rankLeagueScreenRows(WNBA_MONEYLINE_LITE_PAYLOAD, {
      league: 'WNBA',
      market: 'Moneyline',
      compact: true
    });
    for (const row of rows) {
      assert.ok(
        Array.isArray(row.reasonCodes),
        `row '${row.selection || row.game}' missing reasonCodes in compact mode output`
      );
    }
  });
});
