'use strict';

const { americanOddsToImpliedProbability, mapWithConcurrency } = require('./propprofessor-shared-utils');
const { rankScreenRows } = require('./screen-ranker');
const { correctTennisTimes } = require('./propprofessor-tennis');

/**
 * Check if a row is a tennis row by examining league/sport fields and raw content.
 * @param {Object} row - Row data.
 * @returns {boolean} True if the row represents a tennis match.
 */
function isTennisRow(row) {
  const text = JSON.stringify(row || {}).toLowerCase();
  return (
    text.includes('tennis') ||
    String(row?.league || row?.sport || row?.gameType || '')
      .toLowerCase()
      .includes('tennis')
  );
}

/**
 * Normalize a tennis market query to an array of market names.
 * Maps common shorthand (e.g. 'ml', 'handicap', 'over/under') to canonical names.
 * @param {string} value - Raw market query.
 * @returns {string[]} Array of canonical market names.
 */
function normalizeTennisMarketQuery(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw || raw === 'moneyline' || raw === 'ml') return ['Moneyline'];
  // Set Handicap is a distinct backend market with set-level lines.
  if (raw === 'set handicap' || raw === 'set_handicap') return ['Set Handicap'];
  if (raw.includes('spread') || raw.includes('handicap')) {
    return ['Game Handicap'];
  }
  if (raw.includes('total') || raw.includes('over/under') || raw === 'ou') {
    return ['Total Games'];
  }
  return [String(value).trim()];
}

/**
 * Determine which tennis market family a row belongs to.
 * @param {Object} row - Row data with market field.
 * @returns {string|null} 'moneyline', 'spread', 'total', or null.
 */
function getTennisMarketFamily(row) {
  const market = String(row?.market || row?.marketType || '').toLowerCase();
  if (market === 'moneyline' || market === 'ml') return 'moneyline';
  if (market === 'set handicap') return 'set_handicap';
  if (market.includes('handicap') || market.includes('spread')) return 'spread';
  if (market.includes('total') || market.includes('over/under') || market === 'ou') return 'total';
  return null;
}

/**
 * Enrich tennis +EV candidates by fetching odds history and computing CLV proxy.
 * @param {Array<Object>} evCandidates - +EV candidate rows from the API.
 * @param {Object} client - PropProfessor API client with queryOddsHistory method.
 * @param {Object} [options={}] - Options object.
 * @param {string} [options.preferredBook='NoVigApp'] - Preferred execution book.
 * @param {number} [options.limit=12] - Max rows to return.
 * @param {number} [options.lookbackHours=24] - Odds history lookback window.
 * @returns {Promise<Array<Object>>} Enriched and ranked tennis candidates.
 */
async function enrichTennisEvCandidates(
  evCandidates,
  client,
  // @ts-expect-error
  { preferredBook = 'NoVigApp', limit = 12, lookbackHours = 24, requestedMarket = null } = {}
) {
  const sharpBooks = ['Pinnacle', 'Polymarket', 'Circa', 'BetOnline', 'Kalshi'];

  // Filter by requested market family if specified
  const familyFilter = requestedMarket ? normalizeTennisMarketQuery(requestedMarket) : null;
  const filteredCandidates = familyFilter
    ? evCandidates.filter((candidate) => {
        const candidateMarket = String(candidate.market || candidate.marketType || '').toLowerCase();
        return familyFilter.some((fm) => candidateMarket === fm.toLowerCase());
      })
    : evCandidates;

  // Per-candidate odds-history fetches are independent. Fan them out under
  // a bounded concurrency cap so a 30-candidate slate doesn't do 30 sequential
  // /odds_history_new round-trips. Concurrency-6 matches the cap used by
  // hydrateScreenRowsWithHistory in lib/propprofessor-screen-history.js, so
  // total backend pressure stays roughly the same as a non-tennis screen.
  const enriched = await mapWithConcurrency(
    filteredCandidates,
    async (candidate) => {
      const gameId = String(candidate.gameId || '');
      const selectionId = String(candidate.selectionId || '');

      let lineHistory = [];
      let openingOdds = null;
      let currentOdds = null;
      let clvProxyPct = null;

      if (gameId && selectionId) {
        try {
          const historyResponse = await client.queryOddsHistory({
            gameId,
            selectionId,
            sportsbooks: sharpBooks,
            lookbackHours
          });

          const historyItems = Array.isArray(historyResponse)
            ? historyResponse
            : Array.isArray(historyResponse?.data)
              ? historyResponse.data
              : Array.isArray(historyResponse?.history)
                ? historyResponse.history
                : [];

          if (historyItems.length >= 2) {
            // Normalize odds field so both the enrichment's CLV computation
            // AND summarizeSharpMovement (called downstream by rankScreenRows)
            // can parse the same data — the API sometimes returns americanOdds
            // instead of odds.
            lineHistory = historyItems.map((item) => ({
              ...item,
              odds: item.odds ?? item.americanOdds
            }));
            const first = lineHistory[0];
            const last = lineHistory[lineHistory.length - 1];
            openingOdds = Number(first?.americanOdds ?? first?.odds) || null;
            currentOdds = Number(last?.americanOdds ?? last?.odds) || null;

            const openingProb = americanOddsToImpliedProbability(openingOdds);
            const currentProb = americanOddsToImpliedProbability(currentOdds);
            if (Number.isFinite(openingProb) && Number.isFinite(currentProb)) {
              clvProxyPct = (openingProb - currentProb) * 100;
            }
          }
        } catch {
          // History fetch failed -- candidate still usable, just lacks movement data
        }
      }

      const sportsbookData = Array.isArray(candidate.sportsbookData) ? candidate.sportsbookData : [];
      const consensusBookCount = sportsbookData.filter((sb) => {
        const sbOdds = Number(sb?.odds ?? sb?.noVigOdds);
        return Number.isFinite(sbOdds) && sbOdds !== -2400;
      }).length;

      const targetBookEntry = sportsbookData.find((sb) => String(sb?.book || '').trim() === preferredBook);
      const targetBookOdds = targetBookEntry ? Number(targetBookEntry.odds) : null;

      const bestCompEntry =
        sportsbookData
          .filter((sb) => sharpBooks.includes(String(sb?.book || '').trim()))
          .sort((a, b) => Number(b?.odds ?? 0) - Number(a?.odds ?? 0))[0] || null;

      // Compute movement disposition so tiering logic has the signal.
      // Tennis enrichment uses a simpler model than the full multi-window
      // computeMovementDisposition since we only have single-book history.
      let movementDisposition = 'insufficient';
      if (lineHistory.length >= 2 && clvProxyPct !== null) {
        if (clvProxyPct > 0.5) movementDisposition = 'supportive_bouncy';
        else if (clvProxyPct < -0.5) movementDisposition = 'adverse_full';
        // else: flat movement (clvProxyPct ≈ 0) — stays 'insufficient'
      }

      return {
        ...candidate,
        league: 'Tennis',
        book: preferredBook,
        consensusBookCount,
        sportsbookData,
        lineHistory,
        lineHistoryAvailable: lineHistory.length >= 2,
        openingOdds,
        currentOdds,
        clvProxyPct,
        movementDisposition,
        targetBookOdds,
        bestComparisonBook: bestCompEntry?.book || null,
        bestComparisonOdds: bestCompEntry ? Number(bestCompEntry.odds) : null,
        isActionable: Number.isFinite(targetBookOdds) && lineHistory.length >= 2
      };
    },
    { concurrency: 6 }
  );

  const ranked = rankScreenRows(enriched, {
    limit,
    preferredBooks: [preferredBook, 'NoVigApp', 'Polymarket', 'Kalshi', 'BetOnline', 'Circa'],
    includeAll: true,
    maxAgeMs: null
  }).map((row) => ({
    ...row,
    tennisMarket: row.screenMarket,
    tennisScore: row.screenScore
  }));

  // Correct tennis start times from ESPN + web search fallback
  await correctTennisTimes(ranked);

  return ranked;
}

