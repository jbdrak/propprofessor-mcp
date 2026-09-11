'use strict';

/**
 * Pricing handler: find_best_price.
 */

const { ok } = require('../../../lib/response-envelope');

function createPricingHandlers(client, _ctx) {
  return {
    async find_best_price(args = {}) {
      const { resolveMarkets } = require('./handler-utils');
      const { extractScreenRows } = require('../../../lib/screen-parser');
      const { findBestPrice } = require('../../../lib/ssb-best-price');
      const { normalizeBookList } = require('../../../lib/ssb-mcp-ranked-screen');

      const league = args.league || 'NBA';
      const marketResolution = resolveMarkets(args, league);
      const market = marketResolution.single;
      const excludeSet = new Set(normalizeBookList(args.excludeBooks).map((b) => b.toLowerCase()));
      const includeBooks = Array.isArray(args.books) ? args.books : undefined;
      const queryBooks = includeBooks
        ? excludeSet.size
          ? includeBooks.filter((b) => !excludeSet.has(String(b).toLowerCase()))
          : includeBooks
        : includeBooks;
      const payload = await client.queryScreenOddsBestComps({
        market,
        league,
        games: Array.isArray(args.games) ? args.games : [],
        participants: Array.isArray(args.participants) ? args.participants : [],
        books: queryBooks,
        is_live: false
      });
      const rows = extractScreenRows(payload);
      const result = findBestPrice(rows, { game: args.game, market, selection: args.selection, books: queryBooks });
      if (marketResolution.aliasesUsed.length) {
        result.markets_alias_used = marketResolution.aliasesUsed;
      }
      return ok(result);
    }
  };
}

module.exports = { createPricingHandlers };
