'use strict';

/**
 * Screen ranking handler: runScreenRankedImpl.
 * Extracted from createMcpHandlers() in handlers.js.
 *
 * Keeps original (client, args) signature for backward compatibility.
 * ctx captured via createScreenHandlers factory closure.
 */

const {
  normalizeBookList,
  buildRankedScreenResponse: buildRankedScreenResponseShared,
  getIncludeAll,
  getLimit,
  getMaxAgeMs
} = require('../../../lib/propprofessor-mcp-ranked-screen');
const { resolveMarkets } = require('./handler-utils');
const { getSharpBookComparisonSet, ALL_SCREEN_BOOKS, uniqueBooks } = require('../../../lib/propprofessor-sharp-books');
const { rankLeagueScreenRows } = require('../../../lib/screen-ranker');
const { getGameContext } = require('../../../lib/propprofessor-game-context');
const { runResearchOnTopRows } = require('../../../lib/propprofessor-research-runner');
const { formatScreenRankedMinimal, formatScreenRankedStandard } = require('../../../lib/propprofessor-formatter');
const {
  filterRowsByKaiCall,
  filterRowsByMinEV,
  filterRowsByMovement
} = require('../../../lib/propprofessor-row-filter');
const { sortRows } = require('../../../lib/propprofessor-sort-utils');

function createScreenHandlers(client, ctx) {
  /**
   * Run a screen-ranked query for a single league+market pair.
   * Called by screen_ranked, get_play_details, validate_play.
   */
  async function runScreenRankedImpl(client, args = {}) {
    const requestedBooks = normalizeBookList(args.books);
    const league = args.league || 'NBA';
    const marketResolution = resolveMarkets(args, league);
    const market = marketResolution.single;
    const focusBook = requestedBooks.length ? requestedBooks[0] : '';
    const sharpBookSet = getSharpBookComparisonSet({ league, market });
    const leagueUpper = (league || '').toUpperCase();
    const augmentedBooks = !['NBA', 'NFL', 'MLB'].includes(leagueUpper)
      ? ALL_SCREEN_BOOKS
      : uniqueBooks([...requestedBooks, ...sharpBookSet]);
    const payload = await client.queryScreenOddsBestComps({
      market,
      league,
      games: Array.isArray(args.games) ? args.games : [],
      participants: Array.isArray(args.participants) ? args.participants : [],
      books: augmentedBooks,
      is_live: false
    });
    const response = await buildRankedScreenResponseShared({
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
    if (args.includeResearch === true && Array.isArray(response.result) && response.result.length) {
      const researchLimit = Number.isFinite(Number(args.researchLimit))
        ? Math.max(1, Math.min(50, Number(args.researchLimit)))
        : 10;
      const research = await runResearchOnTopRows({
        rows: response.result,
        limit: researchLimit,
        playerContextFn: ctx.handlers.player_context,
        gameContextFn: (opts) =>
          getGameContext({
            sport: opts.sport || opts.league,
            selection: opts.selection,
            game: opts.game,
            start: opts.start,
            market: opts.market
          })
      });
      response.research = research.results;
      response.resultMeta = {
        ...response.resultMeta,
        researchRunCount: research.results.length,
        researchPlayerContextCount: research.results.filter((r) => r.contextType === 'player').length,
        researchGameContextCount: research.results.filter((r) => r.contextType === 'game').length,
        researchRiskHighCount: research.results.filter((r) => r.riskFlag === 'high').length,
        researchCachedCount: research.results.filter((r) => r.cached).length
      };
      if (args.riskDowngrade === true) {
        const beforeCount = response.result.length;
        const highRiskPlayers = new Set(
          research.results.filter((r) => r.riskFlag === 'high').map((r) => String(r.player || '').toLowerCase())
        );
        response.result = response.result.filter((row) => {
          const player = String(row.selection || row.participant || '').toLowerCase();
          return !highRiskPlayers.has(player);
        });
        response.resultMeta = {
          ...response.resultMeta,
          riskDowngradedCount: beforeCount - response.result.length
        };
      }
    }

    if (Array.isArray(response.result)) {
      response.result = sortRows(
        filterRowsByMinEV(
          filterRowsByMovement(filterRowsByKaiCall(response.result, args.kaiCall), args.movement),
          args.minEV
        ),
        {
          sortBy: args.sortBy,
          sortDir: args.sortDir
        }
      );
    }

    const verbosity = String(args.verbosity || 'full').toLowerCase();
    if (verbosity === 'minimal') return formatScreenRankedMinimal(response);
    if (verbosity === 'standard') return formatScreenRankedStandard(response);
    return response;
  }

  return {
    runScreenRankedImpl
  };
}

module.exports = { createScreenHandlers };
