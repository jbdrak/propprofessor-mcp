'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { annotateRankedRows } = require('../lib/ssb-ranked-screen-row-annotation');

describe('annotateRankedRows', () => {
  it('adds selection and play IDs and refreshes stale rationale', () => {
    const row = { participant: 'Player One', movementDisposition: 'supportive_bouncy' };
    const calls = [];

    const result = annotateRankedRows([row], {
      normalizeSelectionKey: (value) => `key:${value}`,
      buildCanonicalPlayId: (value) => `play:${value.selectionKey}`,
      computeMovementDisposition: () => 'supportive_clean',
      buildRationale: (value) => {
        calls.push(value);
        return 'refreshed rationale';
      }
    });

    assert.deepEqual(result, [row]);
    assert.equal(row.selectionKey, 'key:Player One');
    assert.equal(row.playId, 'play:key:Player One');
    assert.equal(row.movementDisposition, 'supportive_clean');
    assert.equal(row.rationale, 'refreshed rationale');
    assert.deepEqual(calls, [row]);
  });

  it('does not refresh rationale when the disposition is unchanged', () => {
    const row = { selection: 'Over 2.5', movementDisposition: 'supportive_clean' };
    let rationaleCalls = 0;

    annotateRankedRows([row], {
      normalizeSelectionKey: (value) => value,
      buildCanonicalPlayId: () => 'play-id',
      computeMovementDisposition: () => 'supportive_clean',
      buildRationale: () => {
        rationaleCalls += 1;
        return 'should not run';
      }
    });

    assert.equal(row.playId, 'play-id');
    assert.equal(rationaleCalls, 0);
    assert.equal(row.rationale, undefined);
  });

  it('forces PASS/TIER 4 when final movement becomes insufficient', () => {
    const row = {
      selection: 'Over 33.5',
      movementDisposition: 'supportive_bouncy',
      kaiCall: 'BET',
      confidenceTier: 'TIER 1',
      confidenceTierLive: 'TIER 1'
    };

    annotateRankedRows([row], {
      normalizeSelectionKey: (value) => value,
      buildCanonicalPlayId: () => 'play-id',
      computeMovementDisposition: () => 'insufficient',
      buildRationale: (value) => `${value.kaiCall}/${value.confidenceTier}`
    });

    assert.equal(row.movementDisposition, 'insufficient');
    assert.equal(row.kaiCall, 'PASS');
    assert.equal(row.confidenceTier, 'TIER 4');
    assert.equal(row.confidenceTierLive, 'TIER 4');
    assert.equal(row.rationale, 'PASS/TIER 4');
  });
});
