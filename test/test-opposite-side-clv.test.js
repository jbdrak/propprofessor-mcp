'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { summarizeSharpMovement } = require('../lib/propprofessor-sharp-history');

describe('Opposite-side CLV inversion', () => {
  it('should flag Oleksiejczuk CLV as inverted when computed from Magomedov odds', () => {
    // Simulated: sharps hit Oleksiejczuk. Magomedov went from favorite to dog.
    // Magomedov opened -105 (51.2% implied) → now +101 (49.75% implied) on 4cx.
    // For Magomedov: CLV ≈ -1.47%, direction = adverse. Correct for Magomedov.
    // For Oleksiejczuk (opposite side): CLV should be positive, direction = supportive.
    // Without the flip: gets negative → adverse → wrongly PASS.

    const lineHistory = [
      { odds: -105, book: '4cx', time: 1782551782005, liquidity: 28 },
      { odds: -102, book: '4cx', time: 1782551889460, liquidity: 16320 },
      { odds: -101, book: '4cx', time: 1782551891017, liquidity: 27 },
      { odds: +100, book: '4cx', time: 1782555487674, liquidity: 107 },
      { odds: +101, book: '4cx', time: 1782555493583, liquidity: 26 }
    ];

    // Magomedov side (default — no invert)
    const magomedovResult = summarizeSharpMovement({
      lineHistory,
      preferredBook: 'NoVigApp',
      sharpBooks: ['4cx', 'Circa', 'NoVigApp']
    });

    // Magomedov should have negative CLV (his odds got worse)
    assert.strictEqual(typeof magomedovResult.openToCurrentClvPct, 'number');
    assert.ok(magomedovResult.openToCurrentClvPct < 0, 'Magomedov CLV should be negative');
    assert.strictEqual(
      magomedovResult.fullWindowSharpMoveDirection,
      'adverse',
      'Magomedov direction should be adverse'
    );

    // Oleksiejczuk side (invertDirection = true)
    const oleksiejczukResult = summarizeSharpMovement({
      lineHistory,
      preferredBook: 'NoVigApp',
      sharpBooks: ['4cx', 'Circa', 'NoVigApp'],
      options: { invertDirection: true }
    });

    // Oleksiejczuk should have POSITIVE CLV — sharps moved the line toward him
    assert.strictEqual(typeof oleksiejczukResult.openToCurrentClvPct, 'number');
    assert.ok(oleksiejczukResult.openToCurrentClvPct > 0, 'Oleksiejczuk CLV should be positive when inverted');
    assert.strictEqual(
      oleksiejczukResult.fullWindowSharpMoveDirection,
      'supportive',
      'Oleksiejczuk direction should be supportive when inverted'
    );

    // Movement label should be supportive for Oleksiejczuk
    assert.strictEqual(
      oleksiejczukResult.movementLabel,
      'supportive',
      'Movement label should be supportive for Oleksiejczuk'
    );

    // CLV magnitudes should be near-mirrors (within rounding tolerance of juice spread)
    assert.ok(
      Math.abs(magomedovResult.openToCurrentClvPct + oleksiejczukResult.openToCurrentClvPct) < 0.2,
      `CLV should be near-mirror: Magomedov=${magomedovResult.openToCurrentClvPct}, Oleksiejczuk=${oleksiejczukResult.openToCurrentClvPct}`
    );
  });

  it('should leave non-inverted direction unchanged', () => {
    // When invertDirection is not set, behavior is unchanged
    const lineHistory = [
      { odds: -120, book: '4cx', time: 1782551782005 },
      { odds: -110, book: '4cx', time: 1782555493583 }
    ];

    const result = summarizeSharpMovement({
      lineHistory,
      preferredBook: 'NoVigApp',
      sharpBooks: ['4cx']
    });

    // -120 (54.5%) → -110 (52.4%) = CLV ≈ -2.16%, direction = adverse
    assert.ok(result.openToCurrentClvPct < 0, 'Non-inverted negative CLV preserved');
    assert.strictEqual(result.fullWindowSharpMoveDirection, 'adverse', 'Non-inverted adverse direction preserved');
  });

  it('should handle insufficient_history gracefully with invert', () => {
    // Single point = insufficient history. Invert flag should not crash.
    const lineHistory = [{ odds: -110, book: '4cx', time: 1782551782005 }];

    const result = summarizeSharpMovement({
      lineHistory,
      preferredBook: 'NoVigApp',
      sharpBooks: ['4cx'],
      options: { invertDirection: true }
    });

    assert.strictEqual(result.movementLabel, 'insufficient_history');
    assert.strictEqual(result.fullWindowSharpMoveDirection, 'insufficient_history');
    assert.strictEqual(result.openToCurrentClvPct, null);
    assert.strictEqual(result.lineHistoryUsable, false);
  });

  it('should invert both CLV values and direction labels', () => {
    // Supportive move: odds improved from +110 → -105
    const lineHistory = [
      { odds: +110, book: '4cx', time: 1782551782005 },
      { odds: -105, book: '4cx', time: 1782555493583 }
    ];
    // Anchor nowMs to the end of the synthetic history so the 6h recent
    // window is relative to the data, not wall-clock. (Previously the code
    // defaulted nowMs to the last history point's timestamp, which masked
    // window-staleness bugs; buildMovementWindows now anchors to real time,
    // so tests must pin nowMs explicitly to stay deterministic.)
    const nowMs = 1782555493583 + 60 * 60 * 1000;

    // Default (supportive)
    const normal = summarizeSharpMovement({
      lineHistory,
      preferredBook: 'NoVigApp',
      sharpBooks: ['4cx'],
      options: { nowMs }
    });
    assert.ok(normal.openToCurrentClvPct > 0, 'Normal CLV should be positive');
    assert.strictEqual(normal.fullWindowSharpMoveDirection, 'supportive');
    assert.strictEqual(normal.recentSharpMoveDirection, 'supportive');

    // Inverted (should become adverse)
    const inverted = summarizeSharpMovement({
      lineHistory,
      preferredBook: 'NoVigApp',
      sharpBooks: ['4cx'],
      options: { invertDirection: true, nowMs }
    });
    assert.ok(inverted.openToCurrentClvPct < 0, 'Inverted CLV should be negative');
    assert.strictEqual(inverted.fullWindowSharpMoveDirection, 'adverse');
    assert.strictEqual(inverted.recentSharpMoveDirection, 'adverse');
    assert.strictEqual(inverted.movementLabel, 'adverse');

    // Recent CLV should also be inverted
    assert.ok(inverted.recentClvPct < 0, 'Recent CLV should also be inverted');
  });
});
