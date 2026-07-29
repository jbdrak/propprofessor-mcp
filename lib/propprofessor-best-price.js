'use strict';

const { compactRow } = require('./propprofessor-shared-utils');

/**
 * Best Price Scanner
 *
 * Line shopping tool: takes a screen payload and returns every book's odds
 * for a specific play, sorted best to worst with spread analysis.
 */

function normalizeGameKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeMarketKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeSelectionKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function extractAllBookOddsFromPayload(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.game_data)
      ? payload.game_data
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.results)
          ? payload.results
          : Array.isArray(payload?.rows)
            ? payload.rows
            : [];
  return rows;
}

function matchPlay(row, { game, market, selection }) {
  const rowGame = normalizeGameKey(
    row.game || row.matchup || (row.homeTeam && row.awayTeam ? `${row.awayTeam} vs ${row.homeTeam}` : '')
  );
  const rowMarket = normalizeMarketKey(row.market || row.playType || '');
  const rowSelection = normalizeSelectionKey(row.participant || row.selection || row.pick || '');

  const targetGame = normalizeGameKey(game);
  const targetMarket = normalizeMarketKey(market);
  const targetSelection = normalizeSelectionKey(selection);

  if (targetGame && !rowGame.includes(targetGame) && !targetGame.includes(rowGame)) return false;
  if (targetMarket && !rowMarket.includes(targetMarket) && !targetMarket.includes(rowMarket)) return false;
  if (targetSelection && !rowSelection.includes(targetSelection) && !targetSelection.includes(rowSelection))
    return false;

  return true;
}

function collectBookOddsFromRow(row, selectionFilter) {
  const results = [];
  const selections = row.selections && typeof row.selections === 'object' ? Object.values(row.selections) : [];

  if (!selections.length) {
    // Flat row - single book's odds on this row
    if (row.book && (row.odds !== undefined || row.currentOdds !== undefined)) {
      results.push({
        book: row.book,
        odds: Number(row.odds ?? row.currentOdds),
        selection: row.participant || row.selection || row.pick || '',
        line: row.line ?? null,
        side: null
      });
    }
    return results;
  }

  const filterKey = selectionFilter ? normalizeSelectionKey(selectionFilter) : null;

  for (const selection of selections) {
    const oddsMap = selection?.odds && typeof selection.odds === 'object' ? selection.odds : {};
    const selection1Name = selection.selection1 || selection.participant1 || '';
    const selection2Name = selection.selection2 || selection.participant2 || '';

    // Determine which sides to include based on filter
    const includeSide1 =
      !filterKey ||
      normalizeSelectionKey(selection1Name).includes(filterKey) ||
      filterKey.includes(normalizeSelectionKey(selection1Name));
    const includeSide2 =
      !filterKey ||
      normalizeSelectionKey(selection2Name).includes(filterKey) ||
      filterKey.includes(normalizeSelectionKey(selection2Name));

    for (const [book, bookOdds] of Object.entries(oddsMap)) {
      if (!bookOdds || typeof bookOdds !== 'object') continue;

      if (includeSide1 && bookOdds.odds1 !== undefined && bookOdds.odds1 !== null) {
        results.push({
          book,
          odds: Number(bookOdds.odds1),
          selection: selection1Name,
          line: selection.line1 ?? null,
          side: 'home'
        });
      }
      if (includeSide2 && bookOdds.odds2 !== undefined && bookOdds.odds2 !== null) {
        results.push({
          book,
          odds: Number(bookOdds.odds2),
          selection: selection2Name,
          line: selection.line2 ?? null,
          side: 'away'
        });
      }
    }
  }

  return results;
}

function spreadFromBest(odds, bestOdds, oddsType) {
  if (!Number.isFinite(odds) || !Number.isFinite(bestOdds)) return null;
  if (oddsType === 'american') {
    // Return absolute spread in cents. For negative odds: -105 vs -110 = 5 cents.
    // For positive odds: +150 vs +130 = 20 cents.
    return Math.abs(odds - bestOdds);
  }
  return bestOdds - odds;
}

function isBetterOdds(candidate, current) {
  if (!Number.isFinite(candidate)) return false;
  if (!Number.isFinite(current)) return true;
  // Both positive: higher is better
  if (candidate > 0 && current > 0) return candidate > current;
  // Both negative: closer to 0 is better
  if (candidate < 0 && current < 0) return candidate > current;
  // Positive is always better than negative
  return candidate > 0 && current < 0;
}

