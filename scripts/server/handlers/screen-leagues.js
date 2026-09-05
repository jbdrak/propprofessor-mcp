'use strict';

/**
 * Screen league handlers: runLeagueScreen and runUfcCard.
 * Extracted from createMcpHandlers() in handlers.js.
 */

const { resolveMarkets, filterPayloadByLeagueName } = require('./handler-utils');
const {
  normalizeBookList,
  buildRankedScreenResponse: buildRankedScreenResponseShared,
  getIncludeAll,
  getLeagueRankingPreset,
  getLimit,
  getMaxAgeMs
} = require('../../../lib/propprofessor-mcp-ranked-screen');
const { getSharpBookComparisonSet, ALL_SCREEN_BOOKS, uniqueBooks } = require('../../../lib/propprofessor-sharp-books');
const { rankLeagueScreenRows } = require('../../../lib/screen-ranker');
const { buildUfcShortlist } = require('../../../lib/propprofessor-sharp-plays');
const { validatePositiveEvCandidates } = require('../../../lib/validate-ev-candidates');
const { buildEvRecoveryRequest, extractEvRows, dedupeEvRows } = require('./ev-recovery');

function buildCacheKey(prefix, args, league) {
  return JSON.stringify({
    prefix,
    league,
    market: args.market || 'Moneyline',
    books: normalizeBookList(args.books),
    is_live: false,
    cardWindow: String(args.cardWindow || 'all')
      .trim()
      .toLowerCase(),
    lookbackHours: Number.isFinite(Number(args.lookbackHours)) ? Number(args.lookbackHours) : null,
    games: args.games || [],
    participants: args.participants || [],
    leagueName: args.leagueName || null,
    evFirst: args.evFirst !== false
  });
}

function marketMatches(row, market) {
  const wanted = String(market || '')
    .trim()
    .toLowerCase();
  if (!wanted) return true;
  return [row.market, row.marketType, row.playType]
    .filter((value) => value != null)
    .some((value) => String(value).trim().toLowerCase() === wanted);
}

function isPlayerPropMarket(market) {
  return /^(player|pitcher)\b/i.test(String(market || '').trim());
}

// In aggregate quick_screen mode the main ranked query owns the ENTIRE
// process-global, serial odds-history gate (ODDS_HISTORY_MAX_CONCURRENCY=1) —
// the aggregate allocator reserves the full per-pair preHistoryShortlist
// budget for it. EV-first runs BEFORE that query and, left unbounded, would
// validate one queryOddsHistory call per EV candidate (slice = scanLimit,
// default up to 100), flooding the gate and pushing the main path past its
// PAIR_TIMEOUT_MS deadline (root cause of the "scan scope aborted" storm on
// multi-league `pp scan`). Cap EV-first to a small slice of ONE pair's
// main-path budget so it still discovers strong EV plays without starving the
// main screen. Direct/targeted (non-aggregate) scans keep the full EV-first
// pass. Derive the cap from the same allocator math so it tracks the budget.
const EV_FIRST_AGGREGATE_CAP = (() => {
  try {
    const { getAggregateGameBudget } = require('../../../lib/propprofessor-sharp-plays-service');
    // A mixed scan fans out ~9 league×market pairs; cap to 1/4 of one pair's
    // main-path budget — generous enough for real EV discovery, tiny enough
    // to leave the serial gate free for the main ranked query.
    return Math.max(1, Math.floor(getAggregateGameBudget(9) / 4));
  } catch {
    return 25;
  }
})();

async function runEvFirst(client, args, league, market, requestedBooks) {
  if (
    args.evFirst === false ||
    args.skipHistory === true ||
    (typeof client.querySportsbook !== 'function' && typeof client.queryPositiveEV !== 'function')
  )
    return null;
  // Aggregate quick_screen: bound the EV-first fan-out so it cannot flood the
  // serial odds-history gate. Prefer the per-pair cap threaded through by
  // the aggregate fan-out (it tracks the caller's limit); fall back to
  // EV_FIRST_AGGREGATE_CAP for direct callers. Non-aggregate single-league
  // / targeted scans keep the full candidate set.
  const evFirstCap =
    args.quickScreenAggregate === true
      ? Number(args.evFirstHistoryCap) > 0
        ? Math.floor(Number(args.evFirstHistoryCap))
        : EV_FIRST_AGGREGATE_CAP
      : null;
  try {
    // queryPositiveEV hardcodes minEV=0. The EV screen is not a positive-EV
    // screen: negative-EV rows still need history/CLV validation. Prefer the
    // sportsbook feed, whose minValue filter can include the full board.
    const query =
      typeof client.querySportsbook === 'function'
        ? client.querySportsbook.bind(client)
        : client.queryPositiveEV.bind(client);
    const raw = await query(
      buildEvRecoveryRequest({ league, market, books: ALL_SCREEN_BOOKS, maxHoursAway: args.maxHoursAway ?? 48 })
    );
    const candidates = dedupeEvRows(extractEvRows(raw))
      .filter((row) => row && marketMatches(row, market))
      .slice(
        0,
        evFirstCap != null ? evFirstCap : Number.isFinite(Number(args.scanLimit)) ? Number(args.scanLimit) : 100
      );
    if (!candidates.length) return null;
    const validated = await validatePositiveEvCandidates({
      client,
      candidates,
      args: { ...args, league, market, books: requestedBooks, validated: true }
    });
    if (!Array.isArray(validated.result) || !validated.result.length) return null;
    return {
      ...validated,
      result: validated.result.map((row) => ({ ...row, discoverySource: 'ev_board' })),
      resultMeta: { ...validated.resultMeta, source: 'ev_first', evBoardCandidateCount: candidates.length }
    };
  } catch {
    return null;
  }
}

