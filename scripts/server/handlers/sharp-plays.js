'use strict';

/**
 * sharp_plays handler — extracted from createMcpHandlers() in handlers.js.
 *
 * Follows the create*Handlers(client, ctx) factory seam. Captures no extra
 * closure state: it calls runSharpPlays with closures that delegate to
 * ctx.handlers (already wired by createMcpHandlers), and uses the same module
 * imports as the original inline block (sortRows/filter* formatters,
 * runResearchOnTopRows, clearTierCache). Behavior unchanged.
 */

const { runSharpPlays } = require('../../../lib/propprofessor-sharp-plays-service');
const { runResearchOnTopRows } = require('../../../lib/propprofessor-research-runner');
const {
  formatSharpPlaysMinimal,
  formatSharpPlaysStandard
} = require('../../../lib/propprofessor-formatter');
const { filterRowsByKaiCall, filterRowsByMinEV, filterRowsByMovement } = require('../../../lib/propprofessor-row-filter');
const { sortRows } = require('../../../lib/propprofessor-sort-utils');

function createSharpPlaysHandlers(client, ctx) {
  return {
    async sharp_plays(args = {}) {
      const response = await runSharpPlays(args, {
        queryLeagueScreen: (rankedArgs) => ctx.handlers.runLeagueScreen(rankedArgs, rankedArgs.league),
        queryTennisScreen: (rankedArgs) => ctx.handlers.runTennisScreen(rankedArgs)
      });
      // Research: when includeResearch=true (default), run player_context
      // on the top N ranked rows to attach injury/risk flags.
      const includeResearch = args.includeResearch !== undefined ? Boolean(args.includeResearch) : true;
      if (includeResearch && Array.isArray(response.result) && response.result.length) {
        const researchLimit = Number.isFinite(Number(args.researchLimit))
          ? Math.max(1, Math.min(50, Number(args.researchLimit)))
          : 10;
        const research = await runResearchOnTopRows({
          rows: response.result,
          limit: researchLimit,
          playerContextFn: ctx.handlers.player_context
        });
        response.research = research.results;
        response.resultMeta = {
          ...response.resultMeta,
          researchRunCount: research.results.length,
          researchRiskHighCount: research.results.filter((r) => r.riskFlag === 'high').length,
          researchCachedCount: research.results.filter((r) => r.cached).length
        };
        if (args.riskDowngrade === true) {
          const beforeCount = response.result.length;
          const highRiskPlayers = new Set(
            research.results.filter((r) => r.riskFlag === 'high').map((r) => String(r.player || '').toLowerCase())
          );
          response.result = response.result.filter((row) => {
            const player = String(row.selection || row.participant || '').toLowerCase();
            return !highRiskPlayers.has(player);
          });
          response.resultMeta = {
            ...response.resultMeta,
            riskDowngradedCount: beforeCount - response.result.length
          };
        }
      }

      // === kaiCall filter + sortBy (agent ergonomics) ===
      // Apply after research/riskDowngrade so the filter operates on the
      // final result set. Both are no-ops when the params are missing.
      if (Array.isArray(response.result)) {
        response.result = sortRows(
          filterRowsByMinEV(
            filterRowsByMovement(filterRowsByKaiCall(response.result, args.kaiCall), args.movement),
            args.minEV
          ),
          {
            sortBy: args.sortBy,
            sortDir: args.sortDir
          }
        );
      }

      // Apply verbosity formatting
      const verbosity = String(args.verbosity || 'full').toLowerCase();
      if (verbosity === 'minimal') return formatSharpPlaysMinimal(response);
      if (verbosity === 'standard') return formatSharpPlaysStandard(response);
      return response;
    }
  };
}

module.exports = { createSharpPlaysHandlers };
