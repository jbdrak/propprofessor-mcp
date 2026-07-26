'use strict';

const { buildScreenTools } = require('./screen');
const { buildValidationTools } = require('./validation');
const { buildContextTools } = require('./context');
const { buildPicksTools } = require('./picks');
const { buildMetaTools } = require('./meta');

const TOOL_CATEGORIES = {
  all_slates: 'discovery',
  ask: 'discovery',
  ev_candidates: 'discovery',
  fantasy_optimizer: 'discovery',
  sharp_consensus: 'discovery',
  get_market_registry: 'discovery',
  scan: 'screen',
  quick_screen: 'screen',
  screen_ranked: 'screen',
  staking_plan: 'screen',
  ufc_card: 'screen',
  smart_bet: 'screen',
  sharp_alerts: 'alerts',
  find_best_price: 'drill_down',
  get_play_details: 'drill_down',
  validate_play: 'drill_down',
  get_alerts: 'research',
  smart_money: 'research',
  mlb_game_context: 'research',
  player_context: 'research',
  get_pick_history: 'tracking',
  get_pick_stats: 'tracking',
  log_pick: 'tracking',
  place_bet: 'tracking',
  resolve_pick: 'tracking',
  clear_score_timeline: 'admin',
  manage_hidden_bets: 'admin',
  get_started: 'meta',
  health_status: 'meta',
  league_presets: 'meta',
  today: 'meta'
};

const LITE_MODE_TOOLS = new Set([
  'ask',
  'health_status',
  'today',
  'get_market_registry',
  'quick_screen',
  'find_best_price',
  'validate_play',
  'get_play_details',
  'player_context',
  'log_pick',
  'place_bet',
  'get_pick_history',
  'resolve_pick',
  'smart_bet',
  'sharp_alerts'
]);

/**
 * Build the full array of MCP tool definition objects for all ProppProfessor tools.
 * @param {Object} [options]
 * @param {('full'|'lite')} [options.mode='full']
 * @returns {Array}
 */
function buildToolDefinitions({ mode = 'full' } = {}) {
  const allTools = [
    ...buildScreenTools(),
    ...buildValidationTools(),
    ...buildContextTools(),
    ...buildPicksTools(),
    ...buildMetaTools()
  ];

  const withCategories = allTools.map((def) => ({
    ...def,
    category: TOOL_CATEGORIES[def.name] || 'meta'
  }));

  if (mode === 'lite') {
    return withCategories.filter((def) => LITE_MODE_TOOLS.has(def.name)).sort((a, b) => a.name.localeCompare(b.name));
  }

  return withCategories.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { buildToolDefinitions, TOOL_CATEGORIES, LITE_MODE_TOOLS };
