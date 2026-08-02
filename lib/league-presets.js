'use strict';

/**
 * League ranking presets — static configuration for each sport.
 *
 * Each league defines:
 * - displayName: Human-readable name
 * - minimumScore: Floor score for ranking gate (rows below this are filtered)
 * - marketPriorities: Weight multipliers for market types (higher = more important)
 *
 * Dynamic fields (preferredBooks, sharpBookContext) are computed at runtime
 * by getLeagueRankingPreset() in screen-ranker.js using sharp book lookup.
 */

const LEAGUE_CONFIGS = {
  NBA: {
    displayName: 'NBA',
    minimumScore: 2.0,
    marketPriorities: [
      { match: 'player points', weight: 2.5 },
      { match: 'player rebounds', weight: 2.2 },
      { match: 'player assists', weight: 2.2 },
      { match: 'player pra', weight: 2.6 },
      { match: 'moneyline', weight: 1.5 },
      { match: 'spread', weight: 1.5 },
      { match: 'total', weight: 2.0 }
    ]
  },
  NBASL: {
    displayName: 'NBA Summer League',
    minimumScore: 1.85,
    marketPriorities: [
      { match: 'player points', weight: 2.2 },
      { match: 'player rebounds', weight: 2.0 },
      { match: 'player assists', weight: 2.0 },
      { match: 'moneyline', weight: 1.5 },
      { match: 'spread', weight: 1.5 },
      { match: 'total', weight: 2.0 }
    ]
  },
  MLB: {
    displayName: 'MLB',
    minimumScore: 2.05,
    marketPriorities: [
      { match: 'player strikeouts', weight: 2.6 },
      { match: 'player outs', weight: 2.5 },
      { match: 'player hits', weight: 2.2 },
      { match: 'moneyline', weight: 1.5 },
      { match: 'run line', weight: 1.5 },
      { match: 'total', weight: 2.0 }
    ]
  },
  NFL: {
    displayName: 'NFL',
    minimumScore: 2.0,
    marketPriorities: [
      { match: 'player passing yards', weight: 2.5 },
      { match: 'player rushing yards', weight: 2.4 },
      { match: 'player receptions', weight: 2.3 },
      { match: 'moneyline', weight: 1.5 },
      { match: 'spread', weight: 1.5 },
      { match: 'total', weight: 2.0 }
    ]
  },
  NHL: {
    displayName: 'NHL',
    minimumScore: 1.85,
    marketPriorities: [
      { match: 'player shots', weight: 2.4 },
      { match: 'player points', weight: 2.1 },
      { match: 'moneyline', weight: 1.5 },
      { match: 'puck line', weight: 1.5 },
      { match: 'total', weight: 2.0 }
    ]
  },
  SOCCER: {
    displayName: 'Soccer',
    minimumScore: 1.85,
    marketPriorities: [
      { match: 'moneyline', weight: 1.6 },
      { match: 'spread', weight: 1.6 },
      { match: 'total', weight: 2.1 },
      { match: 'goal scorer', weight: 2.3 },
      { match: 'shots', weight: 2.0 },
      { match: 'corners', weight: 1.9 }
    ]
  },
  MLS: {
    displayName: 'MLS',
    minimumScore: 1.85,
    marketPriorities: [
      { match: 'moneyline', weight: 1.6 },
      { match: 'spread', weight: 1.6 },
      { match: 'total', weight: 2.1 },
      { match: 'goal scorer', weight: 2.3 },
      { match: 'shots', weight: 2.0 },
      { match: 'corners', weight: 1.9 }
    ]
  },
  TENNIS: {
    displayName: 'Tennis',
    minimumScore: 1.9,
    marketPriorities: [
      { match: 'moneyline', weight: 1.7 },
      { match: 'game handicap', weight: 2.2 },
      { match: 'set handicap', weight: 2.4 },
      { match: 'point spread', weight: 2.1 },
      { match: 'total sets', weight: 2.0 },
      { match: 'total games', weight: 2.0 }
    ]
  },
  UFC: {
    displayName: 'UFC',
    minimumScore: 1.8,
    marketPriorities: [
      { match: 'moneyline', weight: 1.8 },
      { match: 'total rounds', weight: 2.1 },
      { match: 'method of victory', weight: 1.8 },
      { match: 'fight goes the distance', weight: 1.8 },
      { match: 'spread', weight: 1.8 }
    ]
  },
  NCAAB: {
    displayName: 'NCAAB',
    minimumScore: 1.85,
    marketPriorities: [
      { match: 'player points', weight: 2.3 },
      { match: 'player rebounds', weight: 2.1 },
      { match: 'player assists', weight: 2.1 },
      { match: 'moneyline', weight: 1.5 },
      { match: 'spread', weight: 1.5 },
      { match: 'total', weight: 2.0 }
    ]
  },
  NCAAF: {
    displayName: 'NCAAF',
    minimumScore: 1.9,
    marketPriorities: [
      { match: 'player passing yards', weight: 2.4 },
      { match: 'player rushing yards', weight: 2.3 },
      { match: 'player receptions', weight: 2.2 },
      { match: 'moneyline', weight: 1.5 },
      { match: 'spread', weight: 1.5 },
      { match: 'total', weight: 2.0 }
    ]
  },
  WNBA: {
    displayName: 'WNBA',
    minimumScore: 1.9,
    marketPriorities: [
      { match: 'player points', weight: 2.5 },
      { match: 'player rebounds', weight: 2.2 },
      { match: 'player assists', weight: 2.2 },
      { match: 'player pra', weight: 2.6 },
      { match: 'moneyline', weight: 1.5 },
      { match: 'spread', weight: 1.5 },
      { match: 'total', weight: 2.0 }
    ]
  }
};

const DEFAULT_CONFIG = {
  displayName: 'Unknown',
  minimumScore: 1.75,
  marketPriorities: [
    { match: 'moneyline', weight: 1.5 },
    { match: 'spread', weight: 1.5 },
    { match: 'total', weight: 2.0 }
  ]
};

/**
 * Get static league configuration.
 * @param {string} league - League name (normalized internally).
 * @returns {Object} League config with displayName, minimumScore, marketPriorities.
 */
function getLeagueConfig(league) {
  const normalized = String(league || '')
    .trim()
    .toUpperCase();
  return LEAGUE_CONFIGS[normalized] || { ...DEFAULT_CONFIG, displayName: normalized || 'Unknown' };
}

/**
 * Get all supported league keys.
 * @returns {string[]} Array of league keys.
 */
function getSupportedLeagues() {
  return Object.keys(LEAGUE_CONFIGS);
}

module.exports = { LEAGUE_CONFIGS, DEFAULT_CONFIG, getLeagueConfig, getSupportedLeagues };
