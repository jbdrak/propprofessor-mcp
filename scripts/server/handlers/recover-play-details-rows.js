'use strict';

const { parseGameIdIdentity, findBestMatchGameIdChanged } = require('../../../lib/selection-matcher');
const flashscoreTimes = require('../../../lib/flashscore-times');

/**
 * Recover a direct play-details lookup when the backend re-keyed the game ID.
 *
 * @param {object} options - Recovery dependencies and request state
 * @returns {Promise<object[]>} The same merged array, possibly with one row appended
 */
async function recoverPlayDetailsRows({
  merged,
  relaxedGameIdMatch,
  args,
  gameIds,
  league,
  market,
  client,
  augmentedBooksExcluded,
  focusBook,
  augmentedBooks,
  queryPlayDetailsResponse,
  resolveGameIdIdentity = parseGameIdIdentity,
  findBestMatchGameIdChanged: findFallbackRow = findBestMatchGameIdChanged,
  lookupMatchTime = flashscoreTimes.lookupMatchTime
}) {
  if (
    !relaxedGameIdMatch &&
    args.disableTimestampDriftFallback !== true &&
    merged.length === 0 &&
    gameIds.length === 1
  ) {
    const identity = resolveGameIdIdentity(gameIds[0]);
    if (identity) {
      const relaxedResponse = await queryPlayDetailsResponse({
        client,
        args,
        gameIds,
        league,
        market,
        relaxedGameIdMatch: true,
        relaxedParticipants: Array.isArray(args.participants) ? args.participants : [],
        augmentedBooksExcluded,
        focusBook,
        augmentedBooks
      });
      const relaxedRows = Array.isArray(relaxedResponse.result) ? relaxedResponse.result : [];
      let verifiedDateKey = '';
      if (league.toLowerCase() === 'tennis' && relaxedRows.length) {
        const first = relaxedRows[0];
        const schedule = lookupMatchTime(first.homeTeam, first.awayTeam);
        verifiedDateKey = schedule?.date || '';
      }
      const fallbackRow = findFallbackRow(relaxedRows, {
        league,
        market,
        selection: args.selection || '',
        playId: args.playId || '',
        gameId: gameIds[0],
        requestedBook: focusBook,
        verifiedDateKey
      });
      if (fallbackRow) merged.push(fallbackRow);
    }
  }
  return merged;
}

module.exports = { recoverPlayDetailsRows };
