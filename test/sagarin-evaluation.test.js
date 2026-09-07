'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSagarinRows, scoreSagarinRows, segmentSagarinRows } = require('../lib/sagarin-external-evaluation');

describe('sagarin-evaluation adapter', () => {
  it('maps explicit outcomes, probability, timestamps, segment and matched status', () => {
    const { rows, unresolved } = normalizeSagarinRows([
      {
        outcome: 'won',
        modelWinProbability: 0.7,
        predictionTimestamp: '2026-09-03T12:00:00Z',
        sourceTimestamp: '2026-09-06T00:00:00Z',
        segment: 'fbs',
        matched: true
      }
    ]);
    assert.equal(unresolved.length, 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'win');
    assert.equal(rows[0].modelWinProbability, 0.7);
    assert.equal(rows[0].predictionTimestamp, '2026-09-03T12:00:00Z');
    assert.equal(rows[0].sourceTimestamp, '2026-09-06T00:00:00Z');
    assert.equal(rows[0].segment, 'FBS');
    assert.equal(rows[0].status, 'matched');
  });

  it('marks missing or unparseable provenance as unresolved, never scored', () => {
    const input = [
      { outcome: 'win', modelWinProbability: 0.6, segment: 'FBS', matched: true },
      { outcome: 'win', modelWinProbability: 0.6, predictionTimestamp: 'not-a-date', segment: 'FBS', matched: true }
    ];
    const { rows, unresolved } = normalizeSagarinRows(input);
    assert.equal(unresolved.length, 2);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.status === 'unresolved'));
    const scored = scoreSagarinRows(input);
    assert.deepEqual(scored.scores, {});
    assert.equal(scored.counts.unresolved, 2);
    assert.equal(scored.counts.resolved, 0);
  });

  it('marks post-decision (stale) predictions as unresolved', () => {
    const { rows } = normalizeSagarinRows([
      {
        outcome: 'win',
        modelWinProbability: 0.8,
        predictionTimestamp: '2026-09-07T12:00:00Z',
        gameTimestamp: '2026-09-06T12:00:00Z',
        segment: 'FBS',
        matched: true
      }
    ]);
    assert.equal(rows[0].status, 'unresolved');
    assert.match(rows[0].unresolvedReason, /stale|post-decision/i);
  });

  it('preserves unmatched rows and excludes them from the scoring denominator', () => {
    const scored = scoreSagarinRows([
      {
        outcome: 'win',
        modelWinProbability: 0.9,
        predictionTimestamp: '2026-09-03T12:00:00Z',
        segment: 'FBS',
        matched: true
      },
      {
        outcome: 'loss',
        modelWinProbability: 0.1,
        predictionTimestamp: '2026-09-03T12:00:00Z',
        segment: 'FCS',
        matched: false
      }
    ]);
    assert.equal(scored.counts.unmatched, 1);
    assert.equal(scored.counts.resolved, 1);
    assert.equal(scored.scores.modelWinProbability.brier.samples, 1);
  });

  it('omits invalid probabilities without substituting another field', () => {
    const scored = scoreSagarinRows([
      {
        outcome: 'win',
        modelWinProbability: 1.5,
        predictionTimestamp: '2026-09-03T12:00:00Z',
        segment: 'FBS',
        matched: true
      }
    ]);
    assert.equal(scored.counts.resolved, 1);
    assert.deepEqual(scored.scores, {});
  });

  it('sorts chronologically by prediction timestamp, unparseable last', () => {
    const { rows } = normalizeSagarinRows([
      {
        outcome: 'win',
        predictionTimestamp: '2026-09-05T12:00:00Z',
        segment: 'FBS',
        matched: true
      },
      {
        outcome: 'loss',
        predictionTimestamp: '2026-09-03T12:00:00Z',
        segment: 'FBS',
        matched: true
      }
    ]);
    assert.equal(rows[0].predictionTimestamp, '2026-09-03T12:00:00Z');
    assert.equal(rows[1].predictionTimestamp, '2026-09-05T12:00:00Z');
  });

  it('segments resolved matched rows by FBS/FCS via the existing helper', () => {
    const segmented = segmentSagarinRows(
      [
        {
          outcome: 'win',
          modelWinProbability: 0.6,
          predictionTimestamp: '2026-09-03T12:00:00Z',
          segment: 'FBS',
          matched: true
        },
        {
          outcome: 'loss',
          modelWinProbability: 0.4,
          predictionTimestamp: '2026-09-03T12:00:00Z',
          segment: 'FCS',
          matched: true
        },
        {
          outcome: 'win',
          modelWinProbability: 0.6,
          predictionTimestamp: '2026-09-03T12:00:00Z',
          segment: 'FCS',
          matched: false
        }
      ],
      { minSample: 1 }
    );
    assert.deepEqual(segmented.dimensions, ['segment']);
    assert.equal(segmented.segments['FBS'].wins, 1);
    assert.equal(segmented.segments['FCS'].losses, 1);
    assert.equal(segmented.counts.unmatched, 1);
  });
});
