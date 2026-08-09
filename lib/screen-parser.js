'use strict';

const {
  normalizeDirection,
  normalizeMarketName,
  normalizeRow,
  parseHistoryTimeMs
} = require('./propprofessor-shared-utils');

/**
 * Parse a bet prompt string to extract structured fields.
 * Matches patterns like "is [player] [over/under] [line] [market]".
 * @param {string} input - Raw bet prompt text.
 * @returns {{ player: string, side: string, line: number|null, market: string }}
 */
function parseBetPrompt(input) {
  const text = String(input || '').trim();
  const match = text.match(
    /^(?:is\s+)?(.+?)\s+([ou]|over|under)\s*(\d+(?:\.\d+)?)\s+([a-z+\s]+?)(?:\s+a\s+good\s+bet\??)?$/i
  );
  if (!match) {
    return { player: '', side: '', line: null, market: '' };
  }
  return {
    player: match[1].trim(),
    side: normalizeDirection(match[2]),
    line: Number(match[3]),
    market: normalizeMarketName(match[4])
  };
}

/**
 * Extract a numeric trail value from an odds history data point.
 * Checks common field names (odds, americanOdds, price, line, value, etc.).
 * @param {*} item - Data point to extract from.
 * @returns {number|null} Numeric value or null if not found.
 */
