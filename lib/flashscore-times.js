'use strict';

/**
 * flashscore-times.js — Read Flashscore tennis match times from cache.
 *
 * Provides a lookup map of player name pairs -> match start times,
 * used by correctTennisTimes() to replace unreliable PP timestamps.
 *
 * Cache is written by scripts/flashscore-scraper.js (Python/Playwright).
 * This module reads it synchronously on import and provides matchers.
 *
 * @module lib/flashscore-times
 */

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, 'tennis-schedule-data', 'flashscore-cache.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — a full day of tennis

// Cache state
let _cache = null;
let _cacheLoadedAt = 0;
let _lookup = null;

/**
 * Load the Flashscore cache from disk. Returns null if unavailable.
 * Cached in memory for the process lifetime (or until TTL expires).
 * @returns {Object|null} Cache data or null
 */
function loadCache() {
  const now = Date.now();
  if (_cache && now - _cacheLoadedAt < CACHE_TTL_MS) {
    return _cache;
  }

  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const data = JSON.parse(raw);

    // Validate basic shape
    if (!data.matches || !Array.isArray(data.matches)) return null;
    if (!data.date) return null;

    _cache = data;
    _cacheLoadedAt = now;
    _lookup = null; // rebuild lookup
    return _cache;
  } catch {
    return null;
  }
}

/**
 * Normalize a player name for matching.
 * "Shapovalov D." -> "shapovalov"
 * "Alvarez Valdes L. C." -> "alvarez valdes"
 * "De Minaur A." -> "de minaur"
 */
function normalizePlayer(name) {
  if (!name) return '';
  return name
    .trim()
    .toLowerCase()
    // Remove trailing initials: "Shapovalov D." -> "shapovalov"
    // Handles: "Name A.", "Name A B.", "Name A. B.", "Name L. C."
    .replace(/(\s+[a-z]\.?\s*[a-z]?\.?)$/i, '')
    // Remove common suffixes
    .replace(/\s+(Jr|Sr|II|III)\.?$/i, '')
    .trim();
}

/**
 * Build a lookup map from the cache.
 * Key: sorted normalized player names joined by "|"
 * Value: { time, tournament, category, surface, id }
 */
function buildLookup() {
  if (_lookup) return _lookup;

  const cache = loadCache();
  if (!cache) {
    _lookup = {};
    return _lookup;
  }

  _lookup = {};
  for (const match of cache.matches) {
    if (!match.time || match.status !== 'scheduled') continue;

    const p1 = normalizePlayer(match.home);
    const p2 = normalizePlayer(match.away);
    if (!p1 || !p2) continue;

    // Create bidirectional key: "player1|player2" (sorted)
    const key = [p1, p2].sort().join('|');
    _lookup[key] = {
      time: match.time, // "HH:MM" in CDT
      date: cache.date,
      tournament: match.tournament,
      category: match.category,
      surface: match.surface,
      id: match.id
    };
  }

  return _lookup;
}

/**
 * Parse PP player names from a game string.
 * "Shapovalov vs Pacheco Mendez" -> ["Shapovalov", "Pacheco Mendez"]
 * "Player1 vs Player2" -> ["Player1", "Player2"]
 *
 * Also handles the format where PP uses last names only.
 */
function parsePPGame(gameStr) {
  if (!gameStr || !gameStr.includes(' vs ')) return [];
  return gameStr.split(' vs ').map(s => s.trim());
}

/**
 * Look up a Flashscore match time for a PP tennis play.
 *
 * @param {string} player1 - First player name (from PP)
 * @param {string} player2 - Second player name (from PP)
 * @returns {Object|null} Match info with time, or null if not found
 *
 * @example
 * const match = lookupMatchTime("Shapovalov", "Pacheco Mendez");
 * // => { time: "22:10", date: "2026-07-29", tournament: "Los Cabos", ... }
 */
function lookupMatchTime(player1, player2) {
  const lookup = buildLookup();
  if (!player1 || !player2) return null;

  const p1 = normalizePlayer(player1);
  const p2 = normalizePlayer(player2);
  const key = [p1, p2].sort().join('|');

  return lookup[key] || null;
}

/**
 * Look up a match time from a PP row (with homeTeam/awayTeam or game field).
 *
 * @param {Object} row - PP play row with homeTeam, awayTeam, and/or game fields
 * @returns {Object|null} Match info with time, or null if not found
 */
function lookupFromPPRow(row) {
  if (!row) return null;

  let homeTeam = String(row.homeTeam || '').trim();
  let awayTeam = String(row.awayTeam || '').trim();

  // Parse from game field if home/away are empty
  if ((!homeTeam || !awayTeam) && row.game && row.game.includes(' vs ')) {
    const parts = parsePPGame(row.game);
    if (parts.length === 2) {
      homeTeam = homeTeam || parts[0];
      awayTeam = awayTeam || parts[1];
    }
  }

  if (!homeTeam || !awayTeam) return null;
  return lookupMatchTime(homeTeam, awayTeam);
}

/**
 * Get cache metadata (date, freshness, match count).
 * Useful for diagnostics.
 */
function getCacheInfo() {
  const cache = loadCache();
  if (!cache) return null;

  return {
    date: cache.date,
    scrapedAt: cache.scrapedAt,
    source: cache.source,
    timezone: cache.timezone,
    totalMatches: cache.totalMatches,
    scheduled: cache.scheduled,
    cachePath: CACHE_PATH,
    fresh: Date.now() - _cacheLoadedAt < CACHE_TTL_MS
  };
}

/**
 * Force-reload the cache from disk (e.g., after running the scraper).
 */
function reloadCache() {
  _cache = null;
  _cacheLoadedAt = 0;
  _lookup = null;
  return loadCache();
}

module.exports = {
  lookupMatchTime,
  lookupFromPPRow,
  getCacheInfo,
  reloadCache,
  normalizePlayer,
  parsePPGame,
  // Exposed for testing
  loadCache,
  buildLookup,
  CACHE_PATH
};
