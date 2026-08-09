'use strict';

const { getSharpBookComparisonSet } = require('./propprofessor-sharp-books');
const {
  buildUfcShortlist,
  resolveSharpPlayLeagues,
  resolveSharpPlayMarkets,
  resolveTargetBooks,
  summarizeSharpPlayRows,
  uniqueBooks
} = require('./propprofessor-sharp-plays');
const { mapWithConcurrency } = require('./propprofessor-shared-utils');
const {
  getLeagueRankingPreset,
  getLimit,
  getLookbackHours,
  PRE_HISTORY_SHORTLIST_MAX_GAMES
} = require('./propprofessor-mcp-ranked-screen');

// Aggregate quick_screen scans: quick_screen fans out one sharp_plays call
// per (league, market) pair, and the process-wide odds-history budget is 75
// calls per 5 minutes per account (lib/propprofessor-api.js). Without a
// shared allocation each pair's ranked query would claim up to 48 selection
// calls (24-game shortlist × 2 sides) plus a duplicate sharp-only
// cross-reference, so the first few pairs exhaust the budget and every later
// row degrades to movementDisposition=insufficient. In aggregate mode each
// pair claims a small explicit pre-history budget derived from the total pair
// count. Aggregate mode hydrates the strongest side per shortlisted game;
// direct and targeted paths still hydrate paired sides. Forty of the 75 calls
// are reserved for initial ranking, leaving room for validation and Tennis
// fallback recovery.
const AGGREGATE_HISTORY_CALL_ALLOCATION = 40;

/**
 * Per-pair pre-history game budget for an aggregate quick_screen scan.
 * Aggregate mode hydrates one strongest current-market side per shortlisted
 * game. Floored at one game so every league/market pair with data keeps at
 * least one evaluated candidate even when the slate is huge.
 *
 * @param {number} pairCount - Total league×market pairs in the quick_screen fan-out.
 * @returns {number} Game budget for a single main ranked query.
 */
function getAggregateGameBudget(pairCount) {
  const pairs = Math.max(1, Math.floor(Number(pairCount) || 1));
  const games = Math.floor(AGGREGATE_HISTORY_CALL_ALLOCATION / pairs);
  return Math.max(1, Math.min(PRE_HISTORY_SHORTLIST_MAX_GAMES, games));
}

async function queryRankedSharpPlayResponses({
  rankScanTuples,
  args,
  quickScreenAggregate,
  aggregateGameBudget,
  targetPlusSharpBooks,
  queryLeagueScreen,
  queryTennisScreen
}) {
  const rankedResponses = await mapWithConcurrency(
    rankScanTuples,
    async ({ executionBook, league, market }) => {
      const books = targetPlusSharpBooks(league, market, executionBook);
      const rankedArgs = {
        ...args,
        league,
        market,
        book: executionBook,
        targetBook: executionBook,
        books,
        historySportsbooks: books,
        includeAll: true,
        limit:
          Number.isFinite(Number(args.scanLimit)) && Number(args.scanLimit) > 0
            ? Number(args.scanLimit)
            : Math.max(20, getLimit(args) * 3),
        ...(quickScreenAggregate
          ? {
              // Explicit opt-in to the broad-scan pre-history shortlist: the
              // main ranked query is the ONLY history consumer in aggregate
              // mode (the sharp-only cross-reference below is skipped), so
              // its shortlist must not claim the default 24-game / ~48-call
              // allowance per pair. Standalone screen_ranked / direct
              // sharp_plays never get this flag — they keep full hydration.
              preHistoryShortlist: true,
              // Per-pair pre-history game budget: derived from the total
              // pair count so every pair claims a fair slice of the
              // process-wide 75-call odds-history budget.
              preHistoryGameBudget: aggregateGameBudget,
              // Row cap: hydrate the strongest side per shortlisted game.
              // Paired-side hydration remains available in direct/targeted
              // paths, but cannot fit across 30+ aggregate pairs under 75.
              preHistoryRowBudget: aggregateGameBudget,
              // The aggregate allocator budgets one history request per
              // shortlisted side. Adjacent-line retries can triple that spend,
              // so keep them for targeted/detail paths only.
              enableHistoryLineFallback: false
            }
          : {})
      };
      const response =
        // @ts-expect-error
        String(getLeagueRankingPreset(league).league || league).toUpperCase() === 'TENNIS'
          ? await queryTennisScreen(/** @type {any} */ (rankedArgs))
          : // @ts-expect-error
            await queryLeagueScreen(/** @type {any} */ (rankedArgs), getLeagueRankingPreset(league).league || league);
      return { targetBook: executionBook, league, market, response };
    },
    { concurrency: 4 }
  );
  return rankedResponses;
}

