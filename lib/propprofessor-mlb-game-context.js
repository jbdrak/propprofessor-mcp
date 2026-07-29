'use strict';

const cp = require('child_process');
const { LruCache } = require('./propprofessor-lru-cache');

// Note: same as propprofessor-news-sources.js, we cannot capture
// promisify(execFile) at module load time because tests mock cp.execFile by
// reassignment. Use a fresh promise on each call so the mock is honored.
const pExecFile = (...args) =>
  new Promise((resolve, reject) => {
    cp.execFile(/** @type {*} */ (args), (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });

// MLB Stats API base — public, no key required.
const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';
// Open-Meteo — public, no key, free for non-commercial.
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';

const CURL_TIMEOUT_MS = 10000;

// Cache TTLs.
// Schedule/probable-pitcher data changes slowly until lineups lock; refresh
// every 30 minutes. Weather changes hourly. Lineups (from boxscore) lock at
// first pitch and don't change until the next game.
const SCHEDULE_CACHE_TTL_MS = 30 * 60 * 1000;
const VENUE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // Venues don't change.
const WEATHER_CACHE_TTL_MS = 60 * 60 * 1000; // Refresh hourly.
const BOXSCORE_CACHE_TTL_MS = 5 * 60 * 1000; // Boxscore is final once game is live.

const _scheduleCache = new LruCache(64);
const _venueCache = new LruCache(64);
const _weatherCache = new LruCache(256);
const _boxscoreCache = new LruCache(64);

/**
 * Park factor table (run factor, 3-year rolling avg from public sources).
 * Values: >1.0 = hitter-friendly, <1.0 = pitcher-friendly.
 * Park orientation: azimuthAngle is the home-plate-to-center-field bearing
 * in degrees (0=N, 90=E, 180=S, 270=W). Wind blowing FROM this direction
 * blows OUT to center. Wind blowing TOWARD this direction blows IN.
 *
 * Curated subset — full 30-park table lives in the same data set; missing
 * parks fall back to neutral (1.0, no orientation) which is a safe default.
 */
const PARK_FACTORS = {
  22: { name: 'Dodger Stadium', runFactor: 0.96, azimuth: 26 }, // Slight pitcher park
  3309: { name: 'Nationals Park', runFactor: 1.01, azimuth: 32 },
  1: { name: 'Angel Stadium', runFactor: 0.97, azimuth: 25 },
  2: { name: 'Busch Stadium', runFactor: 0.96, azimuth: 38 },
  3: { name: 'Chase Field', runFactor: 1.05, azimuth: 0 }, // Retractable roof, neutral
  4: { name: 'Wrigley Field', runFactor: 1.04, azimuth: 30 }, // Wind can be a factor
  5: { name: 'Citizens Bank Park', runFactor: 1.07, azimuth: 30 },
  7: { name: 'Comerica Park', runFactor: 0.97, azimuth: 15 },
  8: { name: 'Guaranteed Rate Field', runFactor: 1.02, azimuth: 25 },
  9: { name: 'Great American Ball Park', runFactor: 1.1, azimuth: 28 },
  10: { name: 'Kauffman Stadium', runFactor: 0.95, azimuth: 25 },
  11: { name: 'Minute Maid Park', runFactor: 1.04, azimuth: 0 }, // Retractable
  12: { name: 'Rogers Centre', runFactor: 1.02, azimuth: 0 }, // Retractable
  14: { name: 'Progressive Field', runFactor: 0.99, azimuth: 25 },
  15: { name: 'T-Mobile Park', runFactor: 0.92, azimuth: 31 }, // Strong pitcher park
  16: { name: 'Tropicana Field', runFactor: 0.97, azimuth: 0 }, // Dome
  17: { name: 'Target Field', runFactor: 1.0, azimuth: 28 },
  18: { name: 'Oracle Park', runFactor: 0.93, azimuth: 30 }, // Strong pitcher park
  19: { name: 'Citi Field', runFactor: 0.96, azimuth: 27 },
  20: { name: 'PNC Park', runFactor: 0.97, azimuth: 28 },
  21: { name: 'Coors Field', runFactor: 1.18, azimuth: 30 }, // Extreme hitter park
  23: { name: 'Globe Life Field', runFactor: 0.98, azimuth: 0 }, // Retractable
  24: { name: 'Truist Park', runFactor: 1.04, azimuth: 30 },
  25: { name: 'loanDepot park', runFactor: 0.96, azimuth: 25 },
  26: { name: 'American Family Field', runFactor: 1.03, azimuth: 27 },
  27: { name: 'Sutter Health Park', runFactor: 1.0, azimuth: 28 },
  28: { name: 'Daikin Park', runFactor: 0.99, azimuth: 25 },
  31: { name: 'George M. Steinbrenner Field', runFactor: 1.0, azimuth: 30 },
  32: { name: 'Hiram Bithorn Stadium', runFactor: 1.0, azimuth: 30 }
};

const NEUTRAL_PARK = { name: 'Unknown Park', runFactor: 1.0, azimuth: null };

/**
 * Fetch a URL via curl and return parsed JSON. Throws on non-2xx or invalid JSON.
 * Uses curl instead of node:fetch so we can use the same pattern as the rest of
 * the codebase (and so tests can mock cp.execFile the same way).
 *
 * @param {string} url
 * @returns {Promise<*>} Parsed JSON
 */
async function fetchJson(url) {
  const { stdout } = await pExecFile('curl', ['-fsS', '--max-time', String(CURL_TIMEOUT_MS / 1000), url], {
    timeout: CURL_TIMEOUT_MS
  });
  return JSON.parse(stdout);
}

/**
 * Fetch the MLB schedule for a single date. Hydrates probablePitcher so we get
 * starting pitcher names in the same call. Returns the array of games.
 *
 * @param {string} isoDate - YYYY-MM-DD
 * @returns {Promise<Array<Object>>}
 */
async function fetchScheduleForDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new Error(`invalid isoDate: ${isoDate}`);
  }
  const cacheKey = `schedule:${isoDate}`;
  const cached = _scheduleCache.get(cacheKey);
  if (cached) return cached;
  const url = `${MLB_API_BASE}/schedule?sportId=1&date=${isoDate}&hydrate=probablePitcher,game(content(summary)),venue`;
  const response = await fetchJson(url);
  const games = [];
  for (const dateEntry of response.dates || []) {
    for (const game of dateEntry.games || []) {
      games.push(game);
    }
  }
  _scheduleCache.set(cacheKey, games, SCHEDULE_CACHE_TTL_MS);
  return games;
}