function extractNumericTrailValue(item) {
  if (typeof item === 'number') return Number.isFinite(item) ? item : null;
  if (!item || typeof item !== 'object') return null;
  const candidates = [
    item.odds,
    item.americanOdds,
    item.price,
    item.line,
    item.value,
    item.current,
    item.open,
    item.close
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Extract a trail of numeric odds values from a row's line/odds history arrays.
 * Falls back to opening odds / current odds from row fields.
 * @param {Object} row - Row data with optional lineHistory, oddsHistory, etc.
 * @returns {number[]} Array of numeric odds values (empty if unavailable).
 */
function extractHistoryTrail(row) {
  const arrays = [row?.lineHistory, row?.oddsHistory, row?.priceHistory, row?.movementHistory, row?.history];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    const trail = arr.map(extractNumericTrailValue).filter((v) => Number.isFinite(v));
    if (trail.length >= 2) return trail;
  }
  const open = extractNumericTrailValue({
    odds: row?.openingOdds ?? row?.openOdds ?? row?.open_price ?? row?.openPrice ?? row?.startOdds ?? row?.startPrice
  });
  const current = extractNumericTrailValue({ odds: row?.currentOdds ?? row?.odds ?? row?.price ?? row?.bookOdds });
  if (Number.isFinite(open) && Number.isFinite(current)) return [open, current];
  return [];
}

/**
 * Extract freshness info (timestamp + source field) from a row.
 * Checks multiple common field names in order of preference.
 * @param {Object} row - Row data with freshness-related timestamp fields.
 * @returns {{ ms: number, source: string }|null} Freshness info or null.
 */
function extractRowFreshnessInfo(row) {
  if (!row || typeof row !== 'object') return null;
  const candidates = [
    ['updatedAt', row.updatedAt],
    ['lastUpdated', row.lastUpdated],
    ['lastUpdate', row.lastUpdate],
    ['timestamp', row.timestamp],
    ['time', row.time],
    ['createdAt', row.createdAt],
    ['pulledAt', row.pulledAt],
    ['refreshedAt', row.refreshedAt],
    ['asOf', row.asOf],
    ['scrapedAt', row.scrapedAt],
    ['fetchedAt', row.fetchedAt],
    ['snapshotAt', row.snapshotAt],
    ['payload.updatedAt', row.payload?.updatedAt],
    ['payload.lastUpdated', row.payload?.lastUpdated],
    ['meta.updatedAt', row.meta?.updatedAt],
    ['meta.timestamp', row.meta?.timestamp]
  ];
  for (const [source, candidate] of candidates) {
    const ms = parseHistoryTimeMs(candidate);
    if (Number.isFinite(ms)) return { ms, source };
  }
  return null;
}

/**
 * Coerce a backend per-book liquidity value to a finite number or null.
 * The /screen payload carries per-book, per-side dollar liquidity as
 * `liquidity1` / `liquidity2` on each book's odds entry (verified in real
 * payloads). Absent or non-numeric values stay null — never fabricate depth.
 * @param {*} value - Raw liquidity value (usually a number or undefined).
 * @returns {number|null} Finite liquidity or null.
 */
function toFiniteLiquidity(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Coerce the backend's row containers to a flat array. Some live /screen
 * responses serialize `game_data` as an array-like object with numeric keys
 * instead of a native array.
 * @param {*} value
 * @returns {Array}
 */
function coerceRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const keys = Object.keys(value);
  if (!keys.length || !keys.every((key) => /^\d+$/.test(key))) return null;
  return keys.sort((a, b) => Number(a) - Number(b)).map((key) => value[key]);
}

/**
 * Extract and expand screen rows from a payload into a flat array.
 * Handles nested selections/book structure by creating one row per book per side.
 * @param {Object|Array} payload - API response payload or array of rows.
 * @param {Array} [plays=[]] - Optional plays array to filter candidate books.
 * @returns {Array<Object>} Flat array of expanded row objects.
 */
function extractScreenRows(payload, plays = []) {
  const rows =
    coerceRows(payload) ||
    coerceRows(payload?.game_data) ||
    coerceRows(payload?.data) ||
    coerceRows(payload?.results) ||
    coerceRows(payload?.rows);
  const candidateBooks = [
    ...new Set((Array.isArray(plays) ? plays : []).map((play) => String(play?.book || '').trim()).filter(Boolean))
  ];
  const expanded = [];

  for (const rawRow of rows) {
    if (!rawRow || typeof rawRow !== 'object') continue;
    // Normalize row: lift selections.null contents and drop defaultKey: "null"
    const row = normalizeRow(rawRow);

    // Check if this is a normalized non-prop row (has selection1/selection2 at top level, no selections)
    const isNormalizedNonProp = row.selection1 || row.selection2;
    const selections = row.selections && typeof row.selections === 'object' ? Object.values(row.selections) : [];

    if (isNormalizedNonProp) {
      // Handle normalized non-prop row: create per-book rows from selection1/selection2
      const oddsMap = row.odds && typeof row.odds === 'object' ? row.odds : {};
      let books = candidateBooks.length ? candidateBooks.filter((book) => oddsMap[book]) : Object.keys(oddsMap);
      // Defensive: if the caller asked for a specific focus book but it has no
      // odds in this row (e.g. Pinnacle for UFC, where Pinnacle doesn't post
      // moneylines), fall back to all books in the row. The focus-book intent
      // is "prefer this book when available" — if it isn't available, surface
      // the data we do have rather than returning 0.
      if (books.length === 0 && candidateBooks.length) {
        books = Object.keys(oddsMap);
      }

      for (const book of books) {
        const bookOdds = oddsMap?.[book];
        if (!bookOdds || typeof bookOdds !== 'object') continue;

        const common = {
          ...row,
          book,
          playType: row.market,
          market: row.market,
          game: row.game || row.matchup || (row.homeTeam && row.awayTeam ? `${row.homeTeam} vs ${row.awayTeam}` : ''),
          gameId: row.gameId || row.id || null,
          league: row.league || row.sport || ''
        };

        expanded.push({
          ...common,
          pick: row.selection1 || row.participant1 || row.homeTeam || '',
          selection: row.selection1 || row.participant1 || row.homeTeam || '',
          participant: row.participant1 || row.homeTeam || '',
          // v2.1.6: preserve the full per-book odds map from the normalized
          // row (lifted from selections.null.odds) before overriding `odds`
          // with the per-book number. The downstream ranker needs the full
          // map to compute consensus, edge, and execution quality; without
          // this every row cascades to consensusBookCount=0 / TIER 4.
          allBookOdds: common.odds,
          odds: bookOdds.odds1,
          currentOdds: bookOdds.odds1,
          // Per-book dollar liquidity for THIS side (liquidity1 pairs with
          // odds1, liquidity2 with odds2) — never the opposite side's depth.
          liquidityUsd: toFiniteLiquidity(bookOdds.liquidity1),
          line: row.line1 ?? null,
          selectionId: row.selection1Id || null
        });
        expanded.push({
          ...common,
          pick: row.selection2 || row.participant2 || row.awayTeam || '',
          selection: row.selection2 || row.participant2 || row.awayTeam || '',
          participant: row.participant2 || row.awayTeam || '',
          allBookOdds: common.odds,
          odds: bookOdds.odds2,
          currentOdds: bookOdds.odds2,
          liquidityUsd: toFiniteLiquidity(bookOdds.liquidity2),
          line: row.line2 ?? null,
          selectionId: row.selection2Id || null
        });
      }
      continue;
    }

    if (!selections.length) {
      expanded.push(row);
      continue;
    }

    let rowExpanded = false;
    for (const selection of selections) {
      const oddsMap = selection?.odds && typeof selection.odds === 'object' ? selection.odds : {};
      const books = candidateBooks.length ? candidateBooks.filter((book) => oddsMap[book]) : Object.keys(oddsMap);
      for (const book of books) {
        const bookOdds = oddsMap?.[book];
        if (!bookOdds || typeof bookOdds !== 'object') continue;
        const common = {
          ...row,
          book,
          playType: row.market,
          market: row.market,
          game: row.game || row.matchup || (row.homeTeam && row.awayTeam ? `${row.homeTeam} vs ${row.awayTeam}` : ''),
          gameId: row.gameId || row.id || null,
          league: row.league || row.sport || ''
        };
        expanded.push({
          ...common,
          pick: selection.selection1 || selection.participant1 || row.homeTeam || '',
          selection: selection.selection1 || selection.participant1 || row.homeTeam || '',
          participant: selection.participant1 || row.homeTeam || '',
          odds: bookOdds.odds1,
          allBookOdds: oddsMap,
          currentOdds: bookOdds.odds1,
          // Per-book dollar liquidity for THIS side (liquidity1 pairs with
          // odds1, liquidity2 with odds2) — never the opposite side's depth.
          liquidityUsd: toFiniteLiquidity(bookOdds.liquidity1),
          line: selection.line1 ?? null,
          selectionId: selection.selection1Id || null
        });
        expanded.push({
          ...common,
          pick: selection.selection2 || selection.participant2 || row.awayTeam || '',
          selection: selection.selection2 || selection.participant2 || row.awayTeam || '',
          participant: selection.participant2 || row.awayTeam || '',
          odds: bookOdds.odds2,
          allBookOdds: oddsMap,
          currentOdds: bookOdds.odds2,
          liquidityUsd: toFiniteLiquidity(bookOdds.liquidity2),
          line: selection.line2 ?? null,
          selectionId: selection.selection2Id || null
        });
        rowExpanded = true;
      }
    }

    if (!rowExpanded) expanded.push(row);
  }

  return expanded;
}

module.exports = {
  extractHistoryTrail,
  extractNumericTrailValue,
  extractRowFreshnessInfo,
  extractScreenRows,
  parseBetPrompt
};
