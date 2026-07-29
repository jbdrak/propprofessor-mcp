'use strict';

const { normalizeSelectionId } = require('./propprofessor-api');
const { normalizeText, parseHistoryTimeMs, getOddsHistoryStartTimestamp } = require('./propprofessor-shared-utils');
const { getOddsHistoryLookbackHours } = require('./mcp-runtime-config');

/**
 * Normalize a single history data point into a consistent shape.
 * Handles raw numbers, legacy arrays, and various object schemas (line/value/total/handicap, odds/price/americanOdds, etc.).
 *
 * @param {Object|null|undefined} point - Raw history data point from the API. Can be an object with various field schemas,
 *   a number, or null/undefined.
 * @returns {Object|null} Normalized point object with `line`, `odds`, `book`, `time`, `liquidity`, and `raw` fields,
 *   or null if input is null/undefined.
 */
function normalizeHistoryPoint(point) {
  if (point === null || point === undefined) return null;
  if (typeof point !== 'object') {
    const odds = Number(point);
    return { line: null, odds: Number.isFinite(odds) ? odds : null, raw: point };
  }

  const lineCandidates = [point.line, point.value, point.total, point.handicap, point.priceLine, point.spread];
  const oddsCandidates = [
    point.odds,
    point.price,
    point.americanOdds,
    point.currentOdds,
    point.current,
    point.open,
    point.close
  ];
  const line = lineCandidates.map(Number).find(Number.isFinite);
  const odds = oddsCandidates.map(Number).find(Number.isFinite);

  return {
    line: Number.isFinite(line) ? line : null,
    odds: Number.isFinite(odds) ? odds : null,
    book: point.book || point.sportsbook || point.site || '',
    time: point.time || point.timestamp || point.updatedAt || point.start_ts || point.end_ts || null,
    liquidity: point.liquidity ?? point.volume ?? null,
    raw: point
  };
}

/**
 * Normalize a raw odds-history API payload into a sorted array of normalized history points.
 * Handles multiple response shapes (array, {data}, {result}, {results}, {history}, {oddsHistory})
 * and falls back to iterating top-level book keys when no standard array is found.
 * Points are sorted by time (when available), then by original array index.
 *
 * @param {Object|Array} payload - Raw response from the odds history API. Can be an array or an object
 *   containing standard wrapper properties (`data`, `result`, `results`, `history`, `oddsHistory`).
 * @returns {Array<Object>} Sorted array of normalized history point objects, each with `line`, `odds`,
 *   `book`, `time`, `liquidity`, and `raw` fields. Returns empty array if fewer than 2 points found.
 */
function normalizeHistoryPayload(payload) {
  const candidates = [];
  if (Array.isArray(payload)) candidates.push(payload);
  if (Array.isArray(payload?.data)) candidates.push(payload.data);
  if (Array.isArray(payload?.result)) candidates.push(payload.result);
  if (Array.isArray(payload?.results)) candidates.push(payload.results);
  if (Array.isArray(payload?.history)) candidates.push(payload.history);
  if (Array.isArray(payload?.oddsHistory)) candidates.push(payload.oddsHistory);

  const sortPoints = (points) =>
    points
      .map((point, index) => ({
        ...point,
        __historyIndex: index,
        __timeMs: parseHistoryTimeMs(point?.time)
      }))
      .sort((left, right) => {
        const leftHasTime = Number.isFinite(left.__timeMs);
        const rightHasTime = Number.isFinite(right.__timeMs);
        if (leftHasTime && rightHasTime && left.__timeMs !== right.__timeMs) return left.__timeMs - right.__timeMs;
        if (leftHasTime !== rightHasTime) return leftHasTime ? -1 : 1;
        return left.__historyIndex - right.__historyIndex;
      })
      .map((point) => {
        const copy = { ...point };
        delete copy.__historyIndex;
        delete copy.__timeMs;
        return copy;
      });

  for (const candidate of candidates) {
    const points = candidate.map(normalizeHistoryPoint).filter(Boolean);
    if (points.length >= 2) return sortPoints(points);
  }

  if (payload && typeof payload === 'object') {
    const bookPoints = [];
    for (const [book, entries] of Object.entries(payload)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const point = normalizeHistoryPoint({ ...entry, book: entry?.book || book });
        if (point) bookPoints.push(point);
      }
    }
    if (bookPoints.length >= 2) return sortPoints(bookPoints);
  }

  return [];
}

/**
 * Score a single history row against a target entity to determine how well it matches.
 * Considers book, playType, pick, game, odds, and league fields, with bonus points for
 * exact selectionId or gameId matches.
 *
 * @param {Object} [target={}] - Target entity with fields like `book`, `playType`, `pick`, `game`, `odds`, `league`,
 *   `selectionId`, and/or `gameId` to match against.
 * @param {Object} [row={}] - History row to score, with corresponding fields.
 * @returns {number} Numeric score where higher values indicate a better match. Exact selectionId match adds 10,
 *   exact gameId match adds 10, exact book match adds 5, exact pick match adds 4, etc.
 */
