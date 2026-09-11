'use strict';

// Player prop suffixes — checked FIRST. If a selection ends with one of these
// stat names, it's a player prop even if it starts with "Under" / "Over".
const PLAYER_PROP_SUFFIXES = [
  / Points?$/i,
  / Assists?$/i,
  / Rebounds?$/i,
  / Steals?$/i,
  / Blocks?$/i,
  / Turnovers?$/i,
  / Threes?$/i,
  / Three(-|\s)Point(er)?s?$/i,
  / Pts(\s|\+)/i,
  / Ast(\s|\+)/i,
  / Reb(\s|\+)/i,
  / Strikeouts?$/i,
  / K$/i,
  / Hits? Allowed$/i,
  / Earned Runs?$/i,
  / ERA$/i,
  / WHIP$/i,
  / Outs?$/i,
  / Innings?$/i,
  / Goals?$/i,
  / Saves?$/i,
  / Shots?$/i,
  / Fouls?$/i,
  / Cards?$/i,
  / (Points|Assists|Rebounds|Steals|Blocks|Turnovers|Threes)\s*\+\s*(Points|Assists|Rebounds|Steals|Blocks|Turnovers|Threes)/i
];

// Line/market start patterns — checked SECOND, only if not a player prop
const LINE_START_PATTERNS = [/^(Under|Over)\s+\d/i, /^-?\d+\.?\d*$/, /^\+?\d+\.?\d*$/];

// Team city prefixes — if a selection starts with one of these, it's a team
const TEAM_CITY_PREFIXES = [
  /^(New York|Los Angeles|San Francisco|San Diego|San Jose|Las Vegas|Golden State|Oklahoma City|Tampa Bay|Kansas City|St\.? Louis|New Orleans|Portland|Salt Lake City|Toronto|Minnesota|Washington|Boston|Philadelphia|Chicago|Detroit|Cleveland|Miami|Atlanta|Houston|Dallas|Phoenix|Denver|Seattle|Milwaukee|Indianapolis|Charlotte|Orlando|Cincinnati|Pittsburgh|Baltimore|Arizona|Colorado|Texas)/i
];

function isPlayerSelection(selection) {
  if (!selection || typeof selection !== 'string') return false;
  const trimmed = selection.trim();
  if (!trimmed) return false;

  // 0. Explicit team-total guard — must take priority over player suffix
  // checks so that strings like "Team Total Points" are NOT player props.
  if (/Team Total/i.test(trimmed)) return false;

  // 1. Check player prop suffixes FIRST
  // "Under 7.5 strikeouts" would match the Strikeouts suffix → player prop
  for (const suffix of PLAYER_PROP_SUFFIXES) {
    if (suffix.test(trimmed)) return true;
  }

  // 2. Check line/market start patterns
  for (const pattern of LINE_START_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }

  // 3. Check if selection starts with + or - number
  if (/^[+-]\d/.test(trimmed)) return false;

  // 4. Check for "TeamName +/-N" pattern
  const teamLineMatch = trimmed.match(/^(.+?)\s+[+-]\d/);
  if (teamLineMatch) {
    const base = teamLineMatch[1].trim();
    for (const cp of TEAM_CITY_PREFIXES) {
      if (cp.test(base)) return false;
    }
  }

  // 5. Team city prefix
  for (const cp of TEAM_CITY_PREFIXES) {
    if (cp.test(trimmed)) return false;
  }

  // 6. Contains "vs" or "@" → matchup
  if (/\bvs\b/i.test(trimmed) || trimmed.includes('@')) return false;

  // 7. Default: assume it's a player
  return true;
}

module.exports = { isPlayerSelection };