async function collectSharpBookMovement({
  args,
  leagues,
  markets,
  targetBooks,
  quickScreenAggregate,
  queryLeagueScreen,
  queryTennisScreen
}) {
  let sharpBookQueryCount = 0;
  // history hydration and movement analysis actually work. Querying each
  // book individually (books: [sharpBook]) means no consensus data and
  // movementLabel always comes back as 'insufficient_history'.
  // Aggregate quick_screen mode SKIPS this query entirely: the main ranked
  // query already hydrates target + sharp books, so re-hydrating the same
  // slate with sharp-only books would duplicate odds-history calls — the
  // exact spend that exhausts the process-wide 75-call budget on a wide
  // fan-out. Direct sharp_plays calls keep the two-query contract.
  const sharpBookComparisonSet = getSharpBookComparisonSet({
    league: leagues[0],
    market: markets[0],
    requestedBooks: Array.isArray(args.sharpBooks) && args.sharpBooks.length ? args.sharpBooks : undefined
  });
  const sharpBookMovementMap = new Map(); // key: "gameId|selection" → { book, movementLabel, clvProxyPct }
  // Filter out target books from the sharp set
  const crossRefSharpBooks = sharpBookComparisonSet.filter(
    (sb) => !targetBooks.some((tb) => tb.toLowerCase() === sb.toLowerCase())
  );
  if (quickScreenAggregate && crossRefSharpBooks.length > 0) {
    if (process.env.PROPPROFESSOR_DEBUG) {
      process.stderr.write(
        `[sharp-plays] aggregate quick_screen: skipping sharp-only cross-reference (main ranked query already hydrates target + sharp books)\n`
      );
    }
  }
  if (crossRefSharpBooks.length > 0 && !quickScreenAggregate) {
    // Sharp-book cross-reference is independent per (league, market), so fan
    // it out the same way. Failures are absorbed (a single bad league should
    // not abort the whole scan).
    const crossRefTuples = [];
    for (const league of leagues) {
      for (const market of markets) {
        crossRefTuples.push({ league, market });
      }
    }
    await mapWithConcurrency(
      crossRefTuples,
      async ({ league, market }) => {
        try {
          const sharpArgs = {
            ...args,
            league,
            market,
            books: crossRefSharpBooks,
            historySportsbooks: crossRefSharpBooks,
            includeAll: true,
            limit: 50,
            compact: true,
            fields: [
              'gameId',
              'game',
              'selection',
              'participant',
              'pick',
              'movementLabel',
              'movementSourceBook',
              'clvProxyPct'
            ]
          };
          const sharpResponse =
            String(getLeagueRankingPreset(league, '').league || league).toUpperCase() === 'TENNIS'
              ? await queryTennisScreen(/** @type {any} */ (sharpArgs))
              : await queryLeagueScreen(
                  /** @type {any} */ (sharpArgs),
                  getLeagueRankingPreset(league, '').league || league
                );
          sharpBookQueryCount++;
          for (const row of Array.isArray(sharpResponse?.result) ? sharpResponse.result : []) {
            const gameId = String(row.gameId || row.game || '').trim();
            const selection = String(row.selection || row.participant || row.pick || '').trim();
            if (!gameId || !selection) continue;
            const key = `${gameId}|${selection}`;
            if (row.movementLabel === 'supportive' && !sharpBookMovementMap.has(key)) {
              sharpBookMovementMap.set(key, {
                book: row.book || crossRefSharpBooks[0],
                movementLabel: row.movementLabel,
                clvProxyPct: row.clvProxyPct ?? null
              });
            }
          }
        } catch (err) {
          // Sharp book query failed — continue without it
          if (process.env.PROPPROFESSOR_DEBUG) {
            process.stderr.write(`[sharp-plays] query failed for ${league} ${market}: ${err.message}\n`);
          }
        }
      },
      { concurrency: 4 }
    );
  }

  return { sharpBookMovementMap, sharpBookQueryCount };
}

