'use strict';

const { americanOddsToImpliedProbability, average } = require('./propprofessor-shared-utils');
const {
  classifyConsensusStrength,
  classifyExecutionQuality,
  summarizeComparisonBooks,
  summarizeSupportBooks
} = require('./screen-summary');
const { getScreenSelection, getResolvedScreenSelection, resolveExtractedScreenSide } = require('./selection-resolver');
const DEBUG = process.env.PROPPROFESSOR_DEBUG === 'true';

/**
 * Reject a consensus edge that is an artifact of a single off-market
 * execution-book price. Real sharp edges are < ~8% and backed by >= 2 books.
 * A -185 "preferred" vs -4900 "consensus" is a stale price, not value.
 */
// @ts-expect-error
function isEdgePlausible({ consensusEdge, targetOdds, bestAvailableOdds } = {}) {
  if (!Number.isFinite(consensusEdge)) return true; // null/NaN edge: not our concern
  if (Math.abs(consensusEdge) > 8) return false; // beyond any real sharp-edge band
  if (Number.isFinite(targetOdds) && Number.isFinite(bestAvailableOdds)) {
    if (Math.abs(targetOdds - bestAvailableOdds) > 300) return false; // off-market / stale price
  }
  // A single-comp edge is thin but not necessarily phantom (e.g. focus-book
  // fallback rows legitimately have 1 comp). The spread guard above catches
  // the real stale-price phantoms, so we don't reject on consensusBookCount here.
  return true;
}

/**
 * Resolve the odds key for a side, trying the alternate key if the resolved
 * side's odds aren't finite on the target book.
 */
function resolveOddsKey(preferredOdds, initialKey) {
  let oddsKey = initialKey;
  let resolvedOdds = preferredOdds[oddsKey];
  if (!Number.isFinite(resolvedOdds)) {
    const alternateKey = oddsKey === 'odds1' ? 'odds2' : 'odds1';
    if (Number.isFinite(preferredOdds[alternateKey])) {
      oddsKey = alternateKey;
      resolvedOdds = preferredOdds[alternateKey];
    }
  }
  return { oddsKey, resolvedOdds };
}

/**
 * Build comparison books list from an odds map, excluding the resolved book.
 */
function computeComparisonBooks(oddsMap, resolvedBook) {
  return Object.entries(oddsMap || {})
    .filter(([book]) => book !== resolvedBook)
    .map(([book, odds]) => ({ book, odds: odds || {} }));
}

/**
 * Compute consensus probability, edge, and execution quality from comparison books.
 */
function computeRowConsensus(compBooks, oddsKey, resolvedOdds) {
  const preferredProb = americanOddsToImpliedProbability(resolvedOdds);
  const consensusProb = average(compBooks.map((item) => americanOddsToImpliedProbability(item.odds[oddsKey])));
  const hasConsensus = Number.isFinite(preferredProb) && Number.isFinite(consensusProb);
  const comparisonOdds = compBooks.map((item) => item.odds[oddsKey]);
  const finiteComparisonOdds = comparisonOdds.filter(Number.isFinite);
  const bestAvailableOdds = finiteComparisonOdds.length ? Math.max(...finiteComparisonOdds) : null;
  const rawConsensusEdge = hasConsensus ? (consensusProb - preferredProb) * 100 : null;
  const edgePlausible = isEdgePlausible({
    consensusEdge: rawConsensusEdge,
    consensusBookCount: compBooks.filter((item) =>
      Number.isFinite(americanOddsToImpliedProbability(item.odds[oddsKey]))
    ).length,
    targetOdds: resolvedOdds,
    bestAvailableOdds
  });
  const consensusEdge = edgePlausible ? rawConsensusEdge : null;
  const executionQuality = classifyExecutionQuality({ targetOdds: resolvedOdds, comparisonOdds });
  const consensusBookCount = compBooks.filter((item) =>
    Number.isFinite(americanOddsToImpliedProbability(item.odds[oddsKey]))
  ).length;
  return {
    preferredProb,
    consensusProb,
    hasConsensus,
    bestAvailableOdds,
    consensusEdge,
    executionQuality,
    consensusBookCount,
    edgePlausible
  };
}

/**
 * Compute market and support book summaries from comparison books.
 */