async function runLeagueScreen(client, ctx, args = {}, league) {
  const requestedBooks = normalizeBookList(args.books);
  const marketResolution = resolveMarkets(args, league);
  const market = marketResolution.single;
  const preset = getLeagueRankingPreset(league, market);
  const focusBook = requestedBooks[0] || preset.preferredBooks[0];

  const nonMajorLeagues = ['TENNIS', 'SOCCER', 'UFC', 'WNBA', 'NCAAB', 'NCAAF'];
  const leagueUpper = (league || '').toUpperCase();
  const sharpBookSet = getSharpBookComparisonSet({ league, market });
  const augmentedBooks = nonMajorLeagues.includes(leagueUpper)
    ? ALL_SCREEN_BOOKS
    : uniqueBooks([...requestedBooks, ...sharpBookSet]);

  const canCache = !args.compact && !args.fields && !args.include;
  const cacheKey = canCache ? buildCacheKey('league', { ...args, books: augmentedBooks }, league) : null;
  if (cacheKey) {
    const cached = ctx.responseCache.get(cacheKey);
    if (cached) {
      return { ...cached, resultMeta: { ...cached.resultMeta, cached: true } };
    }
  }

  const evResult = await runEvFirst(client, args, league, market, requestedBooks);
  if (evResult) return evResult;

  const payload = await client.queryScreenOddsBestComps({
    market,
    league,
    games: Array.isArray(args.games) ? args.games : [],
    participants: Array.isArray(args.participants) ? args.participants : [],
    books: augmentedBooks,
    is_live: false
  });
  const response = buildRankedScreenResponseShared({
    client,
    payloads: [filterPayloadByLeagueName(payload, args.leagueName)],
    args: { ...args, historySportsbooks: augmentedBooks },
    league,
    focusBook,
    rankRows: (hydratedRows, { debug } = {}) =>
      rankLeagueScreenRows(hydratedRows, {
        league,
        market,
        limit: getLimit(args),
        books: requestedBooks.length ? requestedBooks : undefined,
        includeAll: getIncludeAll(args),
        maxAgeMs: getMaxAgeMs(args),
        debug,
        requirePreferredBook: requestedBooks.length > 0 && !isPlayerPropMarket(market),
        includeFallbackRows: isPlayerPropMarket(market),
        playableOnly: args.playableOnly === true
      })
  });

  if (marketResolution.aliasesUsed.length) {
    response.resultMeta = {
      ...response.resultMeta,
      markets_alias_used: marketResolution.aliasesUsed
    };
  }

  if (cacheKey) {
    const hasResults = Array.isArray(response.result) && response.result.length > 0;
    const hasError = response.error || (response.resultMeta && response.resultMeta.error);
    if (hasResults && !hasError) {
      ctx.responseCache.set(cacheKey, response, ctx.responseCacheTtlMs);
    }
  }

  return response;
}

async function runUfcCard(client, ctx, args = {}) {
  try {
    const marketResolution = resolveMarkets(args, 'UFC');
    const normalizedMarkets = marketResolution.array.length ? marketResolution.array : [marketResolution.single];
    const market = normalizedMarkets[0];
    const targetBook = String(args.book || args.targetBook || '').trim();
    const rankedArgs = {
      ...args,
      market,
      books: targetBook ? [targetBook] : Array.isArray(args.books) ? args.books : []
    };
    const rankedResponse = await runLeagueScreen(client, ctx, rankedArgs, 'UFC');
    const rankedRows = Array.isArray(rankedResponse?.result) ? rankedResponse.result : [];
    const shortlist = buildUfcShortlist(rankedRows, {
      ...args,
      market,
      targetBook,
      limit: getLimit(args)
    });
    if (!shortlist || typeof shortlist !== 'object') {
      return {
        ok: false,
        league: 'UFC',
        error: { code: 'UFC_CARD_FAILED', message: 'buildUfcShortlist returned null/undefined' }
      };
    }
    const count = shortlist.shortlistMeta?.filteredCount ?? shortlist.officialCount;
    const cardWindow = shortlist.shortlistMeta?.cardWindow || shortlist.shortlistCardWindow || null;
    const eventDate = shortlist.shortlistMeta?.eventDate || shortlist.shortlistEventDate || null;
    return {
      ok: true,
      league: 'UFC',
      officialPlays: shortlist.bestBets,
      bestLooks: shortlist.bestLooks,
      passes: shortlist.bestPasses,
      summaryText: shortlist.summaryText,
      count,
      resultMeta: {
        ...rankedResponse.resultMeta,
        source: 'ufc_card',
        cardWindow,
        eventDate,
        count,
        markets_alias_used: [...(rankedResponse.resultMeta?.markets_alias_used || []), ...marketResolution.aliasesUsed],
        shortlist: {
          ...shortlist,
          count
        }
      }
    };
  } catch (error) {
    process.stderr.write(`[propprofessor-mcp] ufc_card handler error: ${error?.stack || error?.message || error}\n`);
    return {
      ok: false,
      league: 'UFC',
      error: { code: 'UFC_CARD_FAILED', message: error?.message || String(error) }
    };
  }
}

function createScreenLeaguesHandlers(client, ctx) {
  return {
    runLeagueScreen: (args = {}, league) => runLeagueScreen(client, ctx, args, league),
    runUfcCard: (args = {}) => runUfcCard(client, ctx, args)
  };
}

module.exports = { createScreenLeaguesHandlers, runEvFirst, EV_FIRST_AGGREGATE_CAP };
