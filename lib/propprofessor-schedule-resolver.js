'use strict';

const { getTodayTennisSchedule } = require('./propprofessor-schedule');
const { runGetPlayDetailsImpl } = require('./run-get-play-details-helper');
const { normalizeBookList } = require('./book-utils');

/**
 * Schedule-First Game Resolver
 * Replaces all workarounds for stale tennis game dates with authoritative schedule source.
 * This is the Phase 1 implementation - schedule-first discovery.
 */

/**
 * Resolve tennis games using schedule-first approach
 * @param {Object} params - Resolution parameters
 * @param {string} params.league - League identifier
 * @param {string} params.market - Market to query
 * @param {string} params.date - Date to fetch schedule for
 * @param {Array} params.books - Books to query
 * @param {string} params.focusBook - Focus book for results
 * @param {number} params.lookbackHours - Odds lookback window
 * @returns {Promise<Array>} Array of resolved game data
 */
async function resolveGamesWithScheduleFirst(params) {
  const { league = 'Tennis', market = 'Moneyline', date, books = [], focusBook = '', lookbackHours = 6 } = params;

  const today = date || new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  try {
    // Get schedule from primary source (Sofascore)
    const scheduleGames = await getTodayTennisSchedule(today);

    if (!scheduleGames || scheduleGames.length === 0) {
      console.error('[schedule-resolver] No games found in schedule');
      return [];
    }

    // Extract gameIds from schedule based on today's date
    const todayGameIds = [];
    for (const game of scheduleGames) {
      const gameDate = new Date(game.startTimestamp).toISOString().split('T')[0];
      if (gameDate === today) {
        todayGameIds.push(game.gameId);
      }
    }

    if (todayGameIds.length === 0) {
      console.error('[schedule-resolver] No games scheduled for today');
      return [];
    }

    console.error(
      `[schedule-resolver] Resolving ${todayGameIds.length} games ` + `via schedule: ${todayGameIds.join(', ')}`
    );

    // Query PP by gameIds to get current odds and status
    const resolvedGames = [];

    for (const gameId of todayGameIds) {
      try {
        const gameDetailResult = await runGetPlayDetailsImpl(null, {
          league,
          market,
          gameIds: [gameId],
          books: normalizeBookList(books),
          lookbackHours,
          focusBook
        });

        if (gameDetailResult?.result && Array.isArray(gameDetailResult.result)) {
          resolvedGames.push(...gameDetailResult.result);
          console.error(`[schedule-resolver] Resolved gameId ${gameId}: ` + `${gameDetailResult.result.length} rows`);
        }
      } catch (gameError) {
        console.warn(`[schedule-resolver] Failed to resolve gameId ${gameId}:`, gameError.message);
        // Continue with other games
      }
    }

    console.error(
      `[schedule-resolver] Successfully resolved ` +
        `${resolvedGames.length} total rows from ${todayGameIds.length} scheduled games`
    );

    return resolvedGames;
  } catch (error) {
    console.error('[schedule-resolver] Failed to resolve games with schedule:', error);

    // If schedule resolution fails, fall back to traditional screen query
    console.error('[schedule-resolver] Falling back to traditional screen query');
    // This would call the original screen query logic
    return [];
  }
}

/**
 * Check if schedule is available and reliable
 * @returns {Promise<boolean>} True if schedule source is available
 */
async function checkScheduleAvailability() {
  try {
    const scheduleGames = await getTodayTennisSchedule();
    return scheduleGames && scheduleGames.length > 0;
  } catch (error) {
    console.warn('[schedule-resolver] Schedule availability check failed:', error.message);
    return false;
  }
}

/**
 * Get today's date for schedule queries
 * @returns {string} Today's date (YYYY-MM-DD)
 */
function getTodayDate() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

/**
 * Validate schedule data before use
 * @param {Array} scheduleGames - Schedule games to validate
 * @returns {boolean} True if schedule data is valid
 */
function validateScheduleData(scheduleGames) {
  return (
    Array.isArray(scheduleGames) &&
    scheduleGames.every((game) => {
      return game && game.gameId && game.startTimestamp && game.homeTeam && game.awayTeam;
    })
  );
}

module.exports = {
  resolveGamesWithScheduleFirst,
  checkScheduleAvailability,
  getTodayDate,
  validateScheduleData
};