function computeRowSupportBooks(compBooks, oddsKey) {
  const marketSummary = summarizeComparisonBooks(compBooks, oddsKey);
  const supportSummary = summarizeSupportBooks(compBooks, oddsKey);
  return { marketSummary, supportSummary };
}

/**
 * Build the common consensus/book enrichment fields shared across both
 * expandScreenRow paths. Callers must set participant/selection/pick
 * themselves (they differ between the selections and legacy paths).
 */
function buildRowEnrichment({
  row,
  resolvedBook,
  resolvedOdds,
  focusBookMissing,
  focusBookMissingReason,
  edgePlausible,
  marketSummary,
  supportSummary,
  consensusEdge,
  hasConsensus,
  consensusBookCount,
  bestAvailableOdds,
  executionQuality
}) {
  return {
    ...row,
    book: resolvedBook,
    odds: resolvedOdds,
    currentOdds: resolvedOdds,
    consensusEdge,
    hasConsensus,
    edgeSanityFlag: edgePlausible ? 'ok' : 'implausible',
    focusBookMissing,
    focusBookMissingReason: focusBookMissing ? `no price for ${focusBookMissingReason}` : null,
    consensusBookCount,
    consensusStrength: classifyConsensusStrength(consensusBookCount),
    compDataMissing: !focusBookMissing && consensusBookCount === 0,
    marketBookCount: marketSummary.marketBookCount,
    marketBooks: marketSummary.marketBooks,
    supportBookCount: supportSummary.supportBookCount,
    supportBooks: supportSummary.supportBooks,
    targetBookOdds: resolvedOdds,
    bestAvailableOdds,
    executionQuality
  };
}

/**
 * Dollar liquidity for a resolved odds side, from the book's odds entry.
 * Real /screen payloads carry `liquidity1`/`liquidity2` per book — the
 * dollar depth on each side. The value MUST track the resolved oddsKey so
 * the opposite side's liquidity is never assigned to the selected side.
 * @param {Object} [bookOdds] - Per-book odds entry ({ odds1, odds2, liquidity1, liquidity2 }).
 * @param {string} [oddsKey] - Resolved odds key ('odds1' | 'odds2').
 * @returns {number|null} Finite dollar liquidity for that side, else null.
 */