/**
 * Find a game in the schedule by its gamePk.
 *
 * @param {number|string} gamePk
 * @returns {Promise<Object|null>}
 */
async function fetchGameByPk(gamePk) {
  const pk = String(gamePk);
  // gamePk is the schedule key — we need to know which date to fetch. The
  // MCP's validate_play hands us the gamePk from the screen row, but the
  // schedule endpoint is date-keyed. We can call the game-feed endpoint
  // directly which returns the game regardless of date, with all hydration
  // we need.
  const cacheKey = `game:${pk}`;
  const cached = _scheduleCache.get(cacheKey);
  if (cached) return cached;
  const url = `${MLB_API_BASE}/schedule?gamePk=${pk}&hydrate=probablePitcher,game(content(summary)),venue`;
  const response = await fetchJson(url);
  for (const dateEntry of response.dates || []) {
    for (const game of dateEntry.games || []) {
      if (String(game.gamePk) === pk) {
        _scheduleCache.set(cacheKey, game, SCHEDULE_CACHE_TTL_MS);
        return game;
      }
    }
  }
  return null;
}

/**
 * Fetch venue details including coordinates. The /venues endpoint requires
 * ?hydrate=location to return defaultCoordinates.
 *
 * @param {number|string} venueId
 * @returns {Promise<Object|null>}
 */
async function fetchVenue(venueId) {
  const id = String(venueId);
  const cacheKey = `venue:${id}`;
  const cached = _venueCache.get(cacheKey);
  if (cached) return cached;
  const url = `${MLB_API_BASE}/venues/${id}?hydrate=location`;
  const response = await fetchJson(url);
  const venue = (response.venues && response.venues[0]) || null;
  if (venue) _venueCache.set(cacheKey, venue, VENUE_CACHE_TTL_MS);
  return venue;
}

