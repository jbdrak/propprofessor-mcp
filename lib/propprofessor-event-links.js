'use strict';

const LINK_FIELDS = ['deepLink', 'pageUrl', 'mobileLink'];

function extractEventLinkRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.bets)) return payload.bets;
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  return [];
}

function cleanLink(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function chooseEventLink(row, { mobile = false } = {}) {
  const fields = mobile ? ['mobileLink', 'deepLink', 'pageUrl'] : LINK_FIELDS;
  for (const field of fields) {
    const link = cleanLink(row?.[field]);
    if (link) return link;
  }
  return null;
}

function matchesText(value, filters) {
  if (!filters.length) return true;
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return filters.some((filter) => normalized === String(filter).trim().toLowerCase());
}

/**
 * Group event-link rows into one entry per (book, game, link).
 *
 * The options type is declared explicitly: without it TypeScript infers the
 * parameter shape from the call site, which does not include `book`, and
 * errors with TS2339 on the destructured `book` binding.
 *
 * @param {Array<Object>|Object} rows - Event-link rows (an array, or a payload carrying `bets`/`rows`).
 * @param {{ book?: string|null, leagues?: Array<string>, markets?: Array<string>, mobile?: boolean, limit?: number }} [options]
 * @returns {Array<Object>} Grouped events, sorted by start time and capped at `limit`.
 */
function groupEventLinks(rows, { book, leagues = [], markets = [], mobile = false, limit = 100 } = {}) {
  const groups = new Map();
  const leagueFilters = leagues.filter(Boolean);
  const marketFilters = markets.filter(Boolean);

  for (const row of Array.isArray(rows) ? rows : []) {
    if (book && String(row.book || '').toLowerCase() !== String(book).toLowerCase()) continue;
    if (!matchesText(row.league, leagueFilters)) continue;
    if (!matchesText(row.market, marketFilters)) continue;

    const link = chooseEventLink(row, { mobile });
    if (!link) continue;
    const gameId = row.gameId || row.game_id || '';
    const key = [row.book || book || '', gameId, link].join('|');
    let group = groups.get(key);
    if (!group) {
      group = {
        book: row.book || book || null,
        league: row.league || null,
        gameId: gameId || null,
        homeTeam: row.homeTeam || null,
        awayTeam: row.awayTeam || null,
        start: row.start || null,
        eventLink: link,
        deepLink: cleanLink(row.deepLink),
        pageUrl: cleanLink(row.pageUrl),
        mobileLink: cleanLink(row.mobileLink),
        markets: []
      };
      groups.set(key, group);
    }

    const marketKey = [row.market || '', row.selection || '', row.line ?? ''].join('|');
    if (!group.markets.some((market) => market.key === marketKey)) {
      group.markets.push({
        key: marketKey,
        market: row.market || null,
        selection: row.selection || null,
        line: row.line ?? null
      });
    }
  }

  const sorted = [...groups.values()].sort((a, b) => {
    const aStart = Date.parse(a.start || '') || Number.POSITIVE_INFINITY;
    const bStart = Date.parse(b.start || '') || Number.POSITIVE_INFINITY;
    return aStart - bStart || String(a.gameId || '').localeCompare(String(b.gameId || ''));
  });

  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 100;
  return sorted.slice(0, max).map(({ markets: eventMarkets, ...event }) => ({ ...event, markets: eventMarkets }));
}

module.exports = { extractEventLinkRows, chooseEventLink, groupEventLinks };
