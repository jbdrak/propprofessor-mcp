'use strict';

/**
 * Small pure helpers for bounded Positive EV recovery.
 * EV recovery is discovery only; callers must still run normal validation.
 */

function hasIncompleteScan(response) {
  const health = response?.resultMeta?.scanHealth || response?.scanHealth;
  return health?.incomplete === true || health?.truncated === true || health?.validationBudgetExhausted === true;
}

function shouldRecoverFromEv(response, args = {}) {
  if (args.includeEv === true) return true;
  if (args.includeEv === false) return false;
  return hasIncompleteScan(response) || !Array.isArray(response?.result) || response.result.length === 0;
}

function buildEvRecoveryRequest({ league, market, books, maxHoursAway = 48 } = {}) {
  const sportsbooks = Array.isArray(books) ? books.filter((book) => String(book || '').trim()) : [];
  const marketName = String(market || '').toLowerCase();
  const marketType = /player|pitcher|rebounds|assists|strikeouts|touchdowns|hits|runs|rbi|outs/.test(marketName)
    ? 'Player Props'
    : 'Main Lines';
  return {
    leagues: [league],
    ...(sportsbooks.length ? { sportsbooks } : {}),
    marketTypes: [marketType],
    minOdds: -9999,
    maxOdds: 9999,
    minValue: 0,
    maxHoursAway,
    isLive: false
  };
}

function extractEvRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  return [];
}

function dedupeEvRows(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  return rows.filter((row) => {
    const key = [row.gameId || row.game_id || row.game || '', row.market || row.marketType || '', row.selection || row.participant || '', row.line ?? ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { hasIncompleteScan, shouldRecoverFromEv, buildEvRecoveryRequest, extractEvRows, dedupeEvRows };