/**
 * Fetch hourly weather for a venue at game time. Open-Meteo is free, no key.
 * Returns a compact slice around the game's start hour.
 *
 * @param {{ latitude: number, longitude: number, isoDate: string, isoHour: string }} params
 * @returns {Promise<Object|null>} { windSpeedKmh, windDirectionDeg, temperatureC, precipProbPct, hour }
 */
async function fetchWeatherForGame({ latitude, longitude, isoDate, isoHour } = /** @type {any} */ ({})) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const cacheKey = `weather:${latitude.toFixed(3)}:${longitude.toFixed(3)}:${isoDate}`;
  const cached = _weatherCache.get(cacheKey);
  let data;
  if (cached) {
    data = cached;
  } else {
    const url = `${OPEN_METEO_BASE}?latitude=${latitude}&longitude=${longitude}&hourly=wind_speed_10m,wind_direction_10m,temperature_2m,precipitation_probability&start_date=${isoDate}&end_date=${isoDate}&timezone=UTC`;
    const response = await fetchJson(url).catch(() => null);
    if (!response) return null;
    data = response;
    _weatherCache.set(cacheKey, data, WEATHER_CACHE_TTL_MS);
  }
  if (!data || !data.hourly || !Array.isArray(data.hourly.time)) return null;
  const idx = data.hourly.time.findIndex((t) => t === isoHour);
  if (idx === -1) {
    // Fall back to the closest hour.
    const targetHour = Number(isoHour?.slice(11, 13) || 0);
    let bestIdx = 0;
    let bestDist = 99;
    for (let i = 0; i < data.hourly.time.length; i++) {
      const h = Number(data.hourly.time[i].slice(11, 13));
      const d = Math.abs(h - targetHour);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return extractWeatherSlice(data, bestIdx);
  }
  return extractWeatherSlice(data, idx);
}

function extractWeatherSlice(data, idx) {
  return {
    windSpeedKmh: data.hourly.wind_speed_10m?.[idx] ?? null,
    windDirectionDeg: data.hourly.wind_direction_10m?.[idx] ?? null,
    temperatureC: data.hourly.temperature_2m?.[idx] ?? null,
    precipProbPct: data.hourly.precipitation_probability?.[idx] ?? null,
    hour: data.hourly.time?.[idx] ?? null
  };
}

/**
 * Fetch the boxscore for a game. If the game hasn't started yet, the
 * battingOrder arrays will be empty. Once lineups lock (~30-60 min before
 * first pitch), they populate.
 *
 * @param {number|string} gamePk
 * @returns {Promise<Object|null>}
 */
async function fetchBoxscore(gamePk) {
  const pk = String(gamePk);
  const cacheKey = `boxscore:${pk}`;
  const cached = _boxscoreCache.get(cacheKey);
  if (cached) return cached;
  const url = `${MLB_API_BASE}/game/${pk}/boxscore`;
  try {
    const response = await fetchJson(url);
    _boxscoreCache.set(cacheKey, response, BOXSCORE_CACHE_TTL_MS);
    return response;
  } catch {
    // 404 / not-found is fine — game may not have lineups posted yet.
    return null;
  }
}

/**
 * Get the park-factor record for a venue. Falls back to neutral for unknown
 * parks (most minor-league venues, special-event sites).
 *
 * @param {number|string} venueId
 * @returns {{name: string, runFactor: number, azimuth: number|null}}
 */
function getParkFactor(venueId) {
  const id = Number(venueId);
  return PARK_FACTORS[id] || NEUTRAL_PARK;
}

/**
 * Assess game-level risk based on weather + park + pitcher confirmation.
 * Mirrors the risk-flag vocabulary used by player_context so validate_play
 * can apply the same downgrades.
 *
 * @param {Object} args
 * @param {Object|null} args.weather - Output of fetchWeatherForGame
 * @param {{runFactor: number, azimuth: number|null}} args.park
 * @param {Object} args.game - Raw MLB schedule game object
 * @param {Object|null} args.boxscore - Raw boxscore (null if lineups not posted)
 * @returns {{riskFlag: 'clean'|'low'|'medium'|'high', riskSummary: string, signals: Object}}
 */
