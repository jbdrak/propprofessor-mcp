'use strict';

/**
 * validatePositiveEvCandidates — validates + ranks +EV candidates.
 *
 * Extracted from createMcpHandlers() in scripts/server/handlers.js to break
 * the circular dependency with discovery.js.
 *
 * Dependencies: all lib-level imports, no closure variables from handlers.js.
 */

const { getOddsHistoryCache } = require('./mcp-runtime-config');
const {
  getIncludeAll,
  getLimit,
  getLookbackHours,
  getMaxAgeMs,
  normalizeBookList,
  getDebugFlag
} = require('./propprofessor-mcp-ranked-screen');
const { mapWithConcurrency, createCrossCallMemoizedQuery } = require('./propprofessor-shared-utils');
const { getSharpBookComparisonSet } = require('./propprofessor-sharp-books');
const { buildPositiveEvTarget } = require('../scripts/server/handlers/handler-utils');
const { resolveHistoryForEntity } = require('./propprofessor-history');
const { rankLeagueScreenRows } = require('./screen-ranker');
const { extractScreenRows } = require('./screen-parser');

/**
 * Create a cross-call memoized query for odds history.
 * Moved from closure in handlers.js to break the circular dep.
 */
function createOddsHistoryMemoizedQuery(client) {
  const cache = getOddsHistoryCache();
  const memoized = createCrossCallMemoizedQuery(
    (params) => {
      const sportsbooks = Array.isArray(params.sportsbooks)
        ? params.sportsbooks.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      return client.queryOddsHistory({ ...params, sportsbooks });
    },
    {
      cache,
      keyFn: (params) =>
        JSON.stringify({
          gameId: params.gameId ?? null,
          selectionId: params.selectionId ?? null,
          sportsbooks: Array.isArray(params.sportsbooks)
            ? params.sportsbooks.map((value) => String(value || '').trim()).filter(Boolean)
            : [],
          startTimestamp: params.startTimestamp ?? null
        })
    }
  );
  return memoized;
}

/**
 * Validate and rank positive-EV candidates from a sportsbook feed.
 * Returns ranked rows with line history, or throws VALIDATION_INCOMPLETE
 * when all candidates fail validation.
 */
// @ts-expect-error
async function validatePositiveEvCandidates({ client, candidates = [], args = {} } = {}) {
  const rows = Array.isArray(candidates) ? candidates.filter((play) => play && typeof play === 'object') : [];
  // @ts-expect-error
  const requestedBooks = normalizeBookList(args.books);
  const limit = getLimit(args);
  // @ts-expect-error
  const debug = getDebugFlag(args.debug, false);
  const lookbackHoursUsed = getLookbackHours(args);
  const maxAgeMs = getMaxAgeMs(args);
  const queryHistoryMemoized = createOddsHistoryMemoizedQuery(client);
  let failedValidationCount = 0;
  let historyFailureCount = 0;
  const validationWarnings = [];

  const enriched = await mapWithConcurrency(rows, async (play) => {
    // @ts-expect-error
    const league = String(play.league || args.league || '').trim() || 'NBA';
    // @ts-expect-error
    const market = String(play.market || args.market || '').trim() || 'Moneyline';
    const focusBook = String(play.book || '').trim();
    const sharpBooks = getSharpBookComparisonSet({
      league,
      market,
      requestedBooks: requestedBooks.length ? requestedBooks : undefined
    });
    const target = buildPositiveEvTarget(play);

    let history;
    let validationFailed = false;
    let validationError = null;
    try {
      history = await resolveHistoryForEntity({
        client,
        target,
        rows,
        lookbackHours: lookbackHoursUsed,
        preferredBook: focusBook || null,
        sharpBooks,
        historySportsbooks: sharpBooks,
        queryHistoryFn: queryHistoryMemoized
      });
    } catch (error) {
      validationFailed = true;
      validationError = error;
      failedValidationCount += 1;
      historyFailureCount += 1;
      history = {
        lineHistory: [],
        lineHistoryAvailable: false,
        lineHistorySource: null,
        historySportsbooksRequested: sharpBooks
      };
    }

    return {
      ...play,
      league,
      market,
      book: focusBook || play.book || play.sportsbook || '',
      participant: play.participant || target.participant,
      selection: play.selection || target.selection,
      pick: play.pick || target.pick,
      game: play.game || play.matchup || target.game,
      odds: play.odds,
      lineHistory: Array.isArray(history.lineHistory) ? history.lineHistory : [],
      lineHistoryAvailable: Boolean(history.lineHistoryAvailable),
      lineHistorySource: history.lineHistorySource || null,
      lineHistoryLookbackHours: lookbackHoursUsed,
      historySportsbooksRequested: Array.isArray(history.historySportsbooksRequested)
        ? history.historySportsbooksRequested
        : sharpBooks,
      normalizedSelectionId: history.normalizedSelectionId || target.selectionId || null,
      historyGameId: history.historyGameId || target.gameId || null,
      historyMatchedBy: history.historyMatchedBy || null,
      historyMatchKey: history.historyMatchKey || null,
      validationFailed,
      validationErrorMessage: validationFailed
        ? String(validationError?.message || validationError || 'Validation failed')
        : null
    };
  });

  const validatedRows = enriched.filter((row) => !row.validationFailed);
  const partiallyValidated = failedValidationCount > 0 && validatedRows.length > 0;
  const noRowsValidated = rows.length > 0 && validatedRows.length === 0;

  if (partiallyValidated) {
    validationWarnings.push(
      `${failedValidationCount} candidate validation lookup(s) failed; returning ${validatedRows.length} validated row(s).`
    );
  }

  if (noRowsValidated) {
    const error =
      /** @type {Error & { code?: string, category?: string, status?: number, retryable?: boolean, details?: unknown }} */ (
        new Error(`Positive EV validation failed for all ${rows.length} candidate(s); no validated results returned`)
      );
    error.code = 'VALIDATION_INCOMPLETE';
    error.category = 'backend';
    error.status = 503;
    error.retryable = true;
    error.details = {
      candidateCount: rows.length,
      validatedCount: 0,
      failedValidationCount,
      historyFailureCount,
      lookbackHoursUsed
    };
    throw error;
  }

  const ranked = rankLeagueScreenRows(validatedRows, {
    // @ts-expect-error
    league: args.league || validatedRows[0]?.league || 'NBA',
    // @ts-expect-error
    market: args.market || validatedRows[0]?.market || 'Moneyline',
    limit,
    includeAll: getIncludeAll(args),
    maxAgeMs,
    books: requestedBooks.length ? requestedBooks : undefined,
    debug
  });

  return {
    ok: true,
    result: ranked,
    count: ranked.length,
    freshness: require('./screen-summary').summarizeFreshness(extractScreenRows(validatedRows), Date.now(), {
      maxAgeMs
    }),
    warnings: validationWarnings,
    resultMeta: {
      lookbackHoursUsed,
      debugEnabled: debug,
      source: 'positive_ev_candidates',
      candidateCount: rows.length,
      validatedCount: validatedRows.length,
      failedValidationCount,
      historyFailureCount,
      partialValidation: partiallyValidated
    }
  };
}

module.exports = { validatePositiveEvCandidates, createOddsHistoryMemoizedQuery };