function liquidityForResolvedSide(bookOdds, oddsKey) {
  if (!bookOdds || typeof bookOdds !== 'object') return null;
  const liquidityKey = oddsKey === 'odds2' ? 'liquidity2' : 'liquidity1';
  const raw = bookOdds[liquidityKey];
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Expand a screen row by resolving book, selection, side, and computing consensus/probability data.
 * @param {Object} row - Row data.
 * @param {{ preferredBook: string, requirePreferredBook?: boolean }} [options={}] - Options: preferred book name; requirePreferredBook drops rows whose preferred book has no price.
 * @returns {Array<Object>} Expanded row(s) with computed fields.
 */
// @ts-expect-error
function expandScreenRow(row, { preferredBook = 'NoVigApp', requirePreferredBook = false } = {}) {
  // v2.1.6: extractScreenRows produces per-book rows from a normalized
  // upstream payload (selections.null was lifted to the top level, and
  // the full odds map was overridden with the per-book number). The ranker
  // reads row.selections to find the full map; when that's undefined we
  // reconstruct the lifted shape from the top-level fields + allBookOdds
  // so the main path can find the map and compute real consensus.
  if (!row?.selections && row?.allBookOdds && typeof row.allBookOdds === 'object') {
    row = {
      ...row,
      selections: {
        null: {
          selection1: row.selection1,
          participant1: row.participant1,
          selectionType1: row.selectionType1,
          selection1Id: row.selection1Id,
          line1: row.line1,
          selection2: row.selection2,
          participant2: row.participant2,
          selectionType2: row.selectionType2,
          selection2Id: row.selection2Id,
          line2: row.line2,
          odds: row.allBookOdds
        }
      }
    };
  }
  if (row?.selections && (row?.book || row?.sportsbook)) {
    const rowBook = String(row.book || row.sportsbook || '').trim();
    const selection = getResolvedScreenSelection(row);
    const oddsMap = selection?.odds || {};
    const preferredAvailable = Boolean(oddsMap?.[preferredBook]);
    if (preferredAvailable && rowBook && rowBook !== preferredBook) {
      if (DEBUG) {
        process.stderr.write(
          `[screen-ranker] expandScreenRow: dropped rowBook="${rowBook}" != preferredBook="${preferredBook}" ` +
            `(preferred is available in oddsMap)\n`
        );
      }
      return [];
    }
    if (requirePreferredBook && !preferredAvailable) {
      return [];
    }
    const resolvedBook = preferredAvailable ? preferredBook : rowBook || preferredBook;
    const focusBookMissing = !preferredAvailable && resolvedBook !== preferredBook;
    const focusBookMissingReason = focusBookMissing ? `no price for ${preferredBook}` : null;
    const preferredOdds =
      oddsMap?.[resolvedBook] || oddsMap?.[preferredBook] || oddsMap?.[rowBook] || oddsMap?.NoVigApp;
    const side = resolveExtractedScreenSide(row, selection);
    if (!preferredOdds || !side) {
      return [
        {
          ...row,
          book: resolvedBook,
          focusBookMissing,
          focusBookMissingReason
        }
      ];
    }

    const { oddsKey, resolvedOdds } = resolveOddsKey(preferredOdds, side.oddsKey);
    const compBooks = computeComparisonBooks(oddsMap, resolvedBook);
    const { edgePlausible, consensusEdge, consensusBookCount, bestAvailableOdds, executionQuality, hasConsensus } =
      computeRowConsensus(compBooks, oddsKey, resolvedOdds);
    const { marketSummary, supportSummary } = computeRowSupportBooks(compBooks, oddsKey);

    return [
      {
        ...buildRowEnrichment({
          row,
          resolvedBook,
          resolvedOdds,
          focusBookMissing,
          focusBookMissingReason: preferredBook,
          edgePlausible,
          marketSummary,
          supportSummary,
          consensusEdge,
          hasConsensus,
          consensusBookCount,
          bestAvailableOdds,
          executionQuality
        }),
        // Re-derive from the odds map + resolved side so a side swap in
        // resolveOddsKey can never leak the opposite side's dollar depth.
        liquidityUsd: liquidityForResolvedSide(preferredOdds, oddsKey),
        participant: side.selectionLabel || row.participant || '',
        selection: side.selectionLabel || row.selection || row.pick || '',
        pick: side.selectionLabel || row.pick || row.selection || ''
      }
    ];
  }

  const selection = getScreenSelection(row);
  const oddsMap = selection?.odds;
  const preferredBookAvailable = Boolean(oddsMap?.[preferredBook]);
  const preferredOdds = preferredBookAvailable ? oddsMap?.[preferredBook] : oddsMap?.NoVigApp;
  const focusBookMissingLegacy = !preferredBookAvailable && Boolean(oddsMap?.NoVigApp) && preferredBook !== 'NoVigApp';
  if (!preferredOdds) {
    if (requirePreferredBook) return [];
    return [row];
  }

  const compBooks = Object.entries(oddsMap)
    .filter(([book]) => book !== preferredBook)
    .map(([book, odds]) => ({ book, odds: odds || {} }));

  function buildSide(selectionLabel, fallbackParticipant, oddsKey) {
    const { oddsKey: resolvedKey, resolvedOdds } = resolveOddsKey(preferredOdds, oddsKey);
    const { edgePlausible, consensusEdge, consensusBookCount, bestAvailableOdds, executionQuality, hasConsensus } =
      computeRowConsensus(compBooks, resolvedKey, resolvedOdds);
    const { marketSummary, supportSummary } = computeRowSupportBooks(compBooks, resolvedKey);
    const enrichment = buildRowEnrichment({
      row,
      resolvedBook: preferredBook,
      resolvedOdds,
      focusBookMissing: focusBookMissingLegacy,
      focusBookMissingReason: preferredBook,
      edgePlausible,
      marketSummary,
      supportSummary,
      consensusEdge,
      hasConsensus,
      consensusBookCount,
      bestAvailableOdds,
      executionQuality
    });
    return {
      ...enrichment,
      // Dollar depth follows the resolved side (odds1 → liquidity1, odds2 → liquidity2).
      liquidityUsd: liquidityForResolvedSide(preferredOdds, resolvedKey),
      participant: selectionLabel || fallbackParticipant || ''
    };
  }

  return [
    buildSide(selection?.selection1 || selection?.participant1, row.participant || row.homeTeam, 'odds1'),
    buildSide(selection?.selection2 || selection?.participant2, row.awayTeam, 'odds2')
  ];
}

module.exports = { expandScreenRow, isEdgePlausible };