function assessGameContextRisk({ weather, park, game, boxscore }) {
  const signals = {};
  const reasons = [];

  // 1. Wind effect (only for open-air parks with azimuth).
  let windEffect = 'neutral';
  if (
    weather &&
    park.azimuth !== null &&
    Number.isFinite(weather.windSpeedKmh) &&
    Number.isFinite(weather.windDirectionDeg)
  ) {
    const speed = weather.windSpeedKmh;
    const windFrom = weather.windDirectionDeg; // meteorological "wind from" direction
    // Angle between wind direction and the park's home-plate-to-center bearing.
    // 0 = wind blowing out to center. 180 = wind blowing in from center.
    let diff = Math.abs(windFrom - park.azimuth);
    if (diff > 180) diff = 360 - diff;
    // If diff < 90, wind is blowing roughly OUT to center. If > 90, blowing IN.
    const blowingOut = diff < 90;
    // Convert wind speed to mph for the standard 10/15/20 thresholds.
    const mph = speed * 0.621371;
    signals.windMph = Number(mph.toFixed(1));
    signals.windDirectionDeg = windFrom;
    signals.blowingOut = blowingOut;
    if (mph >= 15 && blowingOut && park.runFactor >= 1.04) {
      windEffect = 'strong-help-hitters';
      reasons.push(`strong wind (${signals.windMph}mph) blowing out at hitter-friendly park (PF ${park.runFactor})`);
    } else if (mph >= 12 && blowingOut) {
      windEffect = 'moderate-help-hitters';
      reasons.push(`moderate wind (${signals.windMph}mph) blowing out`);
    } else if (mph >= 15 && !blowingOut) {
      windEffect = 'strong-help-pitchers';
      reasons.push(`strong wind (${signals.windMph}mph) blowing in`);
    }
  }

  // 2. Precipitation risk (any non-trivial chance of rain).
  let precipRisk = 'none';
  if (weather && Number.isFinite(weather.precipProbPct) && weather.precipProbPct >= 40) {
    precipRisk = weather.precipProbPct >= 70 ? 'high' : 'moderate';
    reasons.push(`precipitation risk ${weather.precipProbPct}%`);
  }

  // 3. Pitcher confirmation. Probable = announced day-of, can still change.
  // Confirmed = in the boxscore's "pitchers" list. TBD = no announcement.
  let pitcherStatus = 'TBD';
  if (game && game.teams) {
    const away = game.teams.away?.probablePitcher?.fullName || null;
    const home = game.teams.home?.probablePitcher?.fullName || null;
    signals.awayPitcher = away;
    signals.homePitcher = home;
    if (away && home) pitcherStatus = 'probable';
    // Boxscore confirmation (only meaningful once lineups are posted).
    if (boxscore && boxscore.teams) {
      const awayConfirmed = !!boxscore.teams.away?.pitchers?.length;
      const homeConfirmed = !!boxscore.teams.home?.pitchers?.length;
      if (awayConfirmed && homeConfirmed) pitcherStatus = 'confirmed';
    }
  }

  // 4. Lineup lock status.
  let lineupStatus = 'pending';
  if (boxscore && boxscore.teams) {
    const awayBatters = boxscore.teams.away?.battingOrder?.length || 0;
    const homeBatters = boxscore.teams.home?.battingOrder?.length || 0;
    if (awayBatters >= 9 && homeBatters >= 9) {
      lineupStatus = 'locked';
    } else if (awayBatters > 0 || homeBatters > 0) {
      lineupStatus = 'partial';
    }
  }
  signals.lineupStatus = lineupStatus;
  signals.pitcherStatus = pitcherStatus;

  // Compose the risk flag.
  let riskFlag = 'clean';
  // High: extreme weather event, or a major surprise in the pitching matchup.
  if (precipRisk === 'high' || (windEffect === 'strong-help-hitters' && park.runFactor >= 1.1)) {
    riskFlag = 'high';
  } else if (
    precipRisk === 'moderate' ||
    windEffect === 'strong-help-hitters' ||
    windEffect === 'strong-help-pitchers'
  ) {
    riskFlag = 'medium';
  } else if (reasons.length > 0) {
    riskFlag = 'low';
  }

  // Pitcher TBD is informational, not a risk escalation on its own — it just
  // means we don't have confirmation. Don't downgrade.

  return /** @type {{ riskFlag: 'clean'|'low'|'high'|'medium', riskSummary: string|null, signals: { lineupStatus: string, pitcherStatus: string } }} */ ({
    riskFlag,
    riskSummary: reasons.length > 0 ? reasons.join('; ') : null,
    signals
  });
}

