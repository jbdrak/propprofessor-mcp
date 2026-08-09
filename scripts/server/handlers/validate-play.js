'use strict';

/**
 * Validate play handler: runValidatePlayImpl.
 * Extracted from createMcpHandlers() in handlers.js.
 * Calls ctx.handlers.runGetPlayDetailsImpl for the detail re-fetch.
 */

const { normalizeBookList } = require('../../../lib/propprofessor-mcp-ranked-screen');
const { findBestMatch, findBestMatchGameIdChanged, parseGameIdIdentity } = require('../../../lib/selection-matcher');
const { findMlbGamePk, getMlbGameContext } = require('../../../lib/propprofessor-mlb-game-context');
const { getGameContext } = require('../../../lib/propprofessor-game-context');
const { buildCanonicalPlayId, normalizeSelectionKey } = require('../../../lib/propprofessor-mcp-ranked-screen');
const { buildValidationVerdict } = require('./validate-play-verdict');

async function resolveValidationLookups(client, ctx, options) {
  const { league, gameId, selection, market, books, lookbackHours, args, skipResearch, skipGameContext } = options;
  const detailPromise = (async () => {
    try {
      return {
        ok: true,
        value: await ctx.handlers.runGetPlayDetailsImpl(client, {
          league,
          market,
          gameIds: [gameId],
          books: books.length ? books : undefined,
          lookbackHours,
          ...(args.exactSelectionOnly === true && selection
            ? { selection, exactSelectionOnly: true, enableHistoryLineFallback: false }
            : {})
        })
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  })();
  const researchPromise = skipResearch
    ? Promise.resolve(null)
    : (async () => {
        try {
          return {
            ok: true,
            value: await ctx.handlers.player_context({ player: selection, sport: league })
          };
        } catch (err) {
          return { ok: false, error: err?.message || String(err) };
        }
      })();

  const isMlb = league.toUpperCase() === 'MLB';
  const gameIdParts = isMlb && gameId ? gameId.split(':') : [];
  const seedHomeTeam = gameIdParts[2] ? gameIdParts[2].replace(/_/g, ' ') : '';
  const seedAwayTeam = gameIdParts[3] ? gameIdParts[3].replace(/_/g, ' ') : '';
  const seedStartDate =
    gameIdParts[4] && /^\d{10}$/.test(gameIdParts[4])
      ? new Date(Number(gameIdParts[4]) * 1000).toISOString().slice(0, 10)
      : '';
  const gameContextPromise = skipGameContext
    ? Promise.resolve(null)
    : isMlb
      ? resolveMlbContext({ seedAwayTeam, seedHomeTeam, seedStartDate, gameIdParts })
      : resolveGeneralGameContext({ league, gameId, selection });

  return Promise.all([detailPromise, researchPromise, gameContextPromise]);
}

async function resolveMlbContext({ seedAwayTeam, seedHomeTeam, seedStartDate, gameIdParts }) {
  try {
    if (!seedAwayTeam || !seedHomeTeam || !seedStartDate) {
      return { ok: false, error: 'missing MLB matchup data for game context' };
    }
    const attemptedLookup = {
      isoDate: seedStartDate,
      awayTeam: seedAwayTeam,
      homeTeam: seedHomeTeam,
      unixStart: gameIdParts[4] && /^\d{10}$/.test(gameIdParts[4]) ? Number(gameIdParts[4]) : undefined
    };
    const gamePk = await findMlbGamePk(attemptedLookup);
    if (!gamePk) {
      return {
        ok: false,
        error: { errorType: 'schedule_not_found', errorDetail: 'no MLB gamePk found for matchup', attemptedLookup }
      };
    }
    return { ok: true, value: await getMlbGameContext({ gamePk }) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function resolveGeneralGameContext({ league, gameId, selection }) {
  try {
    let derivedStart = null;
    let tennisGameStr = gameId;
    if (league.toLowerCase() === 'tennis' && gameId) {
      const parts = gameId.split(':');
      const ts = parts[parts.length - 1];
      if (ts && /^\d{10}$/.test(ts)) derivedStart = new Date(Number(ts) * 1000).toISOString();
      const p1 = (parts[2] || '').trim();
      const p2 = (parts[3] || '').trim();
      if (p1 && p2) tennisGameStr = `${p1} vs ${p2}`;
    }
    const value = await getGameContext({ sport: league, selection, game: tennisGameStr, start: derivedStart });
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function resolveValidationRow(client, ctx, options) {
  const { detailRows, detailError, league, market, selection, gameId, requestedPlayId, books, lookbackHours } = options;
  let matchingRow = findBestMatch(detailRows, selection, requestedPlayId, books[0] || '');
  let matchedViaGameIdChange = false;
  let fallbackNote = null;
  if (!matchingRow && !detailError) {
    const gameIdIdentity = parseGameIdIdentity(gameId);
    if (gameIdIdentity) {
      try {
        const relaxed = await ctx.handlers.runGetPlayDetailsImpl(client, {
          league,
          market,
          gameIds: [gameId],
          participants: gameIdIdentity.participants,
          books: books.length ? books : undefined,
          lookbackHours,
          relaxedGameIdMatch: true
        });
        const relaxedRows = Array.isArray(relaxed?.result) ? relaxed.result : [];
        const fallbackRow = findBestMatchGameIdChanged(relaxedRows, {
          league,
          market,
          selection,
          gameId,
          playId: requestedPlayId,
          requestedBook: books[0] || ''
        });
        if (fallbackRow) {
          matchingRow = fallbackRow;
          matchedViaGameIdChange = true;
        } else {
          fallbackNote = relaxedRows.length
            ? 'no unambiguous matchup match on the scheduled date'
            : 'matchup not found on the current screen';
        }
      } catch {
        fallbackNote = 'relaxed lookup failed';
      }
    }
  }
  return { matchingRow, matchedViaGameIdChange, fallbackNote };
}

function buildValidationPlay({ matchingRow, market, gameId, league, selection }) {
  return matchingRow
    ? {
        playId: matchingRow.playId || buildCanonicalPlayId(matchingRow),
        selectionKey:
          matchingRow.selectionKey || normalizeSelectionKey(matchingRow.selection || matchingRow.participant || ''),
        gameId: matchingRow.gameId,
        homeTeam: matchingRow.homeTeam,
        awayTeam: matchingRow.awayTeam,
        start: matchingRow.start,
        odds: matchingRow.odds,
        bestAvailableOdds: matchingRow.bestAvailableOdds,
        executionQuality: matchingRow.executionQuality,
        consensusEdge: matchingRow.consensusEdge,
        consensusBookCount: matchingRow.consensusBookCount,
        clvProxyPct: matchingRow.clvProxyPct,
        openToCurrentClvPct: matchingRow.openToCurrentClvPct,
        freshnessSource: matchingRow.freshnessSource || null,
        movementLabel: matchingRow.movementLabel,
        kaiCall: matchingRow.kaiCall,
        screenScore: matchingRow.screenScore,
        screenUrl:
          `https://app.propprofessor.com/screen?market=${encodeURIComponent(market)}` +
          `&game=${encodeURIComponent(matchingRow.gameId || gameId)}` +
          `&league=${encodeURIComponent(league)}` +
          `&participant=${encodeURIComponent(selection)}`
      }
    : null;
}

function buildValidationResearch({ research, skipResearch, researchError }) {
  return research
    ? {
        riskFlag: research.riskFlag,
        riskSummary: research.summary || null,
        topTweet:
          Array.isArray(research.tweets) && research.tweets.length > 0
            ? research.tweets[0]?.text?.slice(0, 200) || null
            : null,
        cached: Boolean(research.cached),
        fetchedAt: research.fetchedAt
      }
    : skipResearch
      ? { skipped: true }
      : { error: researchError || 'research failed' };
}

function buildValidationGameContext({ gameContext, isMlb, skipGameContext, gameContextError }) {
  return gameContext
    ? {
        gamePk: gameContext.gamePk,
        sport: gameContext.sport || null,
        riskFlag: gameContext.riskFlag,
        riskSummary: gameContext.riskSummary || null,
        signals: gameContext.signals || null,
        cached: Boolean(gameContext.cached),
        fetchedAt: gameContext.fetchedAt,
        ...(isMlb
          ? {
              venue: gameContext.venue || null,
              pitchers: gameContext.pitchers || null,
              park: gameContext.park || null,
              weather: gameContext.weather || null,
              lineups: gameContext.lineups || null
            }
          : {}),
        ...(gameContext.awayTeam
          ? {
              awayTeam: gameContext.awayTeam,
              homeTeam: gameContext.homeTeam
            }
          : {}),
        ...(gameContext.surface
          ? {
              surface: gameContext.surface,
              level: gameContext.level,
              matchupNewsCount: gameContext.matchupNewsCount
            }
          : {})
      }
    : isMlb
      ? skipGameContext
        ? { skipped: true }
        : gameContextError
          ? typeof gameContextError === 'string'
            ? { error: gameContextError }
            : gameContextError
          : null
      : null;
}

function buildValidationResponse(context) {
  const {
    league,
    market,
    gameId,
    selection,
    args,
    books,
    verdict,
    tier,
    lookupStatus,
    reasonType,
    reasons,
    verdictSummary,
    detailResult,
    consensusDrift,
    driftReason,
    matchingRow,
    research,
    skipResearch,
    researchError,
    gameContext,
    isMlb,
    skipGameContext,
    gameContextError
  } = context;
  return {
    ok: true,
    league,
    market,
    gameId,
    selection,
    executionBook: String(args.book || books[0] || ''),
    verdict,
    tier,
    lookupStatus,
    reasonType,
    reasons,
    verdictSummary,
    screenFreshness: detailResult?.freshness || null,
    consensusDrift,
    driftReason,
    play: buildValidationPlay({ matchingRow, market, gameId, league, selection }),
    research: buildValidationResearch({ research, skipResearch, researchError }),
    gameContext: buildValidationGameContext({ gameContext, isMlb, skipGameContext, gameContextError })
  };
}

function createValidatePlayHandlers(client, ctx) {
  async function runValidatePlayImpl(client, args = {}) {
    const league = String(args.league || '').trim();
    const gameId = String(args.gameId || '').trim();
    const selection = String(args.selection || '').trim();
    const requestedPlayId = String(args.playId || '').trim();
    if (!league) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'league is required' } };
    }
    if (!gameId) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'gameId is required' } };
    }
    if (!selection && !requestedPlayId) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'selection or playId is required' } };
    }
    const market = String(args.market || 'Moneyline').trim() || 'Moneyline';
    const books = normalizeBookList(args.books);
    const lookbackHours = Number.isFinite(Number(args.lookbackHours)) ? Number(args.lookbackHours) : 6;
    const skipResearch = args.skipResearch === true;
    const skipGameContext = args.skipGameContext === true;
    const isMlb = league.toUpperCase() === 'MLB';

    const [detailOutcome, researchOutcome, gameContextOutcome] = await resolveValidationLookups(client, ctx, {
      league,
      gameId,
      selection,
      market,
      books,
      lookbackHours,
      args,
      skipResearch,
      skipGameContext
    });
    const detailResult = detailOutcome?.ok ? detailOutcome.value : null;
    const detailError = detailOutcome?.ok ? null : detailOutcome.error;
    const gameContext = gameContextOutcome?.ok ? gameContextOutcome.value : null;
    const gameContextError = gameContextOutcome?.ok ? null : gameContextOutcome?.error || null;

    const detailRows = Array.isArray(detailResult?.result) ? detailResult.result : [];
    const rowResolution = await resolveValidationRow(client, ctx, {
      detailRows,
      detailError,
      league,
      market,
      selection,
      gameId,
      requestedPlayId,
      books,
      lookbackHours
    });
    const { matchingRow, matchedViaGameIdChange, fallbackNote } = rowResolution;

    let research = researchOutcome?.ok ? researchOutcome.value : null;
    const researchError = researchOutcome?.ok ? null : researchOutcome?.error || null;
    if (research && !research.gameTime && matchingRow?.start) {
      research = { ...research, gameTime: matchingRow.start };
    }

    const verdictResult = buildValidationVerdict({
      args,
      matchingRow,
      matchedViaGameIdChange,
      detailError,
      fallbackNote,
      gameId,
      selection,
      research,
      gameContext
    });
    const { verdict, tier, lookupStatus, reasonType, reasons, verdictSummary, consensusDrift, driftReason } =
      verdictResult;

    return buildValidationResponse({
      league,
      market,
      gameId,
      selection,
      args,
      books,
      verdict,
      tier,
      lookupStatus,
      reasonType,
      reasons,
      verdictSummary,
      detailResult,
      consensusDrift,
      driftReason,
      matchingRow,
      research,
      skipResearch,
      researchError,
      gameContext,
      isMlb,
      skipGameContext,
      gameContextError
    });
  }

  return {
    runValidatePlayImpl
  };
}

module.exports = { createValidatePlayHandlers };
