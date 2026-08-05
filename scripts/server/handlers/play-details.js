'use strict';

/**
 * Play details handler: runGetPlayDetailsImpl.
 * Extracted from createMcpHandlers() in handlers.js.
 */

const { resolveMarkets } = require('./handler-utils');
const {
  buildRankedScreenResponse: buildRankedScreenResponseShared,
  normalizeBookList
} = require('../../../lib/propprofessor-mcp-ranked-screen');
const { getSharpBookComparisonSet, ALL_SCREEN_BOOKS, uniqueBooks } = require('../../../lib/propprofessor-sharp-books');
const { rankLeagueScreenRows } = require('../../../lib/screen-ranker');
const { normalizeTennisMarketQuery } = require('../../../lib/screen-tennis');
const { formatGetPlayDetailsMinimal, formatGetPlayDetailsStandard } = require('../../../lib/propprofessor-formatter');

function createPlayDetailsHandlers(_client, _ctx) {
  function getDefaultMarketsForLeague(league, _targetBooks) {
    return require('../../../lib/propprofessor-market-registry').getMarketsForSport(league, _targetBooks);
  }

  async function runGetPlayDetailsImpl(client, args = {}) {
    const league = String(args.league || '').trim();
    const rawGameIds = Array.isArray(args.gameIds) ? args.gameIds : [];
    const gameIds = Array.from(new Set(rawGameIds.map((id) => String(id == null ? '' : id).trim()).filter(Boolean)));
    if (!league || !gameIds.length) {
      /** @type {Error & {code?: string, category?: string, status?: number}} */
      const error = new Error('league and gameIds are required.');
      error.code = 'MISSING_PARAMS';
      error.category = 'validation';
      error.status = 400;
      throw error;
    }
    if (!args.market) {
      const markets = getDefaultMarketsForLeague(league);
      const perMarket = await Promise.all(markets.map((m) => runGetPlayDetailsImpl(client, { ...args, market: m })));
      const combined = [];
      const metaList = [];
      let firstError = null;
      for (const r of perMarket) {
        if (r && Array.isArray(r.result)) combined.push(...r.result);
        if (r && r.resultMeta) {
          metaList.push(r.resultMeta);
          if (r.resultMeta.errorCode && !firstError) {
            firstError = { errorCode: r.resultMeta.errorCode, error: r.resultMeta.error };
          }
        }
      }
      const merged = {
        ok: true,
        result: combined,
        resultMeta: {
          queryGameIds: gameIds,
          matchedRows: combined.length,
          marketsQueried: markets,
          perMarket: metaList,
          ...(firstError || {})
        }
      };
      const verbosity = String(args.verbosity || 'full').toLowerCase();
      if (verbosity === 'minimal') return formatGetPlayDetailsMinimal(merged);
      if (verbosity === 'standard') return formatGetPlayDetailsStandard(merged);
      return merged;
    }
    const marketResolution = resolveMarkets(args, league);
    let market = marketResolution.single;
    const requestedBooks = normalizeBookList(args.books);
    if (league === 'Tennis') {
      const tennisMarkets = normalizeTennisMarketQuery(market);
      market = tennisMarkets[0] || market;
    }
    const focusBook = requestedBooks.length ? requestedBooks[0] : '';
    const sharpBookSetDetail = getSharpBookComparisonSet({ league, market });
    const leagueUpperDetail = (league || '').toUpperCase();
    const augmentedBooks = !['NBA', 'NFL', 'MLB'].includes(leagueUpperDetail)
      ? ALL_SCREEN_BOOKS
      : uniqueBooks([...requestedBooks, ...sharpBookSetDetail]);
    const excludeSet = new Set(normalizeBookList(args.excludeBooks).map((b) => b.toLowerCase()));
    const applyExcludes = (list) =>
      excludeSet.size ? list.filter((b) => !excludeSet.has(String(b).toLowerCase())) : list;
    const augmentedBooksExcluded = applyExcludes(augmentedBooks);

    // Relaxed gameId mode (internal, used by validate_play's timestamp-drift
    // fallback): the requested gameId embeds a Unix start timestamp and the same
    // matchup can surface under a NEW timestamp. Instead of filtering by the
    // stale gameId, query by participants (narrow scan) and return every row so
    // the caller can reconcile by identity + date. Fail closed when no
    // participants are supplied — never run a full league+market scan here.
    const relaxedGameIdMatch = args.relaxedGameIdMatch === true;
    const relaxedParticipants = Array.isArray(args.participants) ? args.participants : [];
    if (relaxedGameIdMatch && !relaxedParticipants.length) {
      return {
        ok: true,
        result: [],
        resultMeta: {
          queryGameIds: gameIds,
          matchedRows: 0,
          error: 'relaxedGameIdMatch requires participants',
          errorCode: 'RELAXED_MATCH_REQUIRES_PARTICIPANTS'
        }
      };
    }

    let payload;
    try {
      payload = await client.queryScreenOddsBestComps({
        market,
        league,
        games: relaxedGameIdMatch ? [] : gameIds,
        participants: relaxedParticipants,
        books: augmentedBooksExcluded,
        is_live: Boolean(args.live || args.is_live)
      });
    } catch (err) {
      return {
        ok: true,
        result: [],
        resultMeta: {
          queryGameIds: gameIds,
          matchedRows: 0,
          error: err?.message || String(err),
          errorCode: 'SCREEN_QUERY_FAILED'
        }
      };
    }
    let response;
    try {
      response = await buildRankedScreenResponseShared({
        client,
        payloads: [payload],
        args: { ...args, compact: false, skipHistory: false, historySportsbooks: augmentedBooksExcluded },
        league,
        focusBook,
        rankRows: (hydratedRows, options = {}) => {
          const debug = Boolean(/** @type {any} */ (options).debug);
          return rankLeagueScreenRows(hydratedRows, {
            league,
            market,
            limit: gameIds.length * 4,
            books: augmentedBooks,
            includeAll: true,
            debug
          });
        }
      });
    } catch (err) {
      return {
        ok: true,
        result: [],
        resultMeta: {
          queryGameIds: gameIds,
          matchedRows: 0,
          error: err?.message || String(err),
          errorCode: 'RANK_PIPELINE_FAILED'
        }
      };
    }

    if (marketResolution.aliasesUsed.length) {
      response.resultMeta = {
        ...response.resultMeta,
        markets_alias_used: marketResolution.aliasesUsed
      };
    }

    const normalizeGameId = (id) =>
      String(id || '')
        .replace(/:\\d{10,}$/, '')
        .trim();
    const normalizedRequested = gameIds.map(normalizeGameId);
    const gameIdSet = new Set(normalizedRequested);
    const safeResult = Array.isArray(response.result) ? response.result : [];
    const filtered = relaxedGameIdMatch
      ? safeResult
      : safeResult.filter((row) => gameIdSet.has(normalizeGameId(row && row.gameId)));

    const fallbackRows = Array.isArray(response.focusBookMissingRows) ? response.focusBookMissingRows : [];
    const merged = [...filtered];
    for (const fbRow of fallbackRows) {
      if (relaxedGameIdMatch || gameIdSet.has(normalizeGameId(fbRow && fbRow.gameId))) {
        merged.push({ ...fbRow, __focusBookMissing: true });
      }
    }
    response.result = merged;

    for (const row of response.result) {
      const matrix = {};
      const sb = Array.isArray(row?.sportsbookData) ? row.sportsbookData : [];
      for (const entry of sb) {
        const book = String(entry?.book || '').trim();
        const odds = Number(entry?.odds ?? entry?.noVigOdds);
        if (book && Number.isFinite(odds)) matrix[book] = odds;
      }
      const selections = row?.selections && typeof row.selections === 'object' ? row.selections : {};
      for (const sel of Object.values(selections)) {
        const oddsMap = sel?.odds && typeof sel.odds === 'object' ? sel.odds : {};
        for (const [book, v] of Object.entries(oddsMap)) {
          if (!matrix[book] && Number.isFinite(Number(v?.odds1 ?? v))) {
            matrix[book] = Number(v.odds1 ?? v);
          }
        }
      }
      if (Object.keys(matrix).length) row.oddsMatrix = matrix;
    }

    for (const row of response.result) {
      if (row.sharpBookMovementConfirmed) continue;
      const label = String(row.movementLabel || '').toLowerCase();
      if (label === 'supportive') {
        const sb = Array.isArray(row?.sportsbookData) ? row.sportsbookData : [];
        const sharpBookNames = new Set(sharpBookSetDetail.map((b) => b.toLowerCase()));
        const hasSharpBookOdds = sb.some((entry) => sharpBookNames.has(String(entry?.book || '').toLowerCase()));
        if (hasSharpBookOdds) {
          row.sharpBookMovementConfirmed = true;
          const sourceEntry = sb.find((entry) => sharpBookNames.has(String(entry?.book || '').toLowerCase()));
          row.sharpBookMovementSource = sourceEntry?.book || sharpBookSetDetail[0] || null;
        }
      }
    }

    response.focusBookMissingRows = undefined;
    response.resultMeta = {
      ...response.resultMeta,
      queryGameIds: gameIds,
      matchedRows: merged.length,
      ...(relaxedGameIdMatch ? { relaxedGameIdMatch: true } : {})
    };
    const verbosity = String(args.verbosity || 'full').toLowerCase();
    if (verbosity === 'minimal') return formatGetPlayDetailsMinimal(response);
    if (verbosity === 'standard') return formatGetPlayDetailsStandard(response);
    return response;
  }

  return {
    runGetPlayDetailsImpl
  };
}

module.exports = { createPlayDetailsHandlers };
