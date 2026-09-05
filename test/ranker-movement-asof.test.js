'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { latestHistoryTimestampIso } = require('../lib/screen-ranker');

describe('latestHistoryTimestampIso', () => {
  it('returns the newest point as ISO across mixed key shapes and units', () => {
    const iso = latestHistoryTimestampIso([
      { time: 1788635228265, odds: -156 },
      { start_ts: 1788635400, odds: -157 }, // seconds-epoch
      { raw: { start_ts: 1788635500000 }, odds: -155 }
    ]);
    assert.equal(iso, new Date(1788635500000).toISOString());
  });

  it('returns null for empty, missing, or timestamp-less history', () => {
    assert.equal(latestHistoryTimestampIso([]), null);
    assert.equal(latestHistoryTimestampIso(null), null);
    assert.equal(latestHistoryTimestampIso(undefined), null);
    assert.equal(latestHistoryTimestampIso([{ odds: -110 }]), null);
    assert.equal(latestHistoryTimestampIso([{ time: 'garbage' }]), null);
  });
});
