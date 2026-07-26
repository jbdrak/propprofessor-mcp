'use strict';
const { resolveMarkets } = require('./handler-utils');
const {
  analyzeMultiWindow,
  summarizeResults,
  DEFAULT_WINDOWS,
  DEFAULT_SHARP_BOOKS
} = require('../../../lib/propprofessor-sharp-consensus');
const { parseGameStartMs } = require('../../../lib/propprofessor-shared-utils');

function createConsensusHandlers(client, ctx) {
  return {
    async sharp_consensus(args = {}) {
      const league = String(args.league || 'Tennis').trim();
      const marketResolution = resolveMarkets(args, league);
      const market = marketResolution.single;
      const windows =
        Array.isArray(args.windows) && args.windows.length
          ? args.windows
              .map(Number)
              .filter(Boolean)
              .sort((a, b) => a - b)
          : DEFAULT_WINDOWS;
      const sharpBooks =
        Array.isArray(args.sharpBooks) && args.sharpBooks.length
          ? args.sharpBooks.map((b) => String(b).trim()).filter(Boolean)
          : DEFAULT_SHARP_BOOKS;
      const minConsensusWindows = Number(args.minConsensusWindows) || 0;
      const lookbackHours = Number(args.lookbackHours) || 48;
      const limit = Number(args.limit) || 100;
      const rankedResponse = await ctx.handlers.screen_ranked({
        league,
        market,
        historySportsbooks: sharpBooks,
        includeAll: true,
        limit,
        lookbackHours,
        debug: false,
        is_live: false,
        skipHistory: args.skipHistory === true
      });
      if (!rankedResponse?.ok || !Array.isArray(rankedResponse.result)) {
        return { ok: false, error: 'Failed to fetch ranked screen data' };
      }
      const rows = rankedResponse.result;
      const analysis = analyzeMultiWindow(rows, { windows, sharpBooks, minConsensusWindows, nowMs: Date.now() });
      const analysisResults = analysis.results || [];
      const summary = summarizeResults(analysisResults);
      return {
        ok: true,
        count: analysisResults.length,
        summary,
        result: analysisResults,
        resultMeta: {
          league,
          market,
          windows,
          sharpBooks,
          lookbackHours,
          totalRowsScanned: rows.length,
          minConsensusWindows,
          rowsSkippedNoHistory: analysis.skippedNoHistory || 0,
          rowsSkippedInsufficientBooks: analysis.skippedInsufficientBooks || 0,
          markets_alias_used: marketResolution.aliasesUsed
        }
      };
    },

    async sharp_alerts(args = {}) {
      const { loadStore, saveStore, upsert, defaultPath } = require('../../../lib/propprofessor-sharp-alerts-store');
      const storePath = args.storePath || defaultPath();
      const dedupWindowMs =
        (Number.isFinite(Number(args.dedupWindowMinutes)) ? Number(args.dedupWindowMinutes) : 360) * 60000;
      const sinceMs = (Number.isFinite(Number(args.sinceMinutes)) ? Number(args.sinceMinutes) : 2880) * 60000;
      const floor = ['TIER 1', 'TIER 2', 'TIER 3'].indexOf(args.minFinalTier || 'TIER 1');

      // Delegate to quick_screen with validation + research on (reuses all filters).
      const screen = await ctx.handlers.quick_screen({
        ...args,
        validate: true,
        includeResearch: true,
        verbosity: 'full'
      });
      if (!screen || !screen.ok) {
        return { ok: false, error: 'screen failed', newAlerts: [], repeatAlerts: [], allBets: [] };
      }

      const researchByPlayer = new Map();
      for (const r of screen.research || []) {
        researchByPlayer.set(String(r.player || '').toLowerCase(), r);
      }

      const now = Date.now();
      const store = loadStore(storePath);
      const newAlerts = [];
      const repeatAlerts = [];
      const allBets = [];

      for (const entry of screen.results || []) {
        for (const c of entry.candidates || []) {
          const tierIdx = ['TIER 1', 'TIER 2', 'TIER 3', 'TIER 4'].indexOf(
            c.finalConfidenceTier || c.confidenceTier || 'TIER 4'
          );
          if (c.finalVerdict !== 'BET' || tierIdx > floor) continue;
          const startMs = parseGameStartMs(c.start);
          if (startMs && now - startMs > sinceMs) continue;
          const risk = researchByPlayer.get(String(c.selection || '').toLowerCase());
          if (risk && risk.riskFlag === 'high') continue;
          const odds = Number.isFinite(Number(c.validatedOdds)) ? c.validatedOdds : c.odds;
          const alert = {
            game: c.game,
            selection: c.selection,
            market: entry.market,
            odds,
            edge: c.edge,
            clv: c.clv,
            startCST: c.startCST,
            finalConfidenceTier: c.finalConfidenceTier,
            researchRiskFlag: risk ? risk.riskFlag : null,
            priceDrift: c.priceDrift != null ? c.priceDrift : null,
            finalWarnings: c.finalWarnings || []
          };
          allBets.push(alert);
          const key = `${c.gameId || c.game}:${c.selection}:${entry.market}`;
          const { isNew } = upsert(store, key, now, dedupWindowMs);
          (isNew ? newAlerts : repeatAlerts).push(alert);
        }
      }

      saveStore(storePath, store);
      return {
        ok: true,
        newAlerts,
        repeatAlerts,
        allBets,
        message: newAlerts.length ? null : 'No new sharp plays right now.'
      };
    }
  };
}

module.exports = { createConsensusHandlers };