function scoreHistoryRow(target = {}, row = {}) {
  let score = 0;
  const fields = [
    ['book', ['book', 'sportsbook', 'fantasyApp', 'site']],
    ['playType', ['playType', 'betType', 'market', 'selectionType']],
    ['pick', ['pick', 'selection', 'participant', 'name', 'label', 'title']],
    ['game', ['game', 'matchup', 'event', 'fixture', 'competition']],
    ['odds', ['odds', 'price', 'americanOdds', 'currentOdds']],
    ['league', ['league', 'sport']]
  ];

  for (const [targetKey, rowKeys] of fields) {
    // @ts-expect-error
    const targetValue = normalizeText(target[targetKey]);
    if (!targetValue) continue;
    for (const key of rowKeys) {
      const rowValue = normalizeText(row[key]);
      if (!rowValue) continue;
      if (rowValue === targetValue) {
        score += key === 'book' ? 5 : key === 'pick' ? 4 : key === 'game' ? 3 : key === 'playType' ? 2 : 1;
        break;
      }
      if (rowValue.includes(targetValue) || targetValue.includes(rowValue)) {
        score += key === 'book' ? 4 : key === 'pick' ? 3 : key === 'game' ? 2 : 1;
        break;
      }
    }
  }

  const rowOdds = Number(row.odds ?? row.price ?? row.americanOdds ?? row.currentOdds);
  const targetOdds = Number(target.odds);
  if (Number.isFinite(rowOdds) && Number.isFinite(targetOdds) && rowOdds === targetOdds) score += 2;

  if (
    target.selectionId &&
    row.selectionId &&
    normalizeSelectionId(row.selectionId) === normalizeSelectionId(target.selectionId)
  )
    score += 10;
  if (target.gameId && row.gameId && String(row.gameId) === String(target.gameId)) score += 10;

  return score;
}

function valuesMatch(a, b, { allowPartial = true } = {}) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return allowPartial && (left.includes(right) || right.includes(left));
}

function getRowValue(row = {}, keys = []) {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && String(value).trim() !== '') return value;
  }
  return '';
}

/**
 * Evaluate the match strength between a target entity and a history row across multiple dimensions.
 * Primarily checks selectionId/gameId matches (strongest), then book+pick+game text matches (fallback strong),
 * plus individual league and odds matches.
 *
 * @param {Object} [target={}] - Target entity with fields like `selectionId`, `gameId`, `book`, `pick`, `game`, `odds`.
 * @param {Object} [row={}] - History row to evaluate against, with corresponding fields.
 * @returns {{strong: boolean, directIdMatch: boolean, selectionIdMatch: boolean, gameIdMatch: boolean,
 *   bookMatch: boolean, pickMatch: boolean, gameMatch: boolean, oddsMatch: boolean}}
 *   An object describing each match dimension and an overall `strong` boolean indicating
 *   whether the row is considered a reliable match.
 */
function getMatchStrength(target = {}, row = {}) {
  const selectionIdMatch = Boolean(
    target.selectionId &&
    row.selectionId &&
    normalizeSelectionId(row.selectionId) === normalizeSelectionId(target.selectionId)
  );
  const gameIdMatch = Boolean(target.gameId && row.gameId && String(row.gameId) === String(target.gameId));
  const bookMatch = valuesMatch(target.book, getRowValue(row, ['book', 'sportsbook', 'fantasyApp', 'site']), {
    allowPartial: false
  });
  const pickMatch = valuesMatch(
    target.pick,
    getRowValue(row, ['pick', 'selection', 'participant', 'name', 'label', 'title'])
  );
  const gameMatch = valuesMatch(target.game, getRowValue(row, ['game', 'matchup', 'event', 'fixture', 'competition']));
  const rowOdds = Number(row.odds ?? row.price ?? row.americanOdds ?? row.currentOdds);
  const targetOdds = Number(target.odds);
  const oddsMatch = Number.isFinite(rowOdds) && Number.isFinite(targetOdds) && rowOdds === targetOdds;
  const directIdMatch = selectionIdMatch || gameIdMatch;
  const fallbackStrong = bookMatch && pickMatch && gameMatch;
  return {
    strong: directIdMatch || fallbackStrong,
    directIdMatch,
    selectionIdMatch,
    gameIdMatch,
    bookMatch,
    pickMatch,
    gameMatch,
    oddsMatch
  };
}