function buildSharpPlayResult({
  rankedRows,
  rankedResponses,
  sharpBookMovementMap,
  sharpBookQueryCount,
  args,
  targetBooks,
  targetBook,
  leagues,
  markets,
  quickScreenAggregate,
  aggregatePairCount,
  aggregateGameBudget
}) {
  // Tag ranked rows with sharp book movement confirmation
  for (const row of rankedRows) {
    const gameId = String(row.gameId || row.game || '').trim();
    const selection = String(row.selection || row.participant || row.pick || '').trim();
    if (!gameId || !selection) continue;
    const key = `${gameId}|${selection}`;
    const sharpMovement = sharpBookMovementMap.get(key);
    if (sharpMovement) {
      row.sharpBookMovementConfirmed = true;
      row.sharpBookMovementSource = sharpMovement.book;
      row.sharpBookClv = sharpMovement.clvProxyPct;
    }
  }
  const strict = args.strict !== undefined ? Boolean(args.strict) : true;
  const sharpPlaySummary = summarizeSharpPlayRows(
    rankedRows,
    /** @type {any} */ ({
      ...args,
      targetBook,
      strict,
      limit: getLimit(args),
      requirePlayablePrice: args.requirePlayablePrice !== undefined ? args.requirePlayablePrice : false,
      requireBestPrice: args.requireBestPrice !== undefined ? args.requireBestPrice : false
    })
  );
  const result = sharpPlaySummary.filteredRows;
  const ufcRows = rankedRows.filter(
    (row) =>
      String(row.scanLeague || row.league || '')
        .trim()
        .toUpperCase() === 'UFC'
  );
  const ufcShortlist = ufcRows.length
    ? buildUfcShortlist(
        ufcRows,
        /** @type {any} */ ({
          ...args,
          targetBook,
          limit: getLimit(args)
        })
      )
    : null;
  const perTargetBook = Object.fromEntries(
    targetBooks.map((book) => {
      const scanned = rankedRows.filter((row) => row.executionBook === book).length;
      const returned = result.filter((row) => (row.executionBook || row.targetBook || row.book) === book).length;
      return [book, { scanned, returned }];
    })
  );
  const emptyState =
    result.length === 0
      ? {
          reason:
            sharpPlaySummary.classificationSummary.totalRowsClassified === 0
              ? 'no_ranked_rows_scanned'
              : 'rows_failed_post_filter',
          scannedRowCount: sharpPlaySummary.classificationSummary.totalRowsClassified,
          failureBreakdown: sharpPlaySummary.classificationSummary.passReasonCounts,
          topNearMisses: sharpPlaySummary.topNearMisses
        }
      : null;

  return {
    ok: true,
    count: result.length,
    result,
    resultMeta: {
      source: 'sharp_plays_addon',
      targetBook,
      targetBooks,
      targetBookCount: targetBooks.length,
      leagues,
      markets,
      strict,
      includePasses: Boolean(args.includePasses),
      minConsensusBookCount: Number.isFinite(Number(args.minConsensusBookCount))
        ? Number(args.minConsensusBookCount)
        : 2,
      minOdds: args.minOdds ?? null,
      maxOdds: args.maxOdds ?? null,
      lookbackHoursUsed: getLookbackHours(args),
      scannedRowCount: rankedRows.length,
      scannedQueryCount: rankedResponses.length + sharpBookQueryCount,
      perTargetBook,
      classificationSummary: sharpPlaySummary.classificationSummary,
      emptyState,
      ufcShortlist,
      ...(quickScreenAggregate
        ? {
            historyBudget: {
              mode: 'aggregate',
              pairCount: aggregatePairCount,
              perPairGameBudget: aggregateGameBudget,
              maxSelectionCalls: aggregatePairCount * aggregateGameBudget
            }
          }
        : {}),
      workflow:
        'Target book is execution only. Supportive movement must come from a non-target sharp book; target-book-only movement is downgraded. For props, market availability and playable price are used instead of raw consensus count.'
    }
  };
}