/**
 * Get full game context for an MLB game. Public entry point.
 *
 * @param {Object} options
 * @param {number|string} options.gamePk - MLB gamePk
 * @returns {Promise<{ok: boolean, gamePk?: string|null, pitchers?: Object, weather?: Object|null, park?: Object, lineups?: Object, riskFlag?: string, riskSummary?: string|null, signals?: Object, fetchedAt?: string, cached?: boolean, error?: {code: string, message: string} }>}
 */
async function getMlbGameContext(opts = {}) {
  const { gamePk } = /** @type {{ gamePk?: string|number }} */ (opts);
  const pk = String(gamePk || '').trim();
  if (!pk) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'gamePk is required' } };
  }

  const fetchedAt = new Date().toISOString();
  let cacheHit = false;
  // Top-level result cache (1 hour, max 256 entries).
  const resultCacheKey = `ctx:${pk}`;
  const cachedResult = _scheduleCache.get(resultCacheKey);
  if (cachedResult) {
    return { ...cachedResult, cached: true };
  }

  const game = await fetchGameByPk(pk).catch((err) => {
    return { __error: err?.message || String(err) };
  });
  if (!game) {
    return {
      ok: false,
      gamePk: pk,
      error: { code: 'NOT_FOUND', message: `no MLB game found for gamePk ${pk}` },
      fetchedAt
    };
  }
  if (game.__error) {
    return { ok: false, gamePk: pk, error: { code: 'API_ERROR', message: game.__error }, fetchedAt };
  }

  const venueId = game.venue?.id || null;
  const park = venueId ? getParkFactor(venueId) : NEUTRAL_PARK;
  const pitchers = {
    away: game.teams?.away?.probablePitcher?.fullName || null,
    home: game.teams?.home?.probablePitcher?.fullName || null
  };

  // Run weather + boxscore fetches in parallel — they're independent.
  const venuePromise = venueId ? fetchVenue(venueId) : Promise.resolve(null);
  const boxscorePromise = fetchBoxscore(pk);
  const [venue, boxscore] = await Promise.all([venuePromise, boxscorePromise]);

  const coords = venue?.location?.defaultCoordinates || null;
  const gameDate = game.officialDate || (game.gameDate ? game.gameDate.slice(0, 10) : null);
  const gameHour = game.gameDate ? game.gameDate.slice(0, 13) + ':00' : null;
  const weather =
    coords && gameDate && gameHour
      ? await fetchWeatherForGame({
          latitude: coords.latitude,
          longitude: coords.longitude,
          isoDate: gameDate,
          isoHour: gameHour
        })
      : null;

  const risk = assessGameContextRisk({ weather, park, game, boxscore });
  const lineups = {
    status: risk.signals.lineupStatus,
    awayBatters: boxscore?.teams?.away?.battingOrder?.length || 0,
    homeBatters: boxscore?.teams?.home?.battingOrder?.length || 0
  };

  const result = {
    ok: true,
    gamePk: pk,
    gameDate: gameDate,
    gameTime: game.gameDate || null,
    venue: venue
      ? {
          id: venueId,
          name: venue.name,
          city: venue.location?.city || null,
          state: venue.location?.stateAbbrev || null
        }
      : { id: venueId, name: park.name },
    pitchers,
    park: { runFactor: park.runFactor, azimuth: park.azimuth },
    weather,
    lineups,
    riskFlag: risk.riskFlag,
    riskSummary: risk.riskSummary,
    signals: risk.signals,
    fetchedAt,
    cached: cacheHit
  };
  _scheduleCache.set(resultCacheKey, result, SCHEDULE_CACHE_TTL_MS);
  return result;
}

