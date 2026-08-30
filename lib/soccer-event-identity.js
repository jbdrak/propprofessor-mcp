'use strict';

function isSoccer(row = {}) {
  return /^(soccer|mls)$/i.test(String(row.league || row.sport || row.gameType || '').trim());
}

/**
 * Build a safe soccer matchup label. Soccer screen rows don't consistently
 * encode home-first ordering, so only an explicit venue marker may produce an
 * away-at-home label.
 * @param {Object} row
 * @returns {{teamA: string, teamB: string, venueOrderVerified: boolean, label: string}}
 */
function getSoccerEventIdentity(row = {}) {
  const home = String(row.homeTeam || '').trim();
  const away = String(row.awayTeam || '').trim();
  const parts = String(row.game || row.matchup || '')
    .split(/\s+vs\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const teamA = home || parts[0] || '';
  const teamB = away || parts[1] || '';
  const venueOrderVerified = row.venueOrderVerified === true || row.homeAwayVerified === true;
  const label = venueOrderVerified ? `${teamB} @ ${teamA}` : `${teamA} vs ${teamB} (home/away unverified)`;
  return { teamA, teamB, venueOrderVerified, label };
}

function buildMatchupLabel(row = {}) {
  if (isSoccer(row)) return getSoccerEventIdentity(row).label;
  const home = String(row.homeTeam || '').trim();
  const away = String(row.awayTeam || '').trim();
  return row.game || row.matchup || (home && away ? `${home} vs ${away}` : '');
}

module.exports = { buildMatchupLabel, getSoccerEventIdentity, isSoccer };