/**
 * Orchestrate a multi-league/multi-market sharp-play scan across one or more target books.
 *
 * For each (targetBook, league, market) combination the function queries either
 * `queryLeagueScreen` or `queryTennisScreen` (depending on the league's ranking preset).
 * It then cross-references the returned rows against a set of sharp comparison books to
 * tag rows that show supportive sharp-book movement. Finally it summarises & shortlists
 * the results via `summarizeSharpPlayRows` and optionally builds a UFC shortlist.
 *
 * @param {Object}  [args={}] - Configuration object.
 * @param {string|string[]} [args.book] - Single target execution book (alias for `targetBook`).
 * @param {string}  [args.targetBook] - Alias for `book`.
 * @param {string[]} [args.targetBooks] - Execution books to scan together.
 * @param {string[]} [args.sharpBooks] - Override the default sharp-book comparison set.
 * @param {string|string[]} [args.league] - Single league shortcut.
 * @param {string[]} [args.leagues] - Leagues to scan (default: NBA, MLB, NHL, Tennis, WNBA).
 * @param {string}   [args.market] - Single market shortcut.
 * @param {string[]} [args.markets] - Markets to scan (default: ["Moneyline"]).
 * @param {number}   [args.limit] - Max final sharp plays to return.
 * @param {number}   [args.scanLimit] - Per-league/market ranked rows to scan before final filtering.
 * @param {boolean}  [args.strict=true] - When true, returns only Bet candidates.
 * @param {boolean}  [args.includePasses] - Include failed rows with passReasons for debugging.
 * @param {boolean}  [args.requirePlayablePrice] - When true, rows without a playable price are excluded.
 * @param {boolean}  [args.requireBestPrice] - When true, only rows where the target book has the best price are kept.
 * @param {number}   [args.minConsensusBookCount] - Minimum number of books with data for prop classification.
 * @param {number}   [args.minOdds] - Minimum target-book American odds.
 * @param {number}   [args.maxOdds] - Maximum target-book American odds.
 * @param {number}   [args.lookbackHours] - Odds-history lookback window in hours.
 * @param {boolean}  [args.debug] - Include verbose movement debug payloads.
 * @param {boolean}  [args.quickScreenAggregate] - Aggregate quick_screen mode: one sharp_plays call per (league, market) pair sharing a pre-history budget.
 * @param {number}   [args.aggregatePairCount] - Total league×market pair count, used for per-pair pre-history budget allocation in aggregate mode.
 * @param {Object}   [deps={}] - Dependency injection object.
 * @param {Function} deps.queryLeagueScreen - Async function called with `(args, league)` to screen a league.
 * @param {Function} deps.queryTennisScreen - Async function called with `(args)` to screen tennis.
 *
 * @returns {Promise<{ ok: boolean, count: number, result: Array<Object>, resultMeta: { source: string, targetBook: string, targetBooks: Array<string>, targetBookCount: number, leagues: Array<string>, markets: Array<string>, strict: boolean, includePasses: boolean, minConsensusBookCount: number, minOdds: number|null, maxOdds: number|null, lookbackHoursUsed: number, scannedRowCount: number, scannedQueryCount: number, perTargetBook: Object, classificationSummary: Object, emptyState: Object|null, ufcShortlist: Object|null, workflow: string } }>} Result object.
 */