/**
 * Find the best available price across all books for a specific play.
 *
 * @param {Array|Object} payload - Raw screen payload (array of rows or wrapped object)
 * @param {Object} options - Match criteria
 * @param {string} options.game - Game matchup or team name to match
 * @param {string} options.market - Market type (Moneyline, Spread, Total, etc.)
 * @param {string} options.selection - Player/team selection to match
 * @param {string[]} [options.books] - Optional book filter (show only these books)
 * @returns {Object} Sorted book odds with spread analysis
 */
function findBestPrice(
  payload,
  options = /** @type {{ game: string, market: string, selection: string, books?: string[] }} */ ({})
) {
  const { game, market, selection, books: bookFilter } = options;
  const rows = extractAllBookOddsFromPayload(payload);

  if (!rows.length) {
    return {
      ok: true,
      found: false,
      reason: 'empty_payload',
      match: { game, market, selection },
      bestPrice: null,
      allPrices: [],
      spread: null,
      bookCount: 0
    };
  }

  // Find matching rows
  const matchingRows = rows.filter((row) => matchPlay(row, { game, market, selection }));

  if (!matchingRows.length) {
    // Try broader matching - just selection
    const broadMatches = rows.filter((row) =>
      matchPlay(row, /** @type {{ game: any, market: any, selection: any }} */ ({ selection }))
    );
    if (!broadMatches.length) {
      return {
        ok: true,
        found: false,
        reason: 'no_match',
        match: { game, market, selection },
        bestPrice: null,
        allPrices: [],
        spread: null,
        bookCount: 0,
        hint: `Searched ${rows.length} rows. Try broader terms or check the exact spelling.`
      };
    }
    // Use broad matches but note it
    matchingRows.push(...broadMatches);
  }

  // Collect all book odds from matching rows, filtered by selection
  const allOdds = [];
  for (const row of matchingRows) {
    const bookOdds = collectBookOddsFromRow(row, selection);
    for (const entry of bookOdds) {
      // If book filter is set, only include those books
      if (Array.isArray(bookFilter) && bookFilter.length) {
        const filterLower = bookFilter.map((b) => String(b).toLowerCase());
        if (!filterLower.includes(entry.book.toLowerCase())) continue;
      }
      allOdds.push(entry);
    }
  }

  if (!allOdds.length) {
    return {
      ok: true,
      found: false,
      reason: 'no_book_odds',
      match: { game, market, selection },
      bestPrice: null,
      allPrices: [],
      spread: null,
      bookCount: 0
    };
  }

  // Deduplicate by book (keep best odds per book)
  const bookBest = new Map();
  for (const entry of allOdds) {
    const existing = bookBest.get(entry.book);
    if (!existing || isBetterOdds(entry.odds, existing.odds)) {
      bookBest.set(entry.book, entry);
    }
  }

  // Sort: best odds first (positive: higher first; negative: closer to 0 first)
  const sorted = Array.from(bookBest.values()).sort((a, b) => {
    if (a.odds > 0 && b.odds > 0) return b.odds - a.odds;
    if (a.odds < 0 && b.odds < 0) return b.odds - a.odds; // -128 > -130, so b - a puts -128 first
    return a.odds > 0 ? -1 : 1;
  });

  const bestOdds = sorted[0]?.odds;

  // Compute spread for each book
  const withSpread = sorted.map((entry) => ({
    ...entry,
    spreadFromBest: spreadFromBest(entry.odds, bestOdds, 'american')
  }));

  // BUGFIX (2026-06-21): add selectionRequested + selectionMatched so
  // agents can verify that the name resolution was correct. When the
  // user searches for "Trungelliti" and the system matches "Li", the
  // agent can detect the mismatch and try a different query.
  const allMatchedSelections = [...new Set(withSpread.map((e) => e.selection))];

  const worstOdds = sorted[sorted.length - 1]?.odds;
  const totalSpread = spreadFromBest(worstOdds, bestOdds, 'american');

  return {
    ok: true,
    found: true,
    match: { game, market, selection },
    selectionRequested: selection,
    selectionMatched: allMatchedSelections.length === 1 ? allMatchedSelections[0] : allMatchedSelections,
    bestPrice: withSpread[0] || null,
    // @ts-expect-error
    allPrices: /** @type {any[]} */ (withSpread).map(compactRow),
    spread: {
      best: bestOdds,
      worst: worstOdds,
      totalSpreadCents: Number.isFinite(totalSpread) ? totalSpread : null,
      bookCount: withSpread.length
    },
    bookCount: withSpread.length
  };
}

module.exports = {
  findBestPrice,
  extractAllBookOddsFromPayload,
  matchPlay,
  collectBookOddsFromRow,
  isBetterOdds,
  spreadFromBest
};
