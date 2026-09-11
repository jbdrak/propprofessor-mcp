'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { sortRows, VALID_SORT_KEYS, VALID_SORT_DIRS, toNumberOrEpoch } = require('../lib/ssb-sort-utils');

describe('VALID_SORT_KEYS', () => {
  it('exposes the five supported sort keys', () => {
    assert.ok(VALID_SORT_KEYS.has('start'));
    assert.ok(VALID_SORT_KEYS.has('edge'));
    assert.ok(VALID_SORT_KEYS.has('tier'));
    assert.ok(VALID_SORT_KEYS.has('consensusBookCount'));
    assert.ok(VALID_SORT_KEYS.has('riskScore'));
    assert.equal(VALID_SORT_KEYS.size, 5);
  });
});

describe('VALID_SORT_DIRS', () => {
  it('exposes asc and desc only', () => {
    assert.deepEqual([...VALID_SORT_DIRS].sort(), ['asc', 'desc']);
  });
});

describe('sortRows — backward compat (no-op)', () => {
  const sample = [{ selection: 'A' }, { selection: 'B' }, { selection: 'C' }];

  it('returns input unchanged when no sortBy', () => {
    assert.equal(sortRows(sample), sample);
  });

  it('returns input unchanged for invalid sortBy', () => {
    assert.equal(sortRows(sample, { sortBy: 'GARBAGE' }), sample);
  });

  it('returns input unchanged for non-array rows', () => {
    assert.equal(sortRows(null, { sortBy: 'start' }), null);
    assert.equal(sortRows(undefined, { sortBy: 'start' }), undefined);
  });
});

describe('sortRows — sort by start', () => {
  const rows = [
    { selection: 'A', start: 200 },
    { selection: 'B', start: 100 },
    { selection: 'C', start: 300 }
  ];

  it('defaults to ascending (soonest first)', () => {
    const result = sortRows(rows, { sortBy: 'start' });
    assert.deepEqual(
      result.map((r) => r.selection),
      ['B', 'A', 'C']
    );
  });

  it('respects sortDir=desc', () => {
    const result = sortRows(rows, { sortBy: 'start', sortDir: 'desc' });
    assert.deepEqual(
      result.map((r) => r.selection),
      ['C', 'A', 'B']
    );
  });

  it('handles string ISO start times via Date coercion', () => {
    const iso = [
      { selection: 'A', start: '2026-07-04T20:00:00Z' },
      { selection: 'B', start: '2026-07-04T15:00:00Z' },
      { selection: 'C', start: '2026-07-04T18:00:00Z' }
    ];
    const result = sortRows(iso, { sortBy: 'start' });
    assert.deepEqual(
      result.map((r) => r.selection),
      ['B', 'C', 'A']
    );
  });

  it('sends missing start to the end (regardless of direction)', () => {
    const mixed = [{ selection: 'A', start: 200 }, { selection: 'B' }, { selection: 'C', start: 100 }];
    // Missing start always goes to the end, in both directions.
    const asc = sortRows(mixed, { sortBy: 'start' });
    assert.equal(asc[asc.length - 1].selection, 'B');
    const desc = sortRows(mixed, { sortBy: 'start', sortDir: 'desc' });
    assert.equal(desc[desc.length - 1].selection, 'B');
  });

  it('falls back to startTimestamp if start is missing', () => {
    const rows = [
      { selection: 'A', startTimestamp: 200 },
      { selection: 'B', startTimestamp: 100 }
    ];
    const result = sortRows(rows, { sortBy: 'start' });
    assert.equal(result[0].selection, 'B');
  });
});

describe('sortRows — sort by edge', () => {
  const rows = [
    { selection: 'A', edge: 1.5 },
    { selection: 'B', edge: 3.2 },
    { selection: 'C', edge: 0.5 }
  ];

  it('defaults to descending (largest edge first)', () => {
    const result = sortRows(rows, { sortBy: 'edge' });
    assert.deepEqual(
      result.map((r) => r.selection),
      ['B', 'A', 'C']
    );
  });

  it('respects sortDir=asc', () => {
    const result = sortRows(rows, { sortBy: 'edge', sortDir: 'asc' });
    assert.deepEqual(
      result.map((r) => r.selection),
      ['C', 'A', 'B']
    );
  });

  it('falls back to consensusEdge when edge is missing', () => {
    const rows = [
      { selection: 'A', consensusEdge: 2.0 },
      { selection: 'B', consensusEdge: 4.0 }
    ];
    const result = sortRows(rows, { sortBy: 'edge' });
    assert.equal(result[0].selection, 'B');
  });

  it('treats missing edge as null (sends to end)', () => {
    const mixed = [{ selection: 'A', edge: 1.5 }, { selection: 'B' }, { selection: 'C', edge: 3.2 }];
    const result = sortRows(mixed, { sortBy: 'edge' });
    assert.equal(result[result.length - 1].selection, 'B');
  });
});

