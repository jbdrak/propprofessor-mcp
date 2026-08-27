'use strict';

/**
 * Screen league handlers: runLeagueScreen and runUfcCard.
 * Extracted from createMcpHandlers() in handlers.js.
 */

const { resolveMarkets } = require('./handler-utils');
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
    participants: args.participants || []
  });
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
    payloads: [payload],
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
        requirePreferredBook: requestedBooks.length > 0,
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

module.exports = { createScreenLeaguesHandlers };