/**
 * Find the best-matching history row from an array by scoring each row against a target.
 * Returns the row with the highest score along with its match strength.
 *
 * @param {Object} [target={}] - Target entity with matchable fields (book, pick, game, odds, selectionId, etc.).
 * @param {Array<Object>} [rows=[]] - Array of history rows to search.
 * @returns {{row: Object|null, score: number, matchStrength: {strong: boolean}}}
 *   The best-matching row (or null if none found), its score, and the match strength breakdown.
 */
function findBestHistoryRow(target = {}, rows = []) {
  let bestRow = null;
  let bestScore = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const score = scoreHistoryRow(target, row);
    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }
  return {
    row: bestRow,
    score: bestScore,
    matchStrength: bestRow ? getMatchStrength(target, bestRow) : { strong: false }
  };
}

function findBestResolvableHistoryRow(target = {}, rows = []) {
  let bestDirectRow = null;
  let bestDirectScore = 0;
  let bestFallbackRow = null;
  let bestFallbackScore = 0;
  let bestAnyRow = null;
  let bestAnyScore = 0;

  const rowHasResolvableIds = (row) =>
    Boolean(
      row &&
      (row.gameId ?? row.game_id ?? row.gameID ?? row.game?.id) &&
      normalizeSelectionId(row.selectionId ?? row.selection_id ?? row.selectionID ?? row.selection)
    );

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const score = scoreHistoryRow(target, row);
    const matchStrength = getMatchStrength(target, row);
    const hasIds = rowHasResolvableIds(row);

    if (score > bestAnyScore || (score === bestAnyScore && hasIds && !rowHasResolvableIds(bestAnyRow))) {
      bestAnyScore = score;
      bestAnyRow = row;
    }

    if (!matchStrength.strong) continue;

    if (
      matchStrength.directIdMatch &&
      (score > bestDirectScore || (score === bestDirectScore && hasIds && !rowHasResolvableIds(bestDirectRow)))
    ) {
      bestDirectScore = score;
      bestDirectRow = row;
      continue;
    }

    if (
      !bestDirectRow &&
      (score > bestFallbackScore || (score === bestFallbackScore && hasIds && !rowHasResolvableIds(bestFallbackRow)))
    ) {
      bestFallbackScore = score;
      bestFallbackRow = row;
    }
  }

  const row = bestDirectRow || bestFallbackRow || bestAnyRow;
  const score = bestDirectRow ? bestDirectScore : bestFallbackRow ? bestFallbackScore : bestAnyScore;
  const resolvableScore = bestDirectRow ? bestDirectScore : bestFallbackRow ? bestFallbackScore : 0;
  return { row, score, resolvableScore, matchStrength: row ? getMatchStrength(target, row) : { strong: false } };
}

/**
 * Resolve odds history for a single entity by matching it against available rows, then
 * querying the history API using the matched gameId and selectionId.
 *
 * @param {Object} options - The options object.
 * @param {Object} options.client - API client object (used for its context, passed through to queryHistoryFn).
 * @param {Object} options.target - Target entity with matchable fields (book, pick, game, odds, selectionId, gameId, etc.).
 * @param {Array<Object>} options.rows - Array of available history rows to match the target against.
 * @param {Function} options.queryHistoryFn - Async function that queries odds history. Called with
 *   `{ gameId, selectionId, sportsbooks, startTimestamp }`. Should return a raw API payload.
 * @param {number} [options.lookbackHours] - Lookback window in hours for the history query.
 *   Defaults to the runtime config value.
 * @param {number} [options.nowMs] - Current timestamp in milliseconds, used for start-timestamp calculation.
 *   Defaults to Date.now().
 * @param {Array<string>} [options.historySportsbooks=[]] - Specific sportsbooks to include in the history query.
 * @param {string|null} [options.preferredBook=null] - Preferred book name, always included in history query.
 * @param {Array<string>} [options.sharpBooks=[]] - Sharp book names, always included in history query.
 * @returns {Promise<{lineHistory: Array<Object>, lineHistoryAvailable: boolean, lineHistorySource: string|null,
 *   matchedRow: Object|null, matchStrength: {strong: boolean}, normalizedSelectionId: string|null,
 *   historyGameId: string|number|null, historyMatchedBy: string|null,
 *   historyMatchKey: string|null, historySportsbooksRequested: Array<string>}>}
 *   Resolved history result. When matching or querying fails, `lineHistory` is an empty array and
 *   `lineHistoryAvailable` is false.
 */
