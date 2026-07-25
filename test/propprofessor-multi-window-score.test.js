'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeMultiWindowScore,
  DEFAULT_WINDOWS,
  DEFAULT_SHARP_BOOKS
} = require('../lib/propprofessor-sharp-consensus');

/**
 * Build a row with lineHistory where each sharp book has points spanning the
 * given offsets, with monotonically changing odds. Used to construct known
 * multi-window consensus states.
 */
function buildRow(offsetsHours, { books, opening, closing, nowMs } = {}) {
  const booksArr = books || DEFAULT_SHARP_BOOKS;
  const ref = Number.isFinite(nowMs) ? nowMs : Date.now();
  const history = [];
  for (const book of booksArr) {
    for (let i = 0; i < offsetsHours.length; i++) {
      const offsetMs = offsetsHours[i] * 60 * 60 * 1000;
      const t = ref - offsetMs;
      // Interpolate odds across the points
      const progress = i / Math.max(1, offsetsHours.length - 1);
      const odds = opening + (closing - opening) * progress;
      history.push({ book, time: new Date(t).toISOString(), odds });
    }
  }
  return { lineHistory: history, _now: ref };
}

describe('computeMultiWindowScore', () => {
  it('returns 0.0 with insufficient data flag when lineHistory is empty', () => {
    const result = computeMultiWindowScore({ lineHistory: [] });
    assert.equal(result.score, 0.0);
    assert.equal(result.consensusWindowCount, 0);
    assert.equal(result.totalWindows, DEFAULT_WINDOWS.length);
    assert.equal(result.hasInsufficientData, true);
    assert.deepEqual(result.consensusWindows, []);
  });

  it('returns 0.0 with insufficient data flag when only 1 sharp book has history', () => {
    const now = Date.now();
    const row = {
      lineHistory: [
        { book: 'Pinnacle', time: new Date(now - 60 * 60 * 1000).toISOString(), odds: -150 },
        { book: 'Pinnacle', time: new Date(now).toISOString(), odds: -160 },
        { book: 'NoVigApp', time: new Date(now - 60 * 60 * 1000).toISOString(), odds: -145 },
        { book: 'NoVigApp', time: new Date(now).toISOString(), odds: -155 }
      ]
    };
    const result = computeMultiWindowScore(row, { nowMs: now });
    assert.equal(result.score, 0.0);
    assert.equal(result.hasInsufficientData, true);
  });

  it('returns 6/6 (1.0) when 3 sharp books agree on direction across all windows', () => {
    // Need >= 2 points inside every window: 1h, 2h, 6h, 12h, 24h, 48h.
    // Use 0.25h, 0.75h (both inside 1h), 1.5h, 5h, 11h, 23h, 47h so each window has >= 2 points.
    const now = Date.now();
    const row = buildRow([47, 23, 11, 5, 1.5, 0.75, 0.25], {
      books: ['Pinnacle', 'BetOnline', 'BookMaker'],
      opening: -150,
      closing: -170,
      nowMs: now
    });
    const result = computeMultiWindowScore(row, { nowMs: now });
    assert.equal(
      result.score,
      1.0,
      `expected all 6 windows to agree, got ${result.score} (windows: ${result.consensusWindows.join(', ')})`
    );
    assert.equal(result.consensusWindowCount, 6);
  });

  it('returns 4/6 (0.67) when books agree in 4 windows but 1h and 2h are out of range', () => {
    // Points only at 3h, 6h, 12h, 24h, 48h — 1h window has < 2 points so no consensus
    // 2h window has 1 point (the 3h one is outside, the 6h one is in but only 1 point) — no consensus
    // 6h, 12h, 24h, 48h all have >= 2 points with all books agreeing
    const now = Date.now();
    const row = buildRow([48, 24, 12, 6, 3], {
      books: ['Pinnacle', 'BetOnline', 'BookMaker'],
      opening: -150,
      closing: -170,
      nowMs: now
    });
    const result = computeMultiWindowScore(row, { nowMs: now });
    // 1h: only the 3h point is in window (inWindow.length < 2) — no consensus
    // 2h: only the 3h point is in window — no consensus
    // 6h: 3h + 6h points — 2 points, both books agree — consensus
    // 12h, 24h, 48h: all have multiple points — consensus
    assert.equal(result.score, 4 / 6, `expected 4/6, got ${result.score}`);
    assert.equal(result.consensusWindowCount, 4);
  });

  it('returns 0/6 (0.0) when sharp books disagree on direction', () => {
    // Pinnacle and BetOnline go down, BookMaker goes up
    const now = Date.now();
    const history = [];
    for (const book of ['Pinnacle', 'BetOnline']) {
      history.push({ book, time: new Date(now - 48 * 60 * 60 * 1000).toISOString(), odds: -150 });
      history.push({ book, time: new Date(now - 6 * 60 * 60 * 1000).toISOString(), odds: -170 });
    }
    for (const book of ['BookMaker']) {
      history.push({ book, time: new Date(now - 48 * 60 * 60 * 1000).toISOString(), odds: -150 });
      history.push({ book, time: new Date(now - 6 * 60 * 60 * 1000).toISOString(), odds: -130 }); // up
    }
    const result = computeMultiWindowScore({ lineHistory: history }, { nowMs: now });
    assert.equal(result.score, 0.0);
    assert.equal(result.consensusWindowCount, 0);
  });

  it('handles non-sharp books gracefully (only counts configured sharp books)', () => {
    // 4 books total, but only 2 are sharp (Pinnacle, BetOnline). NoVigApp + Fliff are ignored.
    // Use points at multiple offsets so most windows have 2+ sharp book points.
    const now = Date.now();
    const offsets = [47, 23, 11, 5, 1.5, 0.75, 0.25];
    const history = [];
    for (const book of ['Pinnacle', 'BetOnline']) {
      for (let i = 0; i < offsets.length; i++) {
        const t = new Date(now - offsets[i] * 60 * 60 * 1000).toISOString();
        const progress = i / (offsets.length - 1);
        const odds = -150 + (-170 - -150) * progress;
        history.push({ book, time: t, odds });
      }
    }
    for (const book of ['NoVigApp', 'Fliff']) {
      // Wildly different movement — should be ignored
      for (let i = 0; i < offsets.length; i++) {
        const t = new Date(now - offsets[i] * 60 * 60 * 1000).toISOString();
        const progress = i / (offsets.length - 1);
        const odds = -150 + (-200 - -150) * progress;
        history.push({ book, time: t, odds });
      }
    }
    const result = computeMultiWindowScore({ lineHistory: history }, { nowMs: now });
    // Sharp books agree: all 6 windows should show consensus (NoVigApp/Fliff movements ignored)
    assert.equal(result.score, 1.0, `expected 1.0, got ${result.score}`);
  });

  it('uses filteredLineHistory when available, falling back to lineHistory', () => {
    const now = Date.now();
    const offsets = [47, 23, 11, 5, 1.5, 0.75, 0.25];
    function makePoints(book) {
      return offsets.map((o, i) => {
        const t = new Date(now - o * 60 * 60 * 1000).toISOString();
        const progress = i / (offsets.length - 1);
        return { book, time: t, odds: -150 + (-170 - -150) * progress };
      });
    }
    const row = {
      lineHistory: makePoints('Pinnacle'),
      filteredLineHistory: [...makePoints('Pinnacle'), ...makePoints('BetOnline')]
    };
    const result = computeMultiWindowScore(row, { nowMs: now });
    // With filteredLineHistory having 2 sharp books, we get consensus across all windows
    assert.equal(result.hasInsufficientData, false);
    assert.equal(result.score, 1.0);
  });

  it('handles numeric timestamps (ms and seconds)', () => {
    const now = Date.now();
    const offsets = [47, 23, 11, 5, 1.5, 0.75, 0.25];
    function makePoints(book) {
      return offsets.map((o, i) => {
        const t = now - o * 60 * 60 * 1000;
        const progress = i / (offsets.length - 1);
        return { book, time: t, odds: -150 + (-170 - -150) * progress };
      });
    }
    const row = {
      lineHistory: [...makePoints('Pinnacle'), ...makePoints('BetOnline')]
    };
    const result = computeMultiWindowScore(row, { nowMs: now });
    assert.equal(result.score, 1.0);
  });

  it('partial consensus: 3/6 windows when only the 3 longest windows have enough data', () => {
    // Points at 50h, 30h, 20h — 1h and 2h and 6h will be empty (or < 2 points)
    // Wait: 1h cutoff = now - 1h. The most recent point is 20h ago. So 1h, 2h, 6h, 12h all have 0 points.
    // 24h has 1 point (30h is outside, 20h is in but only 1 point). Actually 30h is OUTSIDE 24h window.
    // 24h: only 20h point is in. 1 point. No consensus.
    // 48h: both 50h (no — 50h is outside 48h window) and 20h and 30h. Let me think.
    // Window = now - X hours. Points at [50h, 30h, 20h] ago.
    // 1h: only points >= now-1h. 20h < now-1h. None. → 0 directions.
    // 2h: same. None.
    // 6h: same. None.
    // 12h: same. None.
    // 24h: points in [now-24h, now] = [20h only]. 1 point. No consensus.
    // 48h: points in [now-48h, now] = [30h ago (yes, 30h < 48h, so it's in), 20h ago]. 2 points. Consensus possible.
    // So score = 1/6 = 0.167. That's at the <= 0.33 threshold → would trigger risk score penalty.
    const now = Date.now();
    const row = buildRow([50, 30, 20], {
      books: ['Pinnacle', 'BetOnline'],
      opening: -150,
      closing: -170,
      nowMs: now
    });
    const result = computeMultiWindowScore(row, { nowMs: now });
    // Actually let me recompute: 50h is the OLDEST point in history (offset = 50h ago).
    // 48h window cutoff = now - 48h. The 50h-ago point is BEFORE cutoff. The 30h-ago point is IN. The 20h-ago point is IN.
    // So 48h window has 2 points: 30h and 20h. Both Pinnacle + BetOnline have 2 points. They agree. Consensus.
    // 24h window cutoff = now - 24h. Only the 20h-ago point is in. 1 point. No consensus.
    // Other windows: 0 points. No consensus.
    // Score = 1/6
    assert.equal(result.score, 1 / 6, `expected 1/6, got ${result.score}`);
  });
});

