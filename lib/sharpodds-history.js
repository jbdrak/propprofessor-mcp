'use strict';

const { parseHistoryTimeMs } = require('./propprofessor-shared-utils');

const MARKET_ALIASES = {
  spread: 'spread',
  spreads: 'spread',
  total: 'total',
  totals: 'total',
  moneyline: 'moneyline',
  moneylines: 'moneyline',
  ml: 'moneyline'
};

const MARKET_KEYS = {
  spread: 'SPREADS',
  total: 'TOTALS',
  moneyline: 'MONEYLINES'
};

function normalizeMarket(value) {
  const key = String(value || '').trim().toLowerCase();
  return MARKET_ALIASES[key] || null;
}

function normalizeSide(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'away' || key === 'home') return key;
  return null;
}

function parseAmericanOddsToken(token) {
  if (token === null || token === undefined) return null;
  const text = String(token).trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || numeric === 0) return null;
  return numeric;
}

function parseSpreadValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { line: value, odds: null } : { line: null, odds: null };
  }
  const text = String(value ?? '').trim();
  const match = text.match(/^([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+)$/);
  if (!match) return { line: null, odds: null };
  const line = Number(match[1]);
  return {
    line: Number.isFinite(line) ? line : null,
    odds: parseAmericanOddsToken(match[2])
  };
}

function parseTotalValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { line: value, odds: null } : { line: null, odds: null };
  }
  const text = String(value ?? '').trim();
  const ouMatch = text.match(/^[oOuU]\s*(\d+(?:\.\d+)?)\s+([+-]?\d+)$/);
  if (ouMatch) {
    const line = Number(ouMatch[1]);
    return {
      line: Number.isFinite(line) ? line : null,
      odds: parseAmericanOddsToken(ouMatch[2])
    };
  }
  return parseSpreadValue(value);
}

function parseMoneylineValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value !== 0 ? { line: null, odds: value } : { line: null, odds: null };
  }
  const text = String(value ?? '').trim();
  return { line: null, odds: parseAmericanOddsToken(text) };
}

function parseMarketValue(market, value) {
  if (market === 'spread') return parseSpreadValue(value);
  if (market === 'total') return parseTotalValue(value);
  return parseMoneylineValue(value);
}