describe('sortRows — sort by tier', () => {
  const rows = [
    { selection: 'A', confidenceTier: 'TIER 3' },
    { selection: 'B', confidenceTier: 'TIER 1' },
    { selection: 'C', confidenceTier: 'TIER 2' },
    { selection: 'D', confidenceTier: 'TIER 4' }
  ];

  it('defaults to ascending (TIER 1 first)', () => {
    const result = sortRows(rows, { sortBy: 'tier' });
    assert.deepEqual(
      result.map((r) => r.selection),
      ['B', 'C', 'A', 'D']
    );
  });

  it('respects sortDir=desc', () => {
    const result = sortRows(rows, { sortBy: 'tier', sortDir: 'desc' });
    assert.deepEqual(
      result.map((r) => r.selection),
      ['D', 'A', 'C', 'B']
    );
  });

  it('accepts the short "tier" alias', () => {
    const rows = [
      { selection: 'A', tier: 'TIER 2' },
      { selection: 'B', tier: 'TIER 1' }
    ];
    const result = sortRows(rows, { sortBy: 'tier' });
    assert.equal(result[0].selection, 'B');
  });

  it('sends missing tier to the end', () => {
    const mixed = [
      { selection: 'A', confidenceTier: 'TIER 2' },
      { selection: 'B' },
      { selection: 'C', confidenceTier: 'TIER 1' }
    ];
    const result = sortRows(mixed, { sortBy: 'tier' });
    assert.equal(result[result.length - 1].selection, 'B');
  });
});

describe('sortRows — sort by consensusBookCount', () => {
  it('defaults to descending (most books first)', () => {
    const rows = [
      { selection: 'A', consensusBookCount: 3 },
      { selection: 'B', consensusBookCount: 10 },
      { selection: 'C', consensusBookCount: 5 }
    ];
    const result = sortRows(rows, { sortBy: 'consensusBookCount' });
    assert.deepEqual(
      result.map((r) => r.selection),
      ['B', 'C', 'A']
    );
  });

  it('treats missing consensusBookCount as null (sends to end)', () => {
    const mixed = [{ selection: 'A', consensusBookCount: 5 }, { selection: 'B' }];
    const result = sortRows(mixed, { sortBy: 'consensusBookCount' });
    assert.equal(result[0].selection, 'A');
    assert.equal(result[result.length - 1].selection, 'B');
  });
});

describe('sortRows — sort by riskScore', () => {
  it('defaults to ascending (lowest risk first)', () => {
    const rows = [
      { selection: 'A', riskScore: 8 },
      { selection: 'B', riskScore: 2 },
      { selection: 'C', riskScore: 5 }
    ];
    const result = sortRows(rows, { sortBy: 'riskScore' });
    assert.deepEqual(
      result.map((r) => r.selection),
      ['B', 'C', 'A']
    );
  });

  it('treats missing riskScore as null (sends to end)', () => {
    const mixed = [{ selection: 'A', riskScore: 5 }, { selection: 'B' }];
    const result = sortRows(mixed, { sortBy: 'riskScore' });
    assert.equal(result[0].selection, 'A');
    assert.equal(result[result.length - 1].selection, 'B');
  });
});

describe('sortRows — does not mutate input', () => {
  it('returns a new array even when sorting', () => {
    const rows = [
      { selection: 'A', start: 200 },
      { selection: 'B', start: 100 }
    ];
    const result = sortRows(rows, { sortBy: 'start' });
    assert.notEqual(result, rows);
    assert.equal(rows[0].selection, 'A'); // input unchanged
  });
});

describe('sortRows — stable sort preserves input order on ties', () => {
  it('keeps original order for rows with equal sort keys', () => {
    const rows = [
      { selection: 'A', edge: 1.0 },
      { selection: 'B', edge: 1.0 },
      { selection: 'C', edge: 1.0 }
    ];
    const result = sortRows(rows, { sortBy: 'edge' });
    assert.deepEqual(
      result.map((r) => r.selection),
      ['A', 'B', 'C']
    );
  });
});

describe('toNumberOrEpoch', () => {
  const FB = -1;

  it('returns numbers as-is when finite', () => {
    assert.equal(toNumberOrEpoch(42, FB), 42);
    assert.equal(toNumberOrEpoch(0, FB), 0);
    assert.equal(toNumberOrEpoch(-3.14, FB), -3.14);
  });

  it('returns fallback for NaN / Infinity', () => {
    assert.equal(toNumberOrEpoch(NaN, FB), FB);
    assert.equal(toNumberOrEpoch(Infinity, FB), FB);
  });

  it('parses numeric strings', () => {
    assert.equal(toNumberOrEpoch('1717708800', FB), 1717708800);
    assert.equal(toNumberOrEpoch('-156.5', FB), -156.5);
  });

  it('parses ISO date strings to epoch ms', () => {
    const t = toNumberOrEpoch('2026-07-04T20:00:00Z', FB);
    assert.ok(Number.isFinite(t));
    assert.ok(t > 0);
  });

  it('returns fallback for non-numeric, non-date strings', () => {
    assert.equal(toNumberOrEpoch('hello', FB), FB);
    assert.equal(toNumberOrEpoch('', FB), FB);
  });

  it('returns fallback for null / undefined', () => {
    assert.equal(toNumberOrEpoch(null, FB), FB);
    assert.equal(toNumberOrEpoch(undefined, FB), FB);
  });
});
