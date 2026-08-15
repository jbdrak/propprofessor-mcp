'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { formatScanDiagnostics } = require('../lib/scan-diagnostics');

describe('formatScanDiagnostics', () => {
  it('returns empty lines for a clean scan', () => {
    const lines = formatScanDiagnostics({
      mixedScan: false,
      tennisFallbackApplied: false,
      emptySlate: [],
      scanHealth: null
    });
    assert.deepEqual(lines, []);
  });

  it('mentions truncated leagues with skipped row counts', () => {
    const lines = formatScanDiagnostics({
      mixedScan: true,
      tennisFallbackApplied: false,
      emptySlate: [],
      scanHealth: {
        truncated: true,
        incomplete: true,
        preHistoryShortlist: [
          { league: 'MLB', market: 'Moneyline', truncated: true, skippedRowCount: 12 },
          { league: 'MLB', market: 'Run Line', truncated: false }
        ]
      }
    });
    assert.ok(
      lines.some((l) => /truncated/i.test(l)),
      'should mention truncation'
    );
    assert.ok(
      lines.some((l) => /MLB/.test(l)),
      'should name the truncated league'
    );
    assert.ok(
      lines.some((l) => /not hydrated|incomplete/i.test(l)),
      'should explain rows were not hydrated'
    );
  });

  it('lists empty league/market pairs, capped at 12', () => {
    const emptySlate = Array.from({ length: 15 }, (_, i) => ({
      league: `League${i}`,
      market: 'Moneyline',
      reason: 'no_ranked_rows_scanned'
    }));
    const lines = formatScanDiagnostics({
      mixedScan: true,
      tennisFallbackApplied: false,
      emptySlate,
      scanHealth: null
    });
    assert.ok(
      lines.some((l) => /League0/.test(l)),
      'should list an empty pair'
    );
    assert.ok(
      lines.some((l) => /no_ranked_rows_scanned/.test(l)),
      'should include the reason'
    );
    assert.ok(
      lines.some((l) => /3 more/.test(l)),
      'should report the capped remainder'
    );
  });

  it('warns when a mixed scan was filled by tennis fallback', () => {
    const lines = formatScanDiagnostics({
      mixedScan: true,
      tennisFallbackApplied: true,
      emptySlate: [],
      scanHealth: null
    });
    assert.ok(
      lines.some((l) => /tennis fallback/i.test(l) && /mixed/i.test(l)),
      'should warn that tennis fallback filled a mixed scan'
    );
  });

  it('does not warn about tennis fallback on a tennis-only scan', () => {
    const lines = formatScanDiagnostics({
      mixedScan: false,
      tennisFallbackApplied: true,
      emptySlate: [],
      scanHealth: null
    });
    assert.equal(lines.length, 0, 'tennis-only fallback is expected behavior, not a warning');
  });

  it('adds a pp rank recovery hint when validation budget was exhausted', () => {
    const lines = formatScanDiagnostics({
      mixedScan: true,
      tennisFallbackApplied: false,
      emptySlate: [],
      scanHealth: { validationBudgetExhausted: true, league: 'MLB' }
    });
    assert.ok(
      lines.some((l) => /pp rank MLB/.test(l)),
      'should suggest a focused scan'
    );
  });

  it('flags candidates found but downgraded by fresh validation (stale labels)', () => {
    const lines = formatScanDiagnostics({
      mixedScan: true,
      tennisFallbackApplied: false,
      emptySlate: [],
      playCount: 0,
      scanHealth: {
        truncated: true,
        incomplete: true,
        validation: { eligible: 16, selected: 10, completedCount: 10 },
        preHistoryShortlist: [{ league: 'ufc', market: 'Moneyline', truncated: true }]
      }
    });
    assert.ok(
      lines.some((l) => /16 BET candidate/.test(l) && /stale scan labels/.test(l)),
      'should report the eligible candidates that failed fresh validation'
    );
    assert.ok(
      lines.some((l) => /pp rank ufc/.test(l)),
      'should suggest a focused re-scan'
    );
  });

  it('does not flag candidates when plays survived the scan', () => {
    const lines = formatScanDiagnostics({
      mixedScan: true,
      tennisFallbackApplied: false,
      emptySlate: [],
      playCount: 3,
      scanHealth: { validation: { eligible: 16, selected: 10, completedCount: 10 } }
    });
    assert.ok(
      !lines.some((l) => /BET candidate/.test(l)),
      'no staleness warning when plays are present'
    );
  });
});