function parseMetaDate(meta) {
  const text = String(meta?.date || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function parsePointClock(time) {
  const text = String(time ?? '').trim();
  const twelveHour = text.match(/^(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?$/i);
  if (twelveHour) {
    let hour = Number(twelveHour[1]);
    const minute = Number(twelveHour[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 1 || hour > 12 || minute > 59) return null;
    const isPm = twelveHour[3].toUpperCase() === 'P';
    if (hour === 12) hour = isPm ? 12 : 0;
    else if (isPm) hour += 12;
    return { hour, minute };
  }
  const twentyFourHour = text.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHour) {
    const hour = Number(twentyFourHour[1]);
    const minute = Number(twentyFourHour[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  return null;
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
}

/**
 * Parse an explicit numeric timezone offset into minutes east of UTC
 * (local minus UTC). Accepts '-0400', '+0000', '-04:00', 'Z'/'UTC', a
 * finite number of offset minutes (e.g. -240), or a plain integer string
 * of offset minutes. Returns null for absent/unsupported values (notably
 * IANA names like 'America/Chicago', which have no deterministic
 * conversion seam here) so callers fail closed.
 */
function parseTimezoneOffsetMinutes(timezone) {
  if (timezone === null || timezone === undefined) return null;
  if (typeof timezone === 'number') {
    if (!Number.isFinite(timezone)) return null;
    if (Math.abs(timezone) > 18 * 60) return null;
    return Math.trunc(timezone);
  }
  const text = String(timezone).trim();
  if (text === '') return null;
  if (/^(Z|UTC|UT)$/i.test(text)) return 0;
  let match = text.match(/^([+-])(\d{2})(\d{2})$/);
  if (match) {
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2]);
    const minutes = Number(match[3]);
    if (hours > 18 || minutes > 59) return null;
    const total = hours * 60 + minutes;
    if (total > 18 * 60) return null;
    return sign * total;
  }
  match = text.match(/^([+-])(\d{1,2}):(\d{2})$/);
  if (match) {
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2]);
    const minutes = Number(match[3]);
    if (hours > 18 || minutes > 59) return null;
    const total = hours * 60 + minutes;
    if (total > 18 * 60) return null;
    return sign * total;
  }
  if (/^[+-]?\d+$/.test(text)) {
    const total = Number(text);
    if (!Number.isFinite(total) || Math.abs(total) > 18 * 60) return null;
    return Math.trunc(total);
  }
  return null;
}

/**
 * Infer an ISO UTC timestamp for a SharpOdds history point.
 *
 * Source points carry `date` (MM/DD) plus a local wall-clock `time` with
 * no year and no embedded timezone, so the year is taken conservatively
 * from meta.date (YYYY-MM-DD) and the wall clock is interpreted in the
 * caller-supplied numeric request timezone (e.g. the verified `z=-0400`
 * offset). Returns null — and a warning reason — when that cannot be
 * done safely instead of guessing. Never assumes UTC: a missing or
 * unsupported timezone yields `timestamp_timezone_unknown` with a null
 * time. Impossible calendar dates (e.g. 02/31) yield
 * `timestamp_unparseable` with a null time.
 */
function inferSharpOddsTimeMs(point, metaDate, timezone) {
  if (!metaDate) return { timeMs: null, warning: 'timestamp_year_unknown' };
  const dateMatch = String(point?.date ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})$/);
  const clock = parsePointClock(point?.time);
  if (!dateMatch || !clock) return { timeMs: null, warning: 'timestamp_unparseable' };
  const month = Number(dateMatch[1]);
  const day = Number(dateMatch[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { timeMs: null, warning: 'timestamp_unparseable' };

  // Never silently assume UTC: without an explicit numeric request offset
  // the local wall clock cannot be converted to true UTC.
  const offsetMinutes = parseTimezoneOffsetMinutes(
    timezone && typeof timezone === 'object' ? timezone.timezone ?? timezone.tzOffset ?? timezone.tz ?? timezone.z : timezone
  );
  if (offsetMinutes === null) return { timeMs: null, warning: 'timestamp_timezone_unknown' };

  let year = metaDate.year;
  let warning = null;
  // Conservative season-boundary rollover: a December point against a
  // January event (or vice versa) belongs to the adjacent year.
  if (metaDate.month - month > 6) {
    year += 1;
    warning = 'timestamp_year_rollover_assumed';
  } else if (month - metaDate.month > 6) {
    year -= 1;
    warning = 'timestamp_year_rollover_assumed';
  }
  // Reject impossible calendar dates before Date.UTC normalizes them
  // (Date.UTC(2026, 1, 31) would silently become March 3).
  if (day > daysInMonth(year, month)) return { timeMs: null, warning: 'timestamp_unparseable' };
  const wallAsUtcMs = Date.UTC(year, month - 1, day, clock.hour, clock.minute);
  const timeMs = wallAsUtcMs - offsetMinutes * 60 * 1000;
  if (!Number.isFinite(timeMs)) return { timeMs: null, warning: 'timestamp_unparseable' };
  return { timeMs, warning };
}

function normalizeSharpOddsHistory(payload, options = {}) {
  const warnings = [];
  const warn = (reason) => {
    if (!warnings.includes(reason)) warnings.push(reason);
  };

  const market = normalizeMarket(options.market);
  const side = normalizeSide(options.side ?? 'away');
  if (!market) throw new TypeError(`normalizeSharpOddsHistory: unknown market "${options.market}"`);
  if (!side) throw new TypeError(`normalizeSharpOddsHistory: unknown side "${options.side}"`);

  const meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : {};
  const markets = payload?.markets && typeof payload.markets === 'object' ? payload.markets : null;
  const metaDate = parseMetaDate(meta);
  if (!metaDate) warn('meta_date_missing');

  const book = String(options.book ?? meta.sportsbook ?? '').trim();
  if (!book) warn('book_unknown');
  const timezone = options.timezone ?? options.tzOffset ?? options.tz ?? options.z ?? null;

  if (!markets) {
    warn('markets_missing');
    return buildResult({ market, side, book, meta, points: [], rawPointCount: 0, droppedCount: 0, warnings });
  }

  const knownKeys = Object.values(MARKET_KEYS);
  for (const key of Object.keys(markets)) {
    if (!knownKeys.includes(key)) warn('unknown_market_key');
  }
  if (knownKeys.some((key) => markets[key] === undefined)) warn('markets_partial');

  const marketKey = MARKET_KEYS[market];
  const rawPoints = markets[marketKey];
  if (rawPoints === undefined) {
    warn('market_missing');
    return buildResult({ market, side, book, meta, points: [], rawPointCount: 0, droppedCount: 0, warnings });
  }
  if (!Array.isArray(rawPoints)) {
    warn('market_malformed');
    return buildResult({ market, side, book, meta, points: [], rawPointCount: 0, droppedCount: 0, warnings });
  }
  if (rawPoints.length === 0) {
    warn('market_empty');
    return buildResult({ market, side, book, meta, points: [], rawPointCount: 0, droppedCount: 0, warnings });
  }

  const parsed = [];
  let unparseableCount = 0;
  let missingTimestampCount = 0;
  const timestampWarnings = new Set();

  for (const raw of rawPoints) {
    const rawValue = raw && typeof raw === 'object' ? raw[side] : undefined;
    const { line, odds } = parseMarketValue(market, rawValue);
    if (!Number.isFinite(odds)) {
      unparseableCount += 1;
      continue;
    }
    const { timeMs, warning } = inferSharpOddsTimeMs(raw, metaDate, timezone);
    if (warning) timestampWarnings.add(warning);
    if (timeMs === null) missingTimestampCount += 1;
    parsed.push({
      time: timeMs === null ? null : new Date(timeMs).toISOString(),
      __timeMs: timeMs,
      line,
      odds,
      book,
      liquidity: null,
      // Preserve the provider's pub marker verbatim. SharpOdds has not
      // verified ticket/money percentage shapes, so no moneyPct/ticketsPct
      // fields are invented here.
      pub: raw && typeof raw === 'object' && 'pub' in raw ? raw.pub ?? null : null,
      raw: raw && typeof raw === 'object' ? { ...raw } : raw
    });
  }

  if (unparseableCount > 0) warn('unparseable_values_dropped');
  for (const reason of timestampWarnings) warn(reason);
  if (missingTimestampCount > 0) warn('missing_timestamps');

  // Sort chronologically; points without real timestamps sort last (stable).
  // Never backfill: the output contains only provider points, never the
  // current screen line appended as a synthetic point.
  const sorted = parsed
    .map((point, index) => ({ ...point, __index: index }))
    .sort((left, right) => {
      const leftHas = Number.isFinite(left.__timeMs);
      const rightHas = Number.isFinite(right.__timeMs);
      if (leftHas && rightHas && left.__timeMs !== right.__timeMs) return left.__timeMs - right.__timeMs;
      if (leftHas !== rightHas) return leftHas ? -1 : 1;
      return left.__index - right.__index;
    });

  // Remove only exact consecutive duplicates (same time, line, and odds).
  const points = [];
  let droppedCount = 0;
  for (const entry of sorted) {
    const previous = points[points.length - 1];
    if (
      previous &&
      previous.time === entry.time &&
      previous.line === entry.line &&
      previous.odds === entry.odds
    ) {
      droppedCount += 1;
      continue;
    }
    const { __timeMs, __index, ...kept } = entry;
    points.push(kept);
  }
  if (droppedCount > 0) warn('consecutive_duplicates_removed');

  return buildResult({
    market,
    side,
    book,
    meta,
    points,
    rawPointCount: rawPoints.length,
    droppedCount: droppedCount + unparseableCount,
    warnings
  });
}

function buildResult({ market, side, book, meta, points, rawPointCount, droppedCount, warnings }) {
  const timestampedCount = points.filter((point) => Number.isFinite(parseHistoryTimeMs(point.time))).length;
  const lineHistoryUsable = timestampedCount >= 2;
  if (rawPointCount < 2) warnings = [...new Set([...warnings, 'single_point_history'])];

  let coverage = 'complete';
  if (rawPointCount === 0) coverage = 'empty';
  else if (!lineHistoryUsable || warnings.length > 0) coverage = 'partial';

  return {
    provider: 'sharpodds',
    historySource: 'sharpodds',
    market,
    side,
    book,
    event: {
      awayTeam: meta?.away_team ?? null,
      homeTeam: meta?.home_team ?? null,
      date: meta?.date ?? null,
      period: meta?.period ?? null,
      sportsbook: meta?.sportsbook ?? null,
      league: meta?.league ?? meta?.sport ?? null
    },
    points,
    pointCount: points.length,
    rawPointCount,
    droppedCount,
    timestampedCount,
    coverage,
    historyComplete: coverage === 'complete',
    lineHistoryUsable,
    warnings
  };
}

module.exports = {
  MARKET_ALIASES,
  normalizeMarket,
  normalizeSide,
  parseMarketValue,
  parseSpreadValue,
  parseTotalValue,
  parseMoneylineValue,
  parseTimezoneOffsetMinutes,
  inferSharpOddsTimeMs,
  normalizeSharpOddsHistory
};