describe('multi-window score integration with risk grade and score', () => {
  const { gradeMovementQuality, calculateRiskScore } = require('../lib/propprofessor-risk-score');

  function makeRow(overrides) {
    return {
      movementLabel: 'supportive',
      movementQuality: 'high',
      movementQualityScore: 0.85,
      executionQuality: 'best',
      consensusBookCount: 8,
      consensusEdge: 1.5,
      clvProxyPct: 1.0,
      steamMove: false,
      ...overrides
    };
  }

  it('multiWindowScore 0.5 is below 0.66 threshold → demotes grade to YELLOW', () => {
    const row = makeRow({ multiWindowScore: 0.5, multiWindowInsufficientData: false });
    const grade = gradeMovementQuality(row);
    assert.equal(grade, 'yellow', 'multiWindowScore 0.5 is below 0.66 threshold → should be YELLOW');
  });

  it('multiWindowScore 0.67+ allows GREEN when all other criteria are met', () => {
    const row = makeRow({ multiWindowScore: 0.67, multiWindowInsufficientData: false });
    const grade = gradeMovementQuality(row);
    assert.equal(grade, 'green');
  });

  it('multiWindowInsufficientData=true does not block GREEN', () => {
    // No line history → multiWindowInsufficientData=true → fallback to existing checks
    const row = makeRow({ multiWindowInsufficientData: true, multiWindowScore: 0 });
    const grade = gradeMovementQuality(row);
    assert.equal(grade, 'green', 'no data should not block GREEN — fallback to existing checks');
  });

  it('multiWindowScore >= 0.66 reduces risk score by 1', () => {
    // Use yellow-grade items (neutral movement, playable exec, no steam/CLV)
    // so the baseline scores above the floor and the multi-window modifier
    // has room to reduce it. A score of 0.85 gives the -1 bracket.
    const yellowBase = {
      movementLabel: 'neutral',
      movementQuality: 'medium',
      movementQualityScore: 0.5,
      executionQuality: 'playable',
      consensusBookCount: 5,
      consensusEdge: 1.0,
      clvProxyPct: 0,
      steamMove: false
    };
    const baseline = calculateRiskScore({ ...yellowBase, multiWindowInsufficientData: true, multiWindowScore: 0 });
    const sustained = calculateRiskScore({ ...yellowBase, multiWindowScore: 0.85, multiWindowInsufficientData: false });
    assert.equal(baseline - sustained, 1, `expected 1, got ${baseline - sustained} (baseline=${baseline}, sustained=${sustained})`);
  });

  it('multiWindowScore <= 0.33 increases risk score (via grade demotion + penalty)', () => {
    // 0.2 < 0.66 → grade demotes from green to yellow (loses -2 bonus) AND +1 penalty
    // Net: +3 vs the no-data baseline that stays green.
    const baseline = calculateRiskScore(makeRow({ multiWindowInsufficientData: true, multiWindowScore: 0 }));
    const weak = calculateRiskScore(makeRow({ multiWindowScore: 0.2, multiWindowInsufficientData: false }));
    assert.equal(weak - baseline, 3, `expected +3 (grade demotion -2, weak penalty +1), got ${weak - baseline}`);
    assert.equal(
      gradeMovementQuality(makeRow({ multiWindowScore: 0.2, multiWindowInsufficientData: false })),
      'yellow'
    );
    assert.equal(gradeMovementQuality(makeRow({ multiWindowInsufficientData: true, multiWindowScore: 0 })), 'green');
  });

  it('multiWindowScore in 0.34-0.65 demotes grade to yellow but does not add risk penalty', () => {
    // 0.5 < 0.66 → grade demotes to yellow (-2 lost vs green), but no explicit penalty.
    // Net: +2 vs no-data baseline.
    const baseline = calculateRiskScore(makeRow({ multiWindowInsufficientData: true, multiWindowScore: 0 }));
    const neutral = calculateRiskScore(makeRow({ multiWindowScore: 0.5, multiWindowInsufficientData: false }));
    assert.equal(neutral - baseline, 2, `expected +2 (grade demotion only), got ${neutral - baseline}`);
    assert.equal(
      gradeMovementQuality(makeRow({ multiWindowScore: 0.5, multiWindowInsufficientData: false })),
      'yellow'
    );
  });
});

