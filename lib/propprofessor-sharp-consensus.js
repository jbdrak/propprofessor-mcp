'use strict';

/**
 * Sharp Consensus Multi-Window Analyzer.
 *
 * Segments line history across multiple time windows to detect sustained
 * sharp book movement. Instead of a single lookback verdict, this shows
 * whether Pinnacle, BetOnline, and BookMaker all agree within 1h, 2h, 6h,
 * 12h, 24h, and 48h windows.
 */

const DEFAULT_WINDOWS = [1, 2, 6, 12, 24, 48];
const DEFAULT_SHARP_BOOKS = ['Pinnacle', 'BetOnline', 'BookMaker'];

function getOddsDirection(opening, current) {
  if (opening === null || opening === undefined || current === null || current === undefined) {
    return null;
  }
  // current < opening = supportive (odds moving toward the pick)
  // current === opening = flat (NO movement) → null, NOT 'adverse'.
  // A stationary line is "no signal", not "money against the play". This
  // matches the sibling definition in lib/propprofessor-steam-move.js so the
  // two consensus paths don't disagree. All callers already guard
  // `if (!direction)`, so returning null is safe here.
  if (current === opening) return null;
  return current < opening ? 'supportive' : 'adverse';
}

function getDirectionPct(opening, current) {
  if (!opening || opening === 0) return 0;
  return Math.round((Math.abs(opening - current) / Math.abs(opening)) * 1000) / 10;
}

function segmentWindows(historyPoints, windows, nowMs) {
  const result = {};
  for (const w of windows) {
    const cutoff = nowMs - w * 60 * 60 * 1000;
    const inWindow = historyPoints.filter((h) => (h.time || 0) >= cutoff);
    if (inWindow.length < 2) continue;

    const opening = inWindow[0].odds;
    const current = inWindow[inWindow.length - 1].odds;
    const direction = getOddsDirection(opening, current);
    if (!direction) continue;

    result[`${w}h`] = {
      direction,
      pct: getDirectionPct(opening, current),
      opening,
      current,
      pointCount: inWindow.length
    };
  }
  return result;
}

function analyzeMultiWindow(rows, options = {}) {
  const {
    windows = DEFAULT_WINDOWS,
    sharpBooks = DEFAULT_SHARP_BOOKS,
    nowMs = Date.now(),
    minConsensusWindows = 0,
    includeExecutionBook = false
  } = options;

  const results = [];
  let skippedNoHistory = 0;
  let skippedInsufficientBooks = 0;

  for (const row of rows) {
    const pick = row.participant || '?';
    const homeTeam = row.homeTeam || '?';
    const awayTeam = row.awayTeam || '?';
    const gameId = row.gameId || '';
    const start = row.start || '?';
    const score = Number(row.screenScore || 0) || 0;
    const history =
      Array.isArray(row.filteredLineHistory) && row.filteredLineHistory.length
        ? row.filteredLineHistory
        : Array.isArray(row.lineHistory)
          ? row.lineHistory
          : [];

    if (!history.length) {
      skippedNoHistory += 1;
      continue;
    }

    // Extract execution book odds if requested
    let executionBookOdds = null;
    if (includeExecutionBook && row.selections) {
      for (const key of Object.keys(row.selections)) {
        const sel = row.selections[key];
        const execOdds = sel.odds?.[row.book];
        if (execOdds) {
          executionBookOdds = sel.selection1 === pick ? execOdds.odds1 : execOdds.odds2;
          break;
        }
      }
    }

    // Segment each sharp book's history into windows
    const bookWindows = {};
    for (const sb of sharpBooks) {
      const sbHistory = history.filter((h) => h.book === sb);
      if (sbHistory.length < 2) continue;

      const wr = segmentWindows(sbHistory, windows, nowMs);
      if (Object.keys(wr).length > 0) {
        bookWindows[sb] = wr;
      }
    }

    if (!Object.keys(bookWindows).length) {
      skippedInsufficientBooks += 1;
      continue;
    }

    // Count supportive windows per book
    const bookSupportiveCount = {};
    for (const [sb, wr] of Object.entries(bookWindows)) {
      bookSupportiveCount[sb] = Object.values(wr).filter((w) => w.direction === 'supportive').length;
    }

    // Consensus: which windows have ALL sharp books supportive?
    const consensusWindows = [];
    for (const w of windows) {
      const wk = `${w}h`;
      const allSupportive = Object.keys(bookWindows).every(
        (sb) => bookWindows[sb][wk] && bookWindows[sb][wk].direction === 'supportive'
      );
      if (allSupportive) consensusWindows.push(wk);
    }

    const totalSupportive = Object.values(bookSupportiveCount).reduce((a, b) => a + b, 0);
    const totalWindows = Object.values(bookWindows).reduce((a, b) => a + Object.keys(b).length, 0);

    // Filter by minimum consensus
    if (consensusWindows.length < minConsensusWindows) continue;

    results.push({
      pick,
      gameId,
      game: `${homeTeam} vs ${awayTeam}`,
      start,
      executionBookOdds,
      score,
      bookWindows,
      bookSupportiveCount,
      consensusWindows,
      totalSupportive,
      totalWindows
    });
  }

  // Sort by consensus windows count, then total supportive, then score
  results.sort((a, b) => {
    if (b.consensusWindows.length !== a.consensusWindows.length) {
      return b.consensusWindows.length - a.consensusWindows.length;
    }
    if (b.totalSupportive !== a.totalSupportive) {
      return b.totalSupportive - a.totalSupportive;
    }
    return b.score - a.score;
  });

  return {
    results,
    skippedNoHistory,
    skippedInsufficientBooks,
    totalInputRows: rows.length
  };
}

