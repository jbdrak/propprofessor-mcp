'use strict';

/**
 * Discovery handlers: ev_candidates, smart_money.
 * Note: all_slates stays inline — it calls handlers.screen_ranked.
 */

const { defined } = require('./handler-utils');
const { validatePositiveEvCandidates } = require('../../../lib/validate-ev-candidates');
const { DEFAULT_LEAGUES } = require('../../../lib/propprofessor-shared-utils');

function createDiscoveryHandlers(client, _ctx) {
  return {
    async ev_candidates(args = {}) {
      const leagues = Array.isArray(args.leagues) && args.leagues.length ? args.leagues : undefined;
      if (!leagues) {
        const error = new Error(
          'The leagues parameter is required on ev_candidates. ' +
            'Pass one or more league names, e.g. leagues: ["NBA", "MLB", "Tennis"]. ' +
            'An empty array or omitted leagues will cause the backend to return HTTP 400.'
        );
        error.code = 'MISSING_LEAGUES';
        error.category = 'validation';
        error.status = 400;
        throw error;
      }
      const payload = await client.querySportsbook(
        defined({
          isLive: false,
          showBreakOnly: args.showBreakOnly,
          showTimeoutOnly: args.showTimeoutOnly,
          showPeriodEndOnly: args.showPeriodEndOnly,
          timeAvailable: args.timeAvailable,
          userState: args.userState,
          hideNCAAPlayerProps: args.hideNCAAPlayerProps,
          sportsbooks: Array.isArray(args.sportsbooks) ? args.sportsbooks : undefined,
          leagues,
          minOdds: args.minOdds,
          maxOdds: args.maxOdds,
          minValue: args.minValue,
          maxValue: args.maxValue,
          marketTypes: Array.isArray(args.marketTypes) ? args.marketTypes : undefined,
          periodTypes: Array.isArray(args.periodTypes) ? args.periodTypes : undefined,
          minHoursAway: args.minHoursAway,
          maxHoursAway: args.maxHoursAway,
          minLiquidity: args.minLiquidity,
          maxLiquidity: args.maxLiquidity,
          weightSettings:
            args.weightSettings && typeof args.weightSettings === 'object' ? args.weightSettings : undefined
        })
      );
      const rows = Array.isArray(payload) ? payload : [];
      const baseResult = {
        ok: true,
        count: rows.length,
        result: rows,
        notes: {
          workflow:
            'Use these rows as fast discovery candidates, then validate finalists with /screen, exact-line checks, and sharp-book movement.',
          minValueBehavior: args.minValue === undefined ? 'unset_here_use_frontend_filter' : 'explicit_request_override'
        }
      };
      if (args.validated) {
        return validatePositiveEvCandidates({ client, candidates: rows, args });
      }
      return baseResult;
    },

    async smart_money(args = {}) {
      const leagues =
        Array.isArray(args.leagues) && args.leagues.length
          ? args.leagues
          : args.league
            ? [args.league]
            : Array.from(DEFAULT_LEAGUES);
      const filters = { leagues, userState: String(args.userState || 'tx').toLowerCase() };
      if (Array.isArray(args.sportsbooks) && args.sportsbooks.length) filters.sportsbooks = args.sportsbooks;
      if (Array.isArray(args.marketTypes) && args.marketTypes.length) filters.marketTypes = args.marketTypes;
      if (Array.isArray(args.periodTypes) && args.periodTypes.length) filters.periodTypes = args.periodTypes;
      if (Number.isFinite(Number(args.minLiquidity))) filters.minLiquidity = Number(args.minLiquidity);
      if (Number.isFinite(Number(args.minHoursAway))) filters.minHoursAway = Number(args.minHoursAway);
      if (Number.isFinite(Number(args.maxHoursAway))) filters.maxHoursAway = Number(args.maxHoursAway);
      if (args.hideNCAAPlayerProps !== undefined) filters.hideNCAAPlayerProps = Boolean(args.hideNCAAPlayerProps);
      let raw;
      try {
        raw = await client.querySmartMoney(filters);
      } catch (err) {
        return { ok: false, error: { code: 'SMART_MONEY_FAILED', message: err?.message || String(err) } };
      }
      const rows = Array.isArray(raw) ? raw : [];
      const result = rows.map((r) => ({
        gameId: r.gameId || null,
        league: r.league || null,
        market: r.market || null,
        selection: r.selection || null,
        subSelection: r.subSelection || null,
        site: r.site || null,
        url: r.url || null,
        volumeUsd: typeof r.totalLiquidArb === 'number' ? r.totalLiquidArb : null,
        oddsRange:
          Number.isFinite(Number(r.minArbOdds)) && Number.isFinite(Number(r.maxArbOdds))
            ? { min: r.minArbOdds, max: r.maxArbOdds }
            : null,
        isLive: Boolean(r.isLive),
        start: r.start || null,
        sportsbookCount: Array.isArray(r.sportsbookData) ? r.sportsbookData.length : 0
      }));
      result.sort((a, b) => (b.volumeUsd || 0) - (a.volumeUsd || 0));
      return {
        ok: true,
        count: result.length,
        result,
        resultMeta: { leagues, volumeTotalUsd: result.reduce((s, r) => s + (r.volumeUsd || 0), 0) }
      };
    }
  };
}

module.exports = { createDiscoveryHandlers };
