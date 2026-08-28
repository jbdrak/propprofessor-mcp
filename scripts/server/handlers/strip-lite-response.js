'use strict';

/**
 * Strip heavy post-validation fields from a quick_screen response when
 * lite=true while preserving the compact research and slate summaries.
 *
 * @param {object} response - Formatted quick_screen response
 * @returns {object} The same response object after lite-mode trimming
 */
function stripLiteResponse(response) {
  // 1. Collapse research into candidates: look up each row's risk info
  //    and attach it inline, then drop the separate research array.
  //    Composite key is game|player|market so the same selection across
  //    markets (Moneyline vs Total Games) joins to the right research row
  //    and its research context never bleeds across markets.
  const researchByGame = new Map();
  for (const r of response.research || []) {
    if (r.player && r.game) {
      researchByGame.set(`${r.game}:${r.player.toLowerCase()}:${(r.market || '').toLowerCase()}`, r);
    }
  }
  for (const entry of response.results || []) {
    for (const c of entry.candidates || []) {
      const player = (c.selection || '').toLowerCase();
      const game = c.game || '';
      const key = `${game}:${player}:${String(c.market || entry.market || '').toLowerCase()}`;
      const research = researchByGame.get(key);
      if (research) {
        c.riskFlag = research.riskFlag || c.riskFlag || null;
        c.riskSummary = research.riskSummary || c.riskSummary || null;
      }
      // Strip heavy validated bloat - actionableSummary already captures the signal.
      delete c.validatedGameContext;
      delete c.validatedEdge;
      delete c.validatedClv;
      delete c.validatedOdds;
      delete c.priceDrift;
      delete c.finalWarnings;
      delete c.screenUrl;
      delete c.rationale;
      // validatedConsensusSupport is a free-text string, keep it (small).
      // validatedUnverified, validatedConsensusDrift, validatedDriftReason:
      // keep them - they're compact flags the agent needs.
    }
  }
  // 2. Drop the separate research array (now inlined on candidates).
  response.research = undefined;
  // 3. Trim activeSlate to per-league summaries instead of per-market entries.
  if (Array.isArray(response.activeSlate)) {
    const leagueCounts = {};
    for (const s of response.activeSlate) {
      leagueCounts[s.league] = (leagueCounts[s.league] || 0) + (s.count || 0);
    }
    response.activeSlate = Object.entries(leagueCounts).map(([league, count]) => ({
      league,
      count
    }));
  }
  return response;
}

module.exports = { stripLiteResponse };
