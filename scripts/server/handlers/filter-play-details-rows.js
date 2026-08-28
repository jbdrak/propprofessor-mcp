'use strict';

const flashscoreTimes = require('../../../lib/flashscore-times');

/**
 * Filter play-detail rows to the requested game identity and merge focus-book
 * fallback rows without changing the upstream response object.
 *
 * @param {object} options - Matching inputs
 * @param {object} options.response - Raw ranked response
 * @param {object} options.args - Play-detail arguments
 * @param {string[]} options.gameIds - Requested game IDs
 * @param {string} options.league - Requested league
 * @param {boolean} options.relaxedGameIdMatch - Keep all rows when relaxed
 * @returns {object[]} Filtered and merged rows
 */
function filterPlayDetailsRows({ response, args, gameIds, league, relaxedGameIdMatch }) {
  const normalizeGameId = (id) =>
    String(id || '')
      .replace(/:\d{10,}$/, '')
      .trim();
  const normalizedRequested = gameIds.map(normalizeGameId);
  const gameIdSet = new Set(normalizedRequested);
  const safeResult = Array.isArray(response.result) ? response.result : [];
  const verifiedTennisDate =
    league.toLowerCase() === 'tennis' && safeResult.length
      ? flashscoreTimes.lookupMatchTime(safeResult[0].homeTeam, safeResult[0].awayTeam)?.date || ''
      : '';
  const exactGameIdMatches = (row) => {
    const rowId = String(row?.gameId || '').trim();
    if (!rowId) return false;
    if (args.playId && String(row?.playId || '').trim() !== String(args.playId).trim()) return false;
    if (gameIds.includes(rowId)) return true;
    const rowHasTimestamp = /:\d{10,}$/.test(rowId);
    const requestedHasTimestamp = gameIds.some((id) => /:\d{10,}$/.test(String(id)));
    if (verifiedTennisDate && row.start) {
      const rowDate = new Date(row.start).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      if (rowDate !== verifiedTennisDate) return false;
    }
    return !rowHasTimestamp && requestedHasTimestamp && gameIdSet.has(normalizeGameId(rowId));
  };
  const filtered = relaxedGameIdMatch ? safeResult : safeResult.filter(exactGameIdMatches);

  const fallbackRows = Array.isArray(response.focusBookMissingRows) ? response.focusBookMissingRows : [];
  const merged = [...filtered];
  for (const fbRow of fallbackRows) {
    if (relaxedGameIdMatch || exactGameIdMatches(fbRow)) {
      merged.push({ ...fbRow, __focusBookMissing: true });
    }
  }
  return merged;
}

module.exports = { filterPlayDetailsRows };
