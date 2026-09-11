'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveScanLimit } = require('../lib/ssb-scan-limit');

test('multi-league BET-only scans keep the default hydration limit', () => {
  assert.equal(
    resolveScanLimit({ onlyBets: true, singleLeagueScan: false, ncaafOnly: false, deepScan: false, limit: 50 }),
    24
  );
});

test('deep mode raises only the multi-league BET-only limit to 100', () => {
  assert.equal(
    resolveScanLimit({ onlyBets: true, singleLeagueScan: false, ncaafOnly: false, deepScan: true, limit: 200 }),
    100
  );
  assert.equal(
    resolveScanLimit({ onlyBets: true, singleLeagueScan: false, ncaafOnly: false, deepScan: true, limit: 60 }),
    60
  );
});

test('single-league BET-only scans are unchanged with or without deep mode', () => {
  const base = { onlyBets: true, singleLeagueScan: true, ncaafOnly: false, limit: 150 };
  assert.equal(resolveScanLimit({ ...base, deepScan: false }), 100);
  assert.equal(resolveScanLimit({ ...base, deepScan: true }), 100);
});

test('NCAAF-only scans remain capped at 80', () => {
  const base = { onlyBets: true, singleLeagueScan: true, ncaafOnly: true, limit: 150 };
  assert.equal(resolveScanLimit({ ...base, deepScan: false }), 80);
  assert.equal(resolveScanLimit({ ...base, deepScan: true }), 80);
});

test('non-BET-only scans remain capped at 50', () => {
  const base = { onlyBets: false, singleLeagueScan: false, ncaafOnly: false, limit: 150 };
  assert.equal(resolveScanLimit({ ...base, deepScan: false }), 50);
  assert.equal(resolveScanLimit({ ...base, deepScan: true }), 50);
});