function summarizeResults(results) {
  return {
    veryStrong: results.filter((r) => r.consensusWindows.length >= 4).length,
    strong: results.filter((r) => r.consensusWindows.length >= 2 && r.consensusWindows.length < 4).length,
    good: results.filter((r) => r.totalSupportive >= 3 && r.consensusWindows.length < 2).length,
    mixed: results.filter((r) => r.totalSupportive >= 1 && r.totalSupportive < 3).length,
    adverse: results.filter((r) => r.totalSupportive === 0).length
  };
}

/**
 * Compute a per-row multi-window consensus score.
 *
 * Score is the fraction of windows (out of DEFAULT_WINDOWS) where ALL configured
 * sharp books moved in the same (supportive) direction. A book is "supportive"
 * for the pick side if its line moved opposite to the pick's value direction
 * (e.g. odds on the pick's opponent shortening = more money on pick).
 *
 * Since the caller doesn't always know which side is the "pick" here, we
 * default to "any directional agreement between sharp books" — this is the
 * raw consensus signal that analyzeMultiWindow already uses. Downstream
 * movement grade logic combines this with movementLabel to assess full support.
 *
 * @param {Object} row - Ranked screen row with lineHistory
 * @param {Object} options
 * @param {number[]} [options.windows] - Time windows in hours
 * @param {string[]} [options.sharpBooks] - Books to require consensus from
 * @param {number} [options.nowMs] - Reference time (default Date.now())
 * @returns {Object} { score, consensusWindowCount, totalWindows, consensusWindows,
 *   confirmedBookCount, requiredBookCount, hasInsufficientData }
 *   - confirmedBookCount: how many of the *present* sharp books agreed in at
 *     least one window. A partial confirmation (2 of 3 books) is NOT full
 *     consensus — consumers should compare against requiredBookCount.
 *   - requiredBookCount: how many configured sharp books actually had history
 *     in this row (the denominator for "all books agreed").
 */
function computeMultiWindowScore(row, options = {}) {
  const windows = options.windows || DEFAULT_WINDOWS;
  const sharpBooks = options.sharpBooks || DEFAULT_SHARP_BOOKS;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

  const history =
    Array.isArray(row?.filteredLineHistory) && row.filteredLineHistory.length
      ? row.filteredLineHistory
      : Array.isArray(row?.lineHistory)
        ? row.lineHistory
        : [];

  if (!history.length) {
    return {
      score: 0.0,
      consensusWindowCount: 0,
      totalWindows: windows.length,
      consensusWindows: [],
      hasInsufficientData: true
    };
  }

  // Group history by sharp book
  const bookHistory = new Map();
  for (const point of history) {
    const book = String(point.book || '').trim();
    if (!sharpBooks.includes(book)) continue;
    const ts = parseTimestampSafe(point);
    if (ts === null) continue;
    if (!bookHistory.has(book)) bookHistory.set(book, []);
    bookHistory.get(book).push({
      odds: Number(point.odds ?? point.price ?? point.current),
      time: ts
    });
  }

  // Need at least 2 sharp books with history to compute consensus
  if (bookHistory.size < 2) {
    return {
      score: 0.0,
      consensusWindowCount: 0,
      totalWindows: windows.length,
      consensusWindows: [],
      confirmedBookCount: 0,
      requiredBookCount: bookHistory.size,
      hasInsufficientData: true
    };
  }

  // For each window, check if all present sharp books agreed on direction
  const consensusWindows = [];
  const confirmedBooks = new Set();
  for (const w of windows) {
    const cutoff = nowMs - w * 60 * 60 * 1000;
    const directions = [];
    for (const [book, points] of bookHistory) {
      const inWindow = points.filter((p) => p.time >= cutoff);
      if (inWindow.length < 2) continue;
      const opening = inWindow[0].odds;
      const current = inWindow[inWindow.length - 1].odds;
      const direction = getOddsDirection(opening, current);
      if (direction) directions.push({ book, direction });
    }
    // Consensus = at least 2 books present AND all agree
    if (directions.length >= 2 && directions.every((d) => d.direction === directions[0].direction)) {
      consensusWindows.push(`${w}h`);
      for (const d of directions) confirmedBooks.add(d.book);
    }
  }

  return {
    score: consensusWindows.length / windows.length,
    consensusWindowCount: consensusWindows.length,
    totalWindows: windows.length,
    consensusWindows,
    confirmedBookCount: confirmedBooks.size,
    requiredBookCount: bookHistory.size,
    hasInsufficientData: false
  };
}

function parseTimestampSafe(point) {
  const value = point.time || point.timestamp || point.t;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

module.exports = {
  DEFAULT_WINDOWS,
  DEFAULT_SHARP_BOOKS,
  getOddsDirection,
  getDirectionPct,
  segmentWindows,
  analyzeMultiWindow,
  computeMultiWindowScore,
  summarizeResults
};