async function runSharpPlays(
  args = {},
  deps = /** @type {{ queryLeagueScreen: Function, queryTennisScreen: Function }} */ ({})
) {
  const { queryLeagueScreen, queryTennisScreen } = deps;
  if (typeof queryLeagueScreen !== 'function') {
    throw new TypeError('runSharpPlays requires queryLeagueScreen(args, league)');
  }
  if (typeof queryTennisScreen !== 'function') {
    throw new TypeError('runSharpPlays requires queryTennisScreen(args)');
  }

  const targetBooks = resolveTargetBooks(/** @type {any} */ (args));
  const targetBook = targetBooks[0];
  const leagues = resolveSharpPlayLeagues(/** @type {any} */ (args));
  const markets = resolveSharpPlayMarkets(/** @type {any} */ (args));
  const targetPlusSharpBooks = (league, market, executionBook) =>
    uniqueBooks([
      executionBook,
      ...getSharpBookComparisonSet({
        league,
        market,
        requestedBooks: Array.isArray(args.sharpBooks) && args.sharpBooks.length ? args.sharpBooks : undefined
      })
    ]);

  // Build the cartesian product (targetBook × league × market) up front so
  // we can fan it out with mapWithConcurrency instead of awaiting each
  // (targetBook, league, market) tuple serially. With the v2.1.9 default of
  // 1 book × 10 leagues × 1 market = 10 sequential HTTP calls; with this
  // change the wall-clock latency is roughly max(per-call) rather than
  // sum(per-call). Concurrency-4 keeps the backend from being hammered.
  const rankScanTuples = [];
  for (const executionBook of targetBooks) {
    for (const league of leagues) {
      for (const market of markets) {
        rankScanTuples.push({ executionBook, league, market });
      }
    }
  }
  // Aggregate quick_screen mode: quick_screen fans out one call per
  // (league, market) pair and passes the TOTAL pair count so every pair can
  // claim a fair, small slice of the process-wide 75-call odds-history
  // budget instead of first-come starvation under concurrency.
  const quickScreenAggregate = args.quickScreenAggregate === true;
  const aggregatePairCount = quickScreenAggregate
    ? Math.max(1, Math.floor(Number(args.aggregatePairCount) || rankScanTuples.length))
    : rankScanTuples.length;
  const aggregateGameBudget = quickScreenAggregate ? getAggregateGameBudget(aggregatePairCount) : null;
  const rankedResponses = await queryRankedSharpPlayResponses({
    rankScanTuples,
    args,
    quickScreenAggregate,
    aggregateGameBudget,
    targetPlusSharpBooks,
    queryLeagueScreen,
    queryTennisScreen
  });

  const rankedRows = rankedResponses.flatMap(({ targetBook: executionBook, league, market, response }) =>
    (Array.isArray(response?.result) ? response.result : []).map((row) => ({
      ...row,
      targetBook: executionBook,
      executionBook,
      scanTargetBook: executionBook,
      scanLeague: league,
      scanMarket: market
    }))
  );

  const { sharpBookMovementMap, sharpBookQueryCount } = await collectSharpBookMovement({
    args,
    leagues,
    markets,
    targetBooks,
    quickScreenAggregate,
    queryLeagueScreen,
    queryTennisScreen
  });

  return buildSharpPlayResult({
    rankedRows,
    rankedResponses,
    sharpBookMovementMap,
    sharpBookQueryCount,
    args,
    targetBooks,
    targetBook,
    leagues,
    markets,
    quickScreenAggregate,
    aggregatePairCount,
    aggregateGameBudget
  });
}

module.exports = {
  runSharpPlays,
  getAggregateGameBudget
};