/**
 * Find the MLB gamePk for a given date + matchup. The screen rows use
 * "MLB:PREMATCH:<awaySlug>:<homeSlug>:<unixStart>" as the gameId, where the
 * last segment is a Unix timestamp, NOT the MLB gamePk. The validate_play
 * flow extracts homeTeam/awayTeam/start from the matching screen row, then
 * calls this helper to resolve the real MLB gamePk before calling
 * getMlbGameContext.
 *
 * @param {Object} options
 * @param {string} options.isoDate - YYYY-MM-DD (UTC date of the game)
 * @param {string} options.awayTeam - Away team name (e.g. "Tampa Bay Rays")
 * @param {string} options.homeTeam - Home team name (e.g. "Los Angeles Dodgers")
 * @param {number|string} [options.unixStart] - Unix timestamp for disambiguation
 * @returns {Promise<string|null>} The MLB gamePk, or null if no match.
 */
async function findMlbGamePk(opts = {}) {
  const { isoDate, awayTeam, homeTeam, unixStart } =
    /** @type {{ isoDate?: string, awayTeam?: string, homeTeam?: string, unixStart?: number|string }} */ (opts);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || '')) return null;
  if (!awayTeam || !homeTeam) return null;
  const normalizeName = (value) =>
    String(value || '')
      .trim()
      .toLowerCase();
  const normalizedAwayTeam = normalizeName(awayTeam);
  const normalizedHomeTeam = normalizeName(homeTeam);
  const cacheKey = `lookup:${isoDate}:${normalizedAwayTeam}:${normalizedHomeTeam}`;
  const cached = _scheduleCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let games;
  try {
    games = await fetchScheduleForDate(isoDate);
  } catch {
    _scheduleCache.set(cacheKey, null, SCHEDULE_CACHE_TTL_MS);
    return null;
  }
  const awayLower = normalizedAwayTeam;
  const homeLower = normalizedHomeTeam;
  let candidates = games.filter((g) => {
    const a = normalizeName(g.teams?.away?.team?.name || '');
    const h = normalizeName(g.teams?.home?.team?.name || '');
    return a === awayLower && h === homeLower;
  });

  // "vs" and "at" game strings don't encode home/away ordering.
  // If the direct match fails, try the flipped ordering.
  if (!candidates.length) {
    candidates = games.filter((g) => {
      const a = normalizeName(g.teams?.away?.team?.name || '');
      const h = normalizeName(g.teams?.home?.team?.name || '');
      return a === homeLower && h === awayLower;
    });
  }

  if (!candidates.length) {
    _scheduleCache.set(cacheKey, null, SCHEDULE_CACHE_TTL_MS);
    return null;
  }

  // If unixStart is provided and multiple candidates, pick the closest game time
  if (candidates.length > 1 && Number.isFinite(Number(unixStart))) {
    const targetMs = Number(unixStart) * 1000;
    let best = candidates[0];
    let bestDiff = Infinity;
    for (const c of candidates) {
      const gameMs = new Date(c.gameDate || '').getTime();
      if (Number.isFinite(gameMs)) {
        const diff = Math.abs(gameMs - targetMs);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = c;
        }
      }
    }
    const result = String(best.gamePk);
    _scheduleCache.set(cacheKey, result, SCHEDULE_CACHE_TTL_MS);
    return result;
  }

  const result = String(candidates[0].gamePk);
  _scheduleCache.set(cacheKey, result, SCHEDULE_CACHE_TTL_MS);
  return result;
}

module.exports = {
  getMlbGameContext,
  findMlbGamePk,
  // Exports for tests + future tool wiring
  fetchScheduleForDate,
  fetchGameByPk,
  fetchVenue,
  fetchWeatherForGame,
  fetchBoxscore,
  getParkFactor,
  assessGameContextRisk,
  PARK_FACTORS
};
