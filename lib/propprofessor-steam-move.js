'use strict';

/**
 * Steam Move Detector
 *
 * Detects rapid, multi-book line movement that signals coordinated sharp money.
 * A steam move is flagged when:
 * 1. Movement occurred within a short time window (default 1 hour)
 * 2. Multiple sharp books (2+) moved in the same direction
 * 3. Direction is supportive (toward the pick)
 */

const DEFAULT_STEAM_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MIN_STEAM_BOOKS = 2;
const { parseHistoryTimeMs } = require('./propprofessor-shared-utils');
const { classifySharpBookOrigin } = require('./propprofessor-sharp-books');

const SHARP_BOOKS = ['Pinnacle', 'Circa', 'BookMaker', 'BetOnline', 'Bet365', 'FanDuel', 'DraftKings', 'BetMGM'];

// Within the SHARP_BOOKS set, originators (Pinnacle/Circa/BookMaker/BetOnline)
// move FIRST on informed action; retail followers (DraftKings/FanDuel/BetMGM)
// copy the line seconds later. A steam move confirmed by originators is the
// stronger signal. Bet365 is included as a sharp comparison book but is treated
// as a follower here (it reprices after the originators), consistent with the
// site's sharp-book tiers in propprofessor-sharp-books.js.
function isSharpBook(book) {
  return SHARP_BOOKS.includes(String(book || '').trim());
}

function parseTimestamp(value) {
  return parseHistoryTimeMs(value);
}

function getOddsDirection(opening, current) {
  if (!Number.isFinite(opening) || !Number.isFinite(current)) return null;
  return current > opening ? 'up' : current < opening ? 'down' : null;
}

/**
 * Determine if movement toward a given pick is "supportive".
 * For negative odds (favorites): odds decreasing = supportive (team more favored)
 * For positive odds (underdogs): odds increasing = supportive (payout improving)
 */
function isSupportiveDirection(oddsDirection, pickSide) {
  if (!oddsDirection) return false;
  if (pickSide === 'home' || pickSide === 'favorite') {
    return oddsDirection === 'down'; // odds getting shorter = more favored
  }
  if (pickSide === 'away' || pickSide === 'underdog') {
    return oddsDirection === 'up'; // odds getting longer = better value
  }
  // Default: any movement counts
  return true;
}

/**
 * Analyze line history points to detect steam movement.
 *
 * @param {Object} row - Screen row with lineHistory/filteredLineHistory
 * @param {Object} options
 * @param {number} [options.nowMs] - Current timestamp (default Date.now())
 * @param {number} [options.steamWindowMs] - Max age of movement to consider (default 1 hour)
 * @param {number} [options.minBooks] - Minimum sharp books that must move (default 2)
 * @param {string} [options.pickSide] - 'home' or 'away' for supportive direction check
 * @returns {Object} Steam move detection result
 */
function detectSteamMove(row, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const steamWindowMs = Number.isFinite(options.steamWindowMs) ? options.steamWindowMs : DEFAULT_STEAM_WINDOW_MS;
  const minBooks = Number.isFinite(options.minBooks) ? options.minBooks : DEFAULT_MIN_STEAM_BOOKS;
  const pickSide = options.pickSide || null;

  const history =
    Array.isArray(row?.filteredLineHistory) && row.filteredLineHistory.length
      ? row.filteredLineHistory
      : Array.isArray(row?.lineHistory)
        ? row.lineHistory
        : [];

  if (history.length < 2) {
    return {
      isSteam: false,
      reason: 'insufficient_history',
      steamBooks: [],
      moveCount: 0,
      windowMs: 0,
      direction: null,
      originatorCount: 0
    };
  }

  // Filter to recent window
  const cutoffMs = nowMs - steamWindowMs;
  const recentPoints = history.filter((h) => {
    const ts = parseTimestamp(h.time || h.timestamp || h.t);
    return ts !== null && ts >= cutoffMs;
  });

  if (recentPoints.length < 2) {
    return {
      isSteam: false,
      reason: 'no_recent_movement',
      steamBooks: [],
      moveCount: 0,
      windowMs: steamWindowMs,
      direction: null,
      originatorCount: 0
    };
  }

  // Group by book and detect direction changes
  const bookMoves = new Map();
  for (const point of recentPoints) {
    const book = String(point.book || '').trim();
    if (!book || !isSharpBook(book)) continue;

    if (!bookMoves.has(book)) {
      bookMoves.set(book, []);
    }
    bookMoves.get(book).push({
      odds: Number(point.odds ?? point.price ?? point.current),
      time: parseTimestamp(point.time || point.timestamp || point.t)
    });
  }

  // Analyze each book's movement direction
  const bookDirections = new Map();
  for (const [book, points] of bookMoves) {
    if (points.length < 2) continue;

    // Sort by time
    points.sort((a, b) => (a.time || 0) - (b.time || 0));

    const firstOdds = points[0].odds;
    const lastOdds = points[points.length - 1].odds;
    const direction = getOddsDirection(firstOdds, lastOdds);

    if (direction) {
      bookDirections.set(book, {
        direction,
        opening: firstOdds,
        current: lastOdds,
        moveCount: points.length,
        windowMs: (points[points.length - 1].time || 0) - (points[0].time || 0)
      });
    }
  }

  // Count books moving in the same direction
  const directionCounts = { up: 0, down: 0 };
  const directionBooks = { up: [], down: [] };
  let originatorCount = 0;

  for (const [book, info] of bookDirections) {
    directionCounts[info.direction] += 1;
    directionBooks[info.direction].push(book);
    if (classifySharpBookOrigin(book) === 'originator') originatorCount += 1;
  }

  // Find the dominant direction
  const dominantDirection = directionCounts.up >= directionCounts.down ? 'up' : 'down';
  const dominantCount = Math.max(directionCounts.up, directionCounts.down);

  // Check if movement is supportive
  const supportive = pickSide ? isSupportiveDirection(dominantDirection, pickSide) : true; // No pick side specified, any multi-book movement is steam

  // Steam = multiple sharp books moved same direction within window, and it's supportive
  const isSteam = dominantCount >= minBooks && supportive;

  return {
    isSteam,
    reason: isSteam
      ? 'multi_book_movement'
      : dominantCount < minBooks
        ? 'insufficient_book_count'
        : 'adverse_direction',
    steamBooks: isSteam ? directionBooks[dominantDirection] : [],
    allMovingBooks: directionBooks,
    moveCount: recentPoints.length,
    windowMs: steamWindowMs,
    direction: dominantDirection,
    dominantBookCount: dominantCount,
    originatorCount,
    totalDirectionCounts: directionCounts,
    supportive
  };
}

module.exports = {
  detectSteamMove,
  isSharpBook,
  parseTimestamp,
  getOddsDirection,
  isSupportiveDirection,
  DEFAULT_STEAM_WINDOW_MS,
  DEFAULT_MIN_STEAM_BOOKS,
  SHARP_BOOKS
};
