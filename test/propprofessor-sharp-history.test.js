'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  groupHistoryPointsByBook,
  filterHistoryPoints,
  buildMovementWindows,
  summarizeSharpMovement
} = require('../lib/propprofessor-sharp-history');

describe('propprofessor sharp history helpers', () => {
  it('groups line history by book and sorts by timestamp', () => {
    const grouped = groupHistoryPointsByBook([
      { book: 'Fliff', odds: 120, time: 3 },
      { book: 'NoVigApp', odds: 118, time: 2 },
      { book: 'Fliff', odds: 130, time: 1 },
      { book: 'Fliff', odds: null, time: 4 }
    ]);

    assert.deepEqual(
      grouped.Fliff.map((point) => point.odds),
      [130, 120]
    );
    assert.deepEqual(
      grouped.NoVigApp.map((point) => point.odds),
      [118]
    );
  });

  it('filters out odds outliers and duplicate consecutive same-book points', () => {
    const filtered = filterHistoryPoints([
      { book: 'Polymarket', odds: -9900, time: 1 },
      { book: 'Pinnacle', odds: -120, time: 2 },
      { book: 'Pinnacle', odds: -120, time: 3 },
      { book: 'Pinnacle', odds: -112, time: 4 },
      { book: 'Circa', odds: 5000, time: 5 },
      { book: 'Circa', odds: 145, time: 6 }
    ]);

    assert.deepEqual(
      filtered.keptPoints.map((point) => [point.book, point.odds]),
      [
        ['Pinnacle', -120],
        ['Pinnacle', -112],
        ['Circa', 145]
      ]
    );
    assert.equal(filtered.droppedCount, 3);
    assert.equal(filtered.dropReasons.outlier_odds, 2);
    assert.equal(filtered.dropReasons.duplicate_consecutive, 1);
  });

  it('builds a recent window from same-book time series', () => {
    const nowMs = Date.UTC(2026, 4, 6, 12, 0, 0);
    const windows = buildMovementWindows(
      [
        { book: 'Pinnacle', odds: 125, time: nowMs - 8 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: 140, time: nowMs - 4 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: 132, time: nowMs - 60 * 60 * 1000 }
      ],
      { nowMs, recentWindowHours: 6 }
    );

    assert.equal(windows.fullWindow.direction, 'adverse');
    assert.equal(windows.recentWindow.direction, 'supportive');
    assert.equal(windows.recentWindow.pointCount, 2);
  });

  it('summarizes same-book sharp movement with recent-supportive-only labeling', () => {
    const nowMs = Date.UTC(2026, 4, 6, 12, 0, 0);
    const summary = summarizeSharpMovement({
      lineHistory: [
        { book: 'Pinnacle', odds: 125, time: nowMs - 8 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: 140, time: nowMs - 4 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: 132, time: nowMs - 60 * 60 * 1000 },
        { book: 'Polymarket', odds: -9999, time: nowMs - 30 * 60 * 1000 }
      ],
      preferredBook: 'NoVigApp',
      sharpBooks: ['Pinnacle', 'Polymarket', 'Kalshi'],
      options: { nowMs, recentWindowHours: 6 }
    });

    assert.equal(summary.movementSourceBook, 'Pinnacle');
    assert.equal(summary.movementMode, 'comparison_book');
    assert.equal(summary.movementLabel, 'recent_supportive_only');
    assert.equal(summary.lineHistoryUsable, true);
    assert.equal(summary.movementQuality, 'low');
    assert.equal(summary.droppedHistoryPointCount, 1);
    assert.equal(typeof summary.clvProxyPct, 'number');
    assert.equal(typeof summary.recentClvPct, 'number');
  });

  it('prefers the named book history over sharp comparison history', () => {
    const summary = summarizeSharpMovement({
      lineHistory: [
        { book: 'OnyxOdds', odds: 110, time: 1 },
        { book: 'OnyxOdds', odds: 120, time: 2 },
        { book: 'Pinnacle', odds: -108, time: 1 },
        { book: 'Pinnacle', odds: -120, time: 2 }
      ],
      preferredBook: 'OnyxOdds',
      sharpBooks: ['Pinnacle', '4cx'],
      options: { recentWindowHours: 6 }
    });

    assert.equal(summary.movementMode, 'same_book');
    assert.equal(summary.movementSourceBook, 'OnyxOdds');
  });

  it('downgrades comparison movement when the named book has no history', () => {
    const summary = summarizeSharpMovement({
      lineHistory: [
        { book: 'Pinnacle', odds: -108, time: 1 },
        { book: 'Pinnacle', odds: -120, time: 2 }
      ],
      preferredBook: 'OnyxOdds',
      sharpBooks: ['Pinnacle'],
      options: { recentWindowHours: 6 }
    });

    assert.notEqual(summary.movementMode, 'same_book');
    assert.equal(summary.movementSourceBook, 'Pinnacle');
    assert.notEqual(summary.movementQuality, 'high');
  });

  it('preserves broad sharp-book movement without a named book context', () => {
    const summary = summarizeSharpMovement({
      lineHistory: [
        { book: 'Pinnacle', odds: -108, time: 1 },
        { book: 'Pinnacle', odds: -120, time: 2 }
      ],
      sharpBooks: ['Pinnacle'],
      options: { recentWindowHours: 6 }
    });

    assert.equal(summary.movementMode, 'same_book');
    assert.equal(summary.movementSourceBook, 'Pinnacle');
  });

  it('retains mixed-book fallback when no named trail is usable', () => {
    const summary = summarizeSharpMovement({
      lineHistory: [
        { book: 'Pinnacle', odds: -120, time: 1 },
        { book: 'Circa', odds: -118, time: 2 },
        { book: 'BetOnline', odds: -112, time: 3 }
      ],
      preferredBook: 'NoVigApp',
      sharpBooks: ['Pinnacle', 'Circa', 'BetOnline'],
      options: { recentWindowHours: 6 }
    });

    assert.equal(summary.movementMode, 'mixed_books_fallback');
    assert.equal(summary.movementQuality, 'low');
    assert.equal(summary.lineHistoryUsable, true);
  });

  it('falls back to mixed-book movement when no same-book trail is usable', () => {
    const summary = summarizeSharpMovement({
      lineHistory: [
        { book: 'Pinnacle', odds: -120, time: 1 },
        { book: 'Circa', odds: -118, time: 2 },
        { book: 'BetOnline', odds: -112, time: 3 }
      ],
      preferredBook: 'NoVigApp',
      sharpBooks: ['Pinnacle', 'Circa', 'BetOnline'],
      options: { recentWindowHours: 6 }
    });

    assert.equal(summary.movementMode, 'mixed_books_fallback');
    assert.equal(summary.movementQuality, 'low');
    assert.equal(summary.lineHistoryUsable, true);
  });

  it('flags V-shaped recovery where endpoints positive but midline adverse', () => {
    const nowMs = Date.UTC(2026, 4, 7, 12, 0, 0);
    const windows = buildMovementWindows(
      [
        { book: 'Pinnacle', odds: -222, time: nowMs - 25 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: -210, time: nowMs - 20 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: -205, time: nowMs - 18 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: -202, time: nowMs - 15 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: -192, time: nowMs - 14 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: -186, time: nowMs - 13 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: -190, time: nowMs - 12 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: -200, time: nowMs - 6 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: -215, time: nowMs - 3 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: -229, time: nowMs - 1 * 60 * 60 * 1000 }
      ],
      { nowMs, recentWindowHours: 6 }
    );

    assert.ok(windows.fullWindow.clvPct > 0, `Expected positive CLV, got ${windows.fullWindow.clvPct}`);
    assert.ok(windows.fullWindow.minClvPct < -2, `Expected minClvPct < -2, got ${windows.fullWindow.minClvPct}`);
    assert.ok(
      windows.fullWindow.minClvPct < windows.fullWindow.clvPct,
      `minClvPct (${windows.fullWindow.minClvPct}) should be < clvPct (${windows.fullWindow.clvPct})`
    );
  });

  it('passes minClvPct through summarizeSharpMovement', () => {
    const nowMs = Date.UTC(2026, 4, 7, 12, 0, 0);
    const summary = summarizeSharpMovement({
      lineHistory: [
        { book: 'Pinnacle', odds: -222, time: nowMs - 25 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: -186, time: nowMs - 13 * 60 * 60 * 1000 },
        { book: 'Pinnacle', odds: -229, time: nowMs - 1 * 60 * 60 * 1000 }
      ],
      preferredBook: 'NoVigApp',
      sharpBooks: ['Pinnacle', 'Circa'],
      options: { nowMs, recentWindowHours: 6 }
    });

    assert.ok(typeof summary.minClvPct === 'number', `Expected minClvPct to be a number, got ${summary.minClvPct}`);
    assert.ok(
      typeof summary.peakAdverseClvPct === 'number',
      `Expected peakAdverseClvPct to be a number, got ${summary.peakAdverseClvPct}`
    );
    assert.ok(
      summary.minClvPct < summary.clvProxyPct,
      `minClvPct (${summary.minClvPct}) should be < clvProxyPct (${summary.clvProxyPct})`
    );
  });
});
