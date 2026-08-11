'use strict';

/**
 * Tennis screen handler — extracted from createMcpHandlers() in handlers.js.
 */

const {
  correctTennisTimes,
  enrichTennisEvCandidates,
  getTennisMarketFamily,
  normalizeTennisMarketQuery,
  rankTennisScreenRows
} = require('../../../lib/screen-tennis');
const {
  buildRankedScreenResponse: buildRankedScreenResponseShared,
  getIncludeAll,
  getLimit,
  getLookbackHours,
  getMaxAgeMs,
  normalizeBookList
} = require('../../../lib/propprofessor-mcp-ranked-screen');
const { resolveMarkets } = require('./handler-utils');
const { extractScreenRows } = require('../../../lib/screen-parser');
const { ALL_SCREEN_BOOKS } = require('../../../lib/propprofessor-sharp-books');
const { filterTennisRowsByCardWindow } = require('../../../lib/tennis-fallback');

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

async function runTennisEvFallback({ client, args, rows, marketResolution, preferredBook }) {
  let evResult;
  try {
    evResult = await client.querySportsbook({
      leagues: ['Tennis'],
      sportsbooks: [
        'FanDuel',
        'DraftKings',
        'BetMGM',
        'Caesars',
        'Pinnacle',
        'Polymarket',
        'Circa',
        'BetOnline',
        'Kalshi',
        'NoVigApp'
      ],
      minOdds: -9999,
      maxOdds: 9999,
      minValue: 0,
      maxHoursAway: 48,
      isLive: false
    });
  } catch (error) {
    process.stderr.write(`[propprofessor-mcp] Tennis +EV fallback query failed: ${error?.message || error}\n`);
    return {
      ok: true,
      result: [],
      league: 'Tennis',
      resultMeta: { debugEnabled: false, source: 'fallback_empty' },
      freshness: { rowCount: rows.length, newestAgeMs: 0, oldestAgeMs: 0, staleCount: 0, stale: false },
      warning: 'No tennis data available from either /screen or +EV endpoint'
    };
  }

  const evCandidates = Array.isArray(evResult)
    ? evResult.filter((row) => String(row.league || '').toLowerCase() === 'tennis')
    : [];

  const requestedMarket = marketResolution.single || null;
  const marketFamilyCandidates = requestedMarket
    ? evCandidates.filter((row) => {
        const rowFamily = getTennisMarketFamily(row);
        const requestedFamilies = normalizeTennisMarketQuery(requestedMarket).map((m) =>
          getTennisMarketFamily({ market: m })
        );
        return rowFamily !== null && requestedFamilies.includes(rowFamily);
      })
    : evCandidates;

  const cardWindowCandidates = filterTennisRowsByCardWindow(marketFamilyCandidates, args.cardWindow);

  if (!cardWindowCandidates.length) {
    return {
      ok: true,
      result: [],
      league: 'Tennis',
      resultMeta: { debugEnabled: false, source: 'fallback_empty' },
      freshness: { rowCount: rows.length, newestAgeMs: 0, oldestAgeMs: 0, staleCount: 0, stale: false },
      warning: '/screen returned only Polymarket odds and +EV endpoint has no tennis candidates in the requested card window'
    };
  }

  const ranked = await enrichTennisEvCandidates(cardWindowCandidates, client, {
    preferredBook,
    limit: getLimit(args),
    lookbackHours: getLookbackHours(args),
    requestedMarket
  });

  return {
    ok: true,
    result: ranked,
    league: 'Tennis',
    freshness: { rowCount: rows.length, newestAgeMs: 0, oldestAgeMs: 0, staleCount: 0, stale: false },
    source: '+ev_enriched',
    note: '/screen returned insufficient tennis data; results enriched from +EV endpoint with odds history'
  };
}

/**
 * @param {import('../../../lib/propprofessor-api').PropProfessorClient} client
 * @param {object} deps
 * @param {import('lru-cache')} deps.responseCache
 * @param {number} deps.responseCacheTtlMs
 */
function createTennisScreenHandler(client, { responseCache, responseCacheTtlMs }) {
  async function runTennisScreen(args = {}) {
    const preferredBook = String(args.book || 'Pinnacle').trim() || 'Pinnacle';
    const requestedBooks = normalizeBookList(args.books);
    const marketResolution = resolveMarkets(args, 'Tennis');
    const marketQuery = normalizeTennisMarketQuery(marketResolution.single);

    // Cache check for tennis screen
    const canCache = !args.compact && !args.fields && !args.include;
    const cacheKey = canCache
      ? buildCacheKey(
          'tennis',
          {
            ...args,
            books: requestedBooks.length ? requestedBooks : ALL_SCREEN_BOOKS,
            market: marketResolution.single
          },
          'Tennis'
        )
      : null;
    if (cacheKey) {
      const cached = responseCache.get(cacheKey);
      if (cached) {
        return { ...cached, resultMeta: { ...cached.resultMeta, cached: true } };
      }
    }

    const queryFn =
      typeof client.queryScreenOdds === 'function'
        ? client.queryScreenOdds.bind(client)
        : client.queryScreenOddsBestComps.bind(client);

    const payloads = [];

    if (payloads.length === 0) {
      for (const market of marketQuery) {
        const payload = await queryFn({
          market,
          league: 'Tennis',
          books: ALL_SCREEN_BOOKS,
          is_live: false
        });
        payloads.push(payload);
      }
    }

    const rows = payloads.flatMap((payload) => extractScreenRows(payload));

    const hasScreenBooks = rows.some((row) => {
      const text = JSON.stringify(row || '');
      return (
        text.includes('"Pinnacle"') ||
        text.includes('"Circa"') ||
        text.includes('"BetOnline"') ||
        text.includes('"Kalshi"')
      );
    });
    const hasScreenConsensus = rows.some((row) => {
      const text = JSON.stringify(row || '');
      return text.includes('"consensus"') || text.includes('"ev"') || text.includes('"value"');
    });

    if (hasScreenBooks || hasScreenConsensus) {
      const screenResult = await buildRankedScreenResponseShared({
        client,
        payloads,
        args,
        league: 'Tennis',
        focusBook: preferredBook,
        rankRows: (hydratedRows, { debug: rankDebug } = {}) =>
          rankTennisScreenRows(hydratedRows, {
            limit: getLimit(args),
            preferredBook,
            includeAll: getIncludeAll(args),
            maxAgeMs: getMaxAgeMs(args),
            debug: rankDebug,
            requirePreferredBook: requestedBooks.length > 0,
            playableOnly: args.playableOnly === true
          })
      });
      if (screenResult?.result) {
        await correctTennisTimes(screenResult.result);
      }
      if (marketResolution.aliasesUsed.length) {
        screenResult.resultMeta = {
          ...screenResult.resultMeta,
          markets_alias_used: marketResolution.aliasesUsed
        };
      }
      if (cacheKey) {
        const hasResults = Array.isArray(screenResult.result) && screenResult.result.length > 0;
        const hasError = screenResult.error || (screenResult.resultMeta && screenResult.resultMeta.error);
        if (hasResults && !hasError) {
          responseCache.set(cacheKey, screenResult, responseCacheTtlMs);
        }
      }
      return screenResult;
    }

    return runTennisEvFallback({
      client,
      args,
      rows,
      marketResolution,
      preferredBook
    });
  }

  return { runTennisScreen };
}

module.exports = { createTennisScreenHandler, filterTennisRowsByCardWindow };