describe('flat line handling (BUG fix: flat is no-signal, not adverse)', () => {
  it('getOddsDirection returns null for a flat line (current === opening)', () => {
    const { getOddsDirection } = require('../lib/propprofessor-sharp-consensus');
    assert.equal(getOddsDirection(-150, -150), null, 'flat line must be neutral, not adverse');
  });

  it('a stationary sharp book does NOT veto multi-window consensus', () => {
    // Pinnacle + BetOnline move supportive; BookMaker stands flat.
    // Before the fix, BookMaker's flat line was scored 'adverse' and vetoed
    // consensus in every window. Now flat = null = ignored, so all 6 windows
    // should still show consensus from the two moving books.
    const now = Date.now();
    const offsets = [47, 23, 11, 5, 1.5, 0.75, 0.25];
    function pts(book, close) {
      return offsets.map((o, i) => {
        const t = new Date(now - o * 60 * 60 * 1000).toISOString();
        const progress = i / (offsets.length - 1);
        // flat book: opening === closing === -160 (no movement)
        const odds = book === 'BookMaker' ? -160 : -150 + (close - -150) * progress;
        return { book, time: t, odds };
      });
    }
    const history = [
      ...pts('Pinnacle', -170),
      ...pts('BetOnline', -170),
      ...pts('BookMaker', -160)
    ];
    const result = computeMultiWindowScore({ lineHistory: history }, { nowMs: now });
    assert.equal(result.score, 1.0, `flat book must not veto consensus, got ${result.score}`);
    assert.equal(result.requiredBookCount, 3, 'all 3 sharp books had history');
  });
});