/**
 * Rank tennis-specific screen rows (filtered from general rows).
 *
 * Dedup: when the upstream screen endpoint returns one row per book for the
 * same matchup+side (e.g. Ferro on Gorgodze vs Ferro is posted by NoVigApp,
 * Kalshi, Pinnacle, theScore, Caesars, Bovada, Fanatics, BetOnline,
 * DraftKings, OnyxOdds, FanDuel — 11 rows), keep only the highest-scored
 * row per (gameId, selection) key. The surviving row carries the best
 * executionQuality (rankScreenRows already sorts by score → consensus edge
 * → CLV), so the user sees one row per matchup+side instead of a wall of
 * per-book duplicates. Set { dedup: false } to preserve the legacy
 * per-book behavior (used by callers that need every book price).
 *
 * @param {Array<Object>} rows - Array of row data.
 * @param {Object} [options={}] - Ranking options.
 * @param {number} [options.limit=12] - Max rows to return.
 * @param {string} [options.preferredBook='NoVigApp'] - Preferred book.
 * @param {boolean} [options.includeAll=false] - Include rows that don't pass gate.
 * @param {number|null} [options.maxAgeMs=null] - Staleness threshold.
 * @param {number} [options.recentWindowHours=6] - Recent movement window.
 * @param {boolean} [options.debug=true] - Include debug payload.
 * @param {boolean} [options.dedup=true] - Dedupe by gameId+selection.
 * @returns {Array<Object>} Ranked tennis rows.
 */
function rankTennisScreenRows(
  rows,
  {
    limit = 12,
    preferredBook = 'NoVigApp',
    includeAll = false,
    maxAgeMs = null,
    recentWindowHours = 6,
    debug = true,
    // @ts-expect-error
    requirePreferredBook = false,
    // @ts-expect-error
    playableOnly = false,
    dedup = true
  } = {}
) {
  const tennisRows = Array.isArray(rows) ? rows.filter(isTennisRow) : [];
  const ranked = rankScreenRows(tennisRows, {
    limit,
    preferredBooks: [preferredBook, 'NoVigApp', 'Polymarket', 'Kalshi', 'BetOnline', 'Circa'],
    includeAll,
    maxAgeMs,
    recentWindowHours,
    debug: debug === undefined ? true : debug,
    requirePreferredBook,
    playableOnly
  });
  // Attach tennisMarket/tennisScore before dedup so the per-row decorators are
  // present on whatever row wins each key.
  const decorated = ranked.map((row) => ({
    ...row,
    tennisMarket: row.screenMarket,
    tennisScore: row.screenScore
  }));
  if (!dedup) return decorated;
  // Dedup by (gameId, selection). rankScreenRows already sorts by score →
  // consensusEdge → CLV (desc), so the first row per key is the best one.
  const seen = new Map();
  const deduped = [];
  for (const row of decorated) {
    const key = `${row.gameId || row.id || ''}:${row.selection || row.pick || row.participant || ''}`;
    if (seen.has(key)) continue;
    seen.set(key, true);
    deduped.push(row);
  }
  return deduped;
}

module.exports = {
  correctTennisTimes,
  enrichTennisEvCandidates,
  getTennisMarketFamily,
  isTennisRow,
  normalizeTennisMarketQuery,
  rankTennisScreenRows
};