async function resolveHistoryForEntity({
  client,
  target,
  rows,
  queryHistoryFn,
  lookbackHours = getOddsHistoryLookbackHours(),
  nowMs = Date.now(),
  historySportsbooks = [],
  preferredBook = null,
  sharpBooks = []
}) {
  if (!client || typeof queryHistoryFn !== 'function' || !Array.isArray(rows) || rows.length === 0) {
    // @ts-expect-error
    return {
      lineHistory: [],
      lineHistoryAvailable: false,
      lineHistorySource: null,
      matchedRow: null,
      matchStrength: { strong: false },
      normalizedSelectionId: null,
      historyGameId: null,
      historyMatchedBy: null
    };
  }

  const { row: matchedRow, score, matchStrength } = findBestResolvableHistoryRow(target, rows);
  if (!matchedRow || score <= 0 || !matchStrength.strong) {
    // @ts-expect-error
    return {
      lineHistory: [],
      lineHistoryAvailable: false,
      lineHistorySource: null,
      matchedRow: null,
      matchStrength,
      normalizedSelectionId: null,
      historyGameId: null,
      historyMatchedBy: null
    };
  }

  const gameId =
    matchedRow.gameId ??
    matchedRow.game_id ??
    matchedRow.gameID ??
    matchedRow.game?.id ??
    target.gameId ??
    target.game_id ??
    target.gameID ??
    target.game?.id ??
    null;
  const selectionId = normalizeSelectionId(
    matchedRow.selectionId ??
      matchedRow.selection_id ??
      matchedRow.selectionID ??
      matchedRow.selection ??
      target.selectionId ??
      target.selection_id ??
      target.selectionID ??
      target.selection
  );
  if (!gameId || !selectionId) {
    // @ts-expect-error
    return { lineHistory: [], lineHistoryAvailable: false, lineHistorySource: null, matchedRow, matchStrength };
  }

  const startTimestamp = getOddsHistoryStartTimestamp({ lookbackHours, nowMs });
  const requestedSportsbooks = Array.from(
    new Set([
      ...(Array.isArray(historySportsbooks) ? historySportsbooks : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
      ...[preferredBook].map((value) => String(value || '').trim()).filter(Boolean),
      ...(Array.isArray(sharpBooks) ? sharpBooks : []).map((value) => String(value || '').trim()).filter(Boolean)
    ])
  );
  const payload = await queryHistoryFn({ gameId, selectionId, sportsbooks: requestedSportsbooks, startTimestamp });
  const rawLineHistory = normalizeHistoryPayload(payload);
  if (rawLineHistory.length < 2) {
    // @ts-expect-error
    return { lineHistory: [], lineHistoryAvailable: false, lineHistorySource: null, matchedRow, matchStrength };
  }

  // Line-field fallback (v2.1.3): the upstream /odds_history endpoint does not
  // return a `line` field per entry — only `odds`, `start_ts`, `end_ts`, and
  // `liquidity`. For line-based markets (Puck Line, Run Line, Point Spread,
  // Total Goals/Runs/Rounds, etc.) the screen response's *current* line is
  // preserved on `matchedRow.line1` / `matchedRow.line2` (or `matchedRow.line`
  // for the alias). Without a line value, downstream line-movement detection
  // is degraded: every entry looks like "no movement" because there's no line
  // to compare. The conservative fix is to backfill the current line into
  // every entry that lacks one, and surface a `lineFieldMissingCount` so the
  // warning builder can tell the user this happened. This doesn't recover
  // actual historical line movement (the upstream data is missing), but it
  // makes the entries self-consistent and unblocks consumers that read
  // `entry.line` unconditionally.
  const fallbackLine = normalizeLineValue(matchedRow?.line1 ?? matchedRow?.line2 ?? matchedRow?.line ?? null);
  let lineFieldMissingCount = 0;
  const lineHistory =
    fallbackLine !== null
      ? rawLineHistory.map((entry) => {
          if (entry && (entry.line === null || entry.line === undefined)) {
            lineFieldMissingCount += 1;
            return { ...entry, line: fallbackLine };
          }
          return entry;
        })
      : rawLineHistory;

  return {
    lineHistory,
    lineHistoryAvailable: true,
    lineHistorySource: 'odds_history',
    matchedRow,
    matchStrength,
    normalizedSelectionId: selectionId,
    historyGameId: gameId,
    // @ts-expect-error
    historyMatchedBy: matchStrength.selectionIdMatch
      ? 'selectionId'
      : // @ts-expect-error
        matchStrength.gameIdMatch
        ? 'gameId'
        : 'fallback',
    // @ts-expect-error
    historyMatchKey: matchStrength.selectionIdMatch ? 'selectionId' : matchStrength.gameIdMatch ? 'gameId' : null,
    historySportsbooksRequested: requestedSportsbooks,
    // v2.1.3: track when the line field was missing from upstream and we
    // backfilled it from the row's current line. The warning builder reads
    // this to flag degraded line-movement detection.
    // @ts-expect-error
    lineFieldMissingCount
  };
}

function normalizeLineValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

module.exports = {
  findBestHistoryRow,
  normalizeHistoryPayload,
  normalizeHistoryPoint,
  normalizeSelectionId,
  resolveHistoryForEntity,
  scoreHistoryRow,
  getMatchStrength,
  getOddsHistoryStartTimestamp
};
