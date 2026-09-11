'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { filterRowsByKaiCall, normalizeKaiCallFilter, rowKaiCall, VALID_TIERS } = require('../lib/ssb-row-filter');

describe('rowKaiCall', () => {
  it('returns kaiCall field when present', () => {
    assert.equal(rowKaiCall({ kaiCall: 'BET' }), 'BET');
    assert.equal(rowKaiCall({ kaiCall: 'CONSIDER' }), 'CONSIDER');
    assert.equal(rowKaiCall({ kaiCall: 'PASS' }), 'PASS');
  });

  it('falls back to displayTier when kaiCall missing', () => {
    assert.equal(rowKaiCall({ displayTier: 'BET' }), 'BET');
  });

  it('normalizes case', () => {
    assert.equal(rowKaiCall({ kaiCall: 'bet' }), 'BET');
    assert.equal(rowKaiCall({ kaiCall: '  Consider  ' }), 'CONSIDER');
  });

  it('returns PASS for unknown values', () => {
    assert.equal(rowKaiCall({ kaiCall: 'GARBAGE' }), 'PASS');
    assert.equal(rowKaiCall({}), 'PASS');
    assert.equal(rowKaiCall({ kaiCall: null }), 'PASS');
    assert.equal(rowKaiCall(null), 'PASS');
  });
});

describe('normalizeKaiCallFilter', () => {
  it('returns null for empty/missing input', () => {
    assert.equal(normalizeKaiCallFilter(undefined), null);
    assert.equal(normalizeKaiCallFilter(null), null);
    assert.equal(normalizeKaiCallFilter([]), null);
  });

  it('accepts single string', () => {
    const s = normalizeKaiCallFilter('BET');
    assert.ok(s instanceof Set);
    assert.equal(s.size, 1);
    assert.ok(s.has('BET'));
  });

  it('accepts array of strings', () => {
    const s = normalizeKaiCallFilter(['BET', 'CONSIDER']);
    assert.equal(s.size, 2);
    assert.ok(s.has('BET'));
    assert.ok(s.has('CONSIDER'));
  });

  it('normalizes case and trims whitespace', () => {
    const s = normalizeKaiCallFilter(['  bet  ', 'CONSIDER']);
    assert.equal(s.size, 2);
    assert.ok(s.has('BET'));
  });

  it('drops invalid entries silently', () => {
    const s = normalizeKaiCallFilter(['BET', 'GARBAGE', 'CONSIDER', null]);
    assert.equal(s.size, 2);
    assert.ok(s.has('BET'));
    assert.ok(s.has('CONSIDER'));
  });

  it('returns null when ALL entries are invalid', () => {
    assert.equal(normalizeKaiCallFilter(['GARBAGE', null]), null);
  });
});

describe('filterRowsByKaiCall', () => {
  const rows = [
    { selection: 'A', kaiCall: 'BET' },
    { selection: 'B', kaiCall: 'CONSIDER' },
    { selection: 'C', kaiCall: 'PASS' },
    { selection: 'D', displayTier: 'BET' },
    { selection: 'E', kaiCall: 'GARBAGE' },
    { selection: 'F' }
  ];

  it('returns input unchanged when no filter (backward compat)', () => {
    const result = filterRowsByKaiCall(rows, undefined);
    assert.equal(result, rows);
  });

  it('returns input unchanged for empty array filter', () => {
    const result = filterRowsByKaiCall(rows, []);
    assert.equal(result, rows);
  });

  it('filters to BET only', () => {
    const result = filterRowsByKaiCall(rows, ['BET']);
    assert.equal(result.length, 2);
    assert.equal(result[0].selection, 'A');
    assert.equal(result[1].selection, 'D');
  });

  it('filters to BET + CONSIDER', () => {
    const result = filterRowsByKaiCall(rows, ['BET', 'CONSIDER']);
    assert.equal(result.length, 3);
    assert.deepEqual(
      result.map((r) => r.selection),
      ['A', 'B', 'D']
    );
  });

  it('accepts single string (not just array)', () => {
    const result = filterRowsByKaiCall(rows, 'BET');
    assert.equal(result.length, 2);
    assert.equal(result[0].selection, 'A');
    assert.equal(result[1].selection, 'D');
  });

  it('handles rows with missing/garbage kaiCall as PASS', () => {
    const result = filterRowsByKaiCall(rows, ['PASS']);
    // C is explicitly PASS, E is garbage (→ PASS), F has no kaiCall (→ PASS)
    assert.equal(result.length, 3);
    assert.deepEqual(result.map((r) => r.selection).sort(), ['C', 'E', 'F']);
  });

  it('returns empty array if no rows match', () => {
    const noBets = [{ kaiCall: 'PASS' }, { kaiCall: 'CONSIDER' }];
    const result = filterRowsByKaiCall(noBets, ['BET']);
    assert.deepEqual(result, []);
  });

  it('handles non-array input gracefully', () => {
    assert.equal(filterRowsByKaiCall(null, ['BET']), null);
    assert.equal(filterRowsByKaiCall(undefined, ['BET']), undefined);
    assert.equal(filterRowsByKaiCall('not array', ['BET']), 'not array');
  });
});

describe('VALID_TIERS export', () => {
  it('contains the three canonical tiers', () => {
    assert.ok(VALID_TIERS.has('BET'));
    assert.ok(VALID_TIERS.has('CONSIDER'));
    assert.ok(VALID_TIERS.has('PASS'));
    assert.equal(VALID_TIERS.size, 3);
  });
});