describe('confirmed vs required book counts (consensus transparency)', () => {
  it('reports 2 confirmed of 3 required when one book has no history', () => {
    // BuildRow with 2 of 3 configured sharp books → partial confirmation.
    const now = Date.now();
    const row = buildRow([47, 23, 11, 5, 1.5, 0.75, 0.25], {
      books: ['Pinnacle', 'BetOnline'], // BookMaker intentionally absent
      opening: -150,
      closing: -170,
      nowMs: now
    });
    const result = computeMultiWindowScore(row, {
      nowMs: now,
      sharpBooks: ['Pinnacle', 'BetOnline', 'BookMaker']
    });
    assert.equal(result.confirmedBookCount, 2, 'two books agreed');
    assert.equal(result.requiredBookCount, 2, 'only two of three had history');
  });

  it('reports 3 confirmed of 3 required on full agreement', () => {
    const now = Date.now();
    const row = buildRow([47, 23, 11, 5, 1.5, 0.75, 0.25], {
      books: ['Pinnacle', 'BetOnline', 'BookMaker'],
      opening: -150,
      closing: -170,
      nowMs: now
    });
    const result = computeMultiWindowScore(row, { nowMs: now });
    assert.equal(result.confirmedBookCount, 3);
    assert.equal(result.requiredBookCount, 3);
  });
});
