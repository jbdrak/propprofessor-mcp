'use strict';

const { getMlbGameContext } = require('./propprofessor-mlb-game-context');
const { getBasketballGameContext } = require('./propprofessor-basketball-game-context');
const { getNhlContext } = require('./propprofessor-nhl-context');
const { getTennisContext } = require('./propprofessor-tennis-context');
const { getUfcContext } = require('./propprofessor-ufc-context');
const { LruCache } = require('./propprofessor-lru-cache');
const { parseGameStartMs } = require('./propprofessor-shared-utils');

const GAME_CONTEXT_CACHE_TTL_MS = 30 * 60 * 1000;
const _gameContextCache = new LruCache(128);

/**
 * Parse a game string like "New York Mets vs Philadelphia Phillies"
 * into { team1, team2 }.
 */
function parseGameString(game) {
  if (!game || typeof game !== 'string') return { team1: '', team2: '', separator: null };
  const match = game.match(/^(.+?)\s+(vs|@|at)\s+(.+?)$/i);
  if (match) {
    return { team1: match[1].trim(), team2: match[3].trim(), separator: match[2].toLowerCase() };
  }
  // Legacy fallback for edge cases without a clear separator
  const parts = game.split(/\s+(?:vs|@|at)\s+/i);
  if (parts.length >= 2) {
    return { team1: (parts[0] || '').trim(), team2: (parts[1] || '').trim(), separator: null };
  }
  return { team1: game.trim(), team2: '', separator: null };
}

/**
 * Guess the game date from start field or default to today.
 */
function parseGameDate(start) {
  const ms = parseGameStartMs(start);
  if (!ms) return new Date().toISOString().split('T')[0];
  return new Date(ms).toISOString().split('T')[0];
}

/**
 * Map league strings to canonical sport names for context lookup.
 */
function canonicalSport(sport) {
  if (!sport || typeof sport !== 'string') return null;
  const map = {
    NBA: 'NBA',
    WNBA: 'WNBA',
    NCAAB: 'NCAAB',
    NCAAF: 'NCAAF',
    MLB: 'MLB',
    Tennis: 'Tennis',
    NHL: 'NHL',
    NFL: 'NFL',
    UFC: 'UFC',
    Soccer: 'Soccer'
  };
  return map[sport] || null;
}

/**
 * Get sport-specific game context for a selection.
 *
 * @param {Object} options
 * @param {string} options.sport - League/sport name
 * @param {string} [options.selection] - The selection/player string
 * @param {string} [options.game] - Full game description (e.g. "Lakers vs Celtics")
 * @param {string} [options.start] - Game start time ISO string
 * @param {string} [options.market] - Market type
 * @returns {Promise<Object>}
 */
async function getGameContext(opts = {}) {
  const { sport, selection, game, start, market } =
    /** @type {{ sport: string, selection?: string, game?: string, start?: string, market?: string }} */ (opts);
  const csport = canonicalSport(sport);
  // Cache key includes `start` so a rescheduled match doesn't return a
  // stale result. Without this, RC3: a match tagged with start=T-60min
  // gets cached; if the match is rescheduled to start 24h later, calls
  // for 30 more minutes return the original cached `unknown` result.
  // `market` is part of the key too: Tennis Elo is Moneyline-only, so a
  // Moneyline result must never bleed into a Total Games call (and vice
  // versa) from the shared game-context cache.
  const cacheKey = `gc:${csport || '?'}:${selection || ''}:${game || ''}:${start || ''}:${market || ''}`;
  const cached = _gameContextCache.get(cacheKey);
  if (cached) {
    // Freshness rule: if the game is imminent (tipping within 2h), don't
    // trust a cache entry older than 5min. A reschedule right before tip
    // would otherwise serve stale context up to 30min after the change.
    // For non-imminent games, the 30min TTL is fine — surface/level don't
    // change at distance from tip.
    const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
    const startMs = start ? new Date(start).getTime() : Infinity;
    const isImminent = Number.isFinite(startMs) && startMs - Date.now() < 2 * 60 * 60 * 1000;
    if (!isImminent || ageMs < 5 * 60 * 1000) {
      return { ...cached, cached: true };
    }
  }

  const { team1, team2, separator } = parseGameString(game);
  const gameDate = parseGameDate(start);

  let result;

  switch (csport) {
    case 'MLB': {
      try {
        const { findMlbGamePk } = require('./propprofessor-mlb-game-context');
        let gamePk = null;
        // "@" separator is directional: team1 = away, team2 = home.
        // "vs"/"at" are ambiguous — try both orderings.
        if (separator === '@') {
          gamePk = game ? await findMlbGamePk({ isoDate: gameDate, awayTeam: team1, homeTeam: team2 }) : null;
        } else {
          // Try initial ordering, then flipped if no match
          gamePk = game ? await findMlbGamePk({ isoDate: gameDate, awayTeam: team1, homeTeam: team2 }) : null;
          if (!gamePk) {
            gamePk = await findMlbGamePk({ isoDate: gameDate, awayTeam: team2, homeTeam: team1 });
          }
        }
        if (gamePk) {
          result = await getMlbGameContext({ gamePk });
        } else {
          result = {
            ok: true,
            sport: 'MLB',
            riskFlag: 'unknown',
            riskSummary: 'gamePk not resolved for MLB context',
            signals: {}
          };
        }
      } catch {
        result = { ok: true, sport: 'MLB', riskFlag: 'unknown', riskSummary: 'MLB context unavailable', signals: {} };
      }
      break;
    }

    case 'NBA':
    case 'WNBA':
    case 'NCAAB': {
      result = await getBasketballGameContext({
        gamePk: game,
        sport: csport,
        awayTeam: team1,
        homeTeam: team2,
        gameDate
      });
      break;
    }

    case 'Tennis': {
      result = await getTennisContext({
        player1: team1 || selection,
        player2: team2,
        tournament: game,
        start: start,
        market: market,
        // Thread the exact bet selection so the Elo shadow context can
        // resolve selectedProbability against the resolved player.
        selection: selection
      });
      break;
    }

    case 'NHL': {
      result = await getNhlContext({
        gamePk: game,
        awayTeam: team1,
        homeTeam: team2,
        gameDate
      });
      break;
    }

    case 'UFC': {
      result = await getUfcContext({
        event: game || selection,
        weightClass: null // typically not available from screen data
      });
      break;
    }

    default: {
      result = {
        ok: true,
        sport: csport || null,
        gamePk: game || null,
        riskFlag: 'clean',
        riskSummary: selection ? `${csport || 'Unknown'} — no game-level context available` : null,
        signals: {},
        fetchedAt: new Date().toISOString()
      };
      break;
    }
  }

  // Fill in gamePk if not set
  if (!result.gamePk) result.gamePk = game || null;
  if (!result.cached) result.cached = false;

  // Cache non-error results
  if (result.riskFlag !== 'error') {
    _gameContextCache.set(cacheKey, result, GAME_CONTEXT_CACHE_TTL_MS);
  }

  return result;
}

module.exports = { getGameContext, parseGameString };
