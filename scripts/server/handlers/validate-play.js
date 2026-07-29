'use strict';

/**
 * Validate play handler: runValidatePlayImpl.
 * Extracted from createMcpHandlers() in handlers.js.
 * Calls ctx.handlers.runGetPlayDetailsImpl for the detail re-fetch.
 */

const { normalizeBookList } = require('../../../lib/propprofessor-mcp-ranked-screen');
const { findBestMatch } = require('../../../lib/selection-matcher');
const { findMlbGamePk, getMlbGameContext } = require('../../../lib/propprofessor-mlb-game-context');
const { getGameContext } = require('../../../lib/propprofessor-game-context');
const { computeMovementDisposition } = require('../../../lib/propprofessor-movement-disposition');
const { buildCanonicalPlayId, normalizeSelectionKey } = require('../../../lib/propprofessor-mcp-ranked-screen');

function createValidatePlayHandlers(client, ctx) {
  // eslint-disable-next-line complexity
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

    const detailPromise = (async () => {
      try {
        return {
          ok: true,
          value: await ctx.handlers.runGetPlayDetailsImpl(client, {
            league,
            market,
            gameIds: [gameId],
            books: books.length ? books : undefined,
            lookbackHours
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
              value: await ctx.handlers.player_context({
                player: selection,
                sport: league
              })
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
        ? (async () => {
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
                  error: {
                    errorType: 'schedule_not_found',
                    errorDetail: 'no MLB gamePk found for matchup',
                    attemptedLookup
                  }
                };
              }
              return { ok: true, value: await getMlbGameContext({ gamePk }) };
            } catch (err) {
              return { ok: false, error: err?.message || String(err) };
            }
          })()
        : (async () => {
            try {
              let derivedStart = null;
              let tennisGameStr = gameId;
              if (league.toLowerCase() === 'tennis' && gameId) {
                const parts = gameId.split(':');
                const ts = parts[parts.length - 1];
                if (ts && /^\d{10}$/.test(ts)) {
                  derivedStart = new Date(Number(ts) * 1000).toISOString();
                }
                const p1 = (parts[2] || '').trim();
                const p2 = (parts[3] || '').trim();
                if (p1 && p2) {
                  tennisGameStr = `${p1} vs ${p2}`;
                }
              }
              const gctx = await getGameContext({
                sport: league,
                selection,
                game: tennisGameStr,
                start: derivedStart
              });
              return { ok: true, value: gctx };
            } catch (err) {
              return { ok: false, error: err?.message || String(err) };
            }
          })();

    const [detailOutcome, researchOutcome, gameContextOutcome] = await Promise.all([
      detailPromise,
      researchPromise,
      gameContextPromise
    ]);
    const detailResult = detailOutcome?.ok ? detailOutcome.value : null;
    const detailError = detailOutcome?.ok ? null : detailOutcome.error;
    const gameContext = gameContextOutcome?.ok ? gameContextOutcome.value : null;
    const gameContextError = gameContextOutcome?.ok ? null : gameContextOutcome?.error || null;

    const detailRows = Array.isArray(detailResult?.result) ? detailResult.result : [];
    const matchingRow = findBestMatch(detailRows, selection, requestedPlayId, books[0] || '');

    let research = researchOutcome?.ok ? researchOutcome.value : null;
    const researchError = researchOutcome?.ok ? null : researchOutcome?.error || null;
    if (research && !research.gameTime && matchingRow?.start) {
      research = { ...research, gameTime: matchingRow.start };
    }

    let verdict;
    const reasons = [];
    const screenTier = args.screenTier || (matchingRow && matchingRow.screenTier);
    const screenKaiCall = args.screenKaiCall || (matchingRow && matchingRow.screenKaiCall);
    let tier = screenTier || matchingRow?.confidenceTier || null;
    if (!tier) {
      const kaiCall = screenKaiCall || matchingRow?.kaiCall;
      if (kaiCall === 'BET') tier = 'TIER 1';
      else if (kaiCall === 'CONSIDER') tier = 'TIER 2';
      else tier = 'TIER 4';
    }
    let lookupStatus = 'resolved';
    let reasonType = 'signal';

    let consensusDrift = false;
    let driftReason = null;
    if (matchingRow) {
      const screenCbk = Number(args.screenConsensusBookCount);
      const screenExec = String(args.screenExecutionQuality || '');
      const currentCbk = Number(matchingRow.consensusBookCount || 0);
      const currentExec = String(matchingRow.executionQuality || '');

      if (Number.isFinite(screenCbk) && screenCbk > 0) {
        const absDrop = screenCbk - currentCbk;
        const pctDrop = screenCbk > 0 ? absDrop / screenCbk : 0;
        if (absDrop >= 4 && pctDrop > 0.25) {
          consensusDrift = true;
          driftReason = `consensus collapsed (${screenCbk} → ${currentCbk} books)`;
        }
      }
      if (
        !consensusDrift &&
        screenExec &&
        screenExec !== 'unknown' &&
        screenExec !== currentExec &&
        currentExec === 'bad'
      ) {
        consensusDrift = true;
        driftReason = 'execution quality changed';
      }
    }

    if (matchingRow) {
      if (tier === 'TIER 1') {
        verdict = 'BET';
      } else if (tier === 'TIER 2' || tier === 'TIER 3') {
        verdict = 'CONSIDER';
      } else {
        verdict = 'PASS';
        reasons.push('TIER 4 (no signal)');
      }

      if (consensusDrift && verdict === 'BET') {
        verdict = 'CONSIDER';
        reasons.push(`consensus drift: ${driftReason} (re-fetch disagrees with screen snapshot)`);
      }

      const exec = String(matchingRow.executionQuality || '');
      if (exec === 'bad') {
        verdict = 'PASS';
        reasons.push('execution quality is "bad" on the requested book');
      } else if (exec === 'playable') {
        reasons.push('execution quality is "playable" (within 10¢ of best)');
      } else if (exec === 'best') {
        reasons.push('execution quality is "best" (top of market)');
      } else {
        reasons.push(`execution quality is "${exec || 'unknown'}"`);
      }

      const cbk = Number(matchingRow.consensusBookCount || 0);
      if (cbk >= 3) reasons.push(`consensus: ${cbk} comp books agree`);
      else if (cbk >= 1) reasons.push(`consensus: ${cbk} comp book (thin)`);
      else reasons.push('no comp book consensus');
    } else {
      lookupStatus = 'lookup_failed';
      reasonType = 'lookup_failure';
      verdict = 'CONSIDER';
      reasons.push(
        detailError
          ? `screen lookup failed: ${detailError}`
          : `no row matched selection "${selection}" on gameId ${gameId}`
      );
    }

    if (screenKaiCall && screenKaiCall !== 'BET' && verdict === 'BET') {
      verdict = 'CONSIDER';
      reasons.push(`downgraded to match screen snapshot (${screenKaiCall})`);
    }

    if (research && research.riskFlag === 'high') {
      verdict = 'PASS';
      reasons.push('player_context riskFlag = "high"');
    } else if (research && research.riskFlag === 'medium') {
      if (verdict === 'BET') verdict = 'CONSIDER';
      reasons.push('player_context riskFlag = "medium" — proceed with caution');
    } else if (research && research.riskFlag === 'low') {
      reasons.push('player_context riskFlag = "low"');
    }

    if (gameContext && gameContext.riskFlag === 'high') {
      verdict = 'PASS';
      reasons.push(`game_context riskFlag = "high"${gameContext.riskSummary ? ` — ${gameContext.riskSummary}` : ''}`);
    } else if (gameContext && gameContext.riskFlag === 'medium') {
      if (verdict === 'BET') verdict = 'CONSIDER';
      reasons.push(`game_context riskFlag = "medium" — ${gameContext.riskSummary || 'proceed with caution'}`);
    } else if (gameContext && gameContext.riskFlag === 'low') {
      reasons.push(`game_context riskFlag = "low" — ${gameContext.riskSummary || 'minor flag'}`);
    } else if (gameContext && gameContext.riskFlag === 'unknown') {
      if (gameContext.riskSummary) {
        reasons.push(`game_context: ${gameContext.riskSummary}`);
      }
    }

    const _rowForDisposition = matchingRow ? { ...matchingRow } : null;
    if (_rowForDisposition && !_rowForDisposition.sharpBookMovementConfirmed && args.screenSharpBookConfirmed) {
      _rowForDisposition.sharpBookMovementConfirmed = true;
    }
    const _disposition = _rowForDisposition ? computeMovementDisposition(_rowForDisposition) : 'insufficient';

    if ((_disposition === 'adverse_recent' || _disposition === 'adverse_full') && tier !== 'TIER 4') {
      tier = 'TIER 3';
      reasons.push(`movement ${_disposition} — tier downgraded from screen snapshot`);
    }

    const _statusMessages = {
      supportive_clean: 'all signals aligned — green movement, supportive direction, clean path',
      supportive_bouncy: 'direction is right but path was rocky — yellow grade or V-shaped recovery',
      adverse_recent: 'recent movement turned adverse — the direction went against the play recently',
      adverse_full: 'full-window direction is adverse — do not bet',
      insufficient: 'not enough data to evaluate movement quality'
    };

    const _riskFlags = [];
    if (research && research.riskFlag && research.riskFlag !== 'low' && research.riskFlag !== 'clean') {
      _riskFlags.push(`player_context: ${research.riskFlag}`);
    }
    if (gameContext && gameContext.riskFlag && gameContext.riskFlag !== 'low' && gameContext.riskFlag !== 'clean') {
      _riskFlags.push(`game_context: ${gameContext.riskFlag}`);
    }
    if (_disposition === 'adverse_recent' || _disposition === 'adverse_full') {
      _riskFlags.push('movement adverse');
    }

    let _actionableSummary;
    if (_riskFlags.length === 0 && verdict === 'BET') {
      _actionableSummary = 'No red flags. Clean play across all checks.';
    } else if (verdict === 'BET' && _riskFlags.length > 0) {
      _actionableSummary = `BET with caution — flags: ${_riskFlags.join(', ')}`;
    } else if (lookupStatus === 'lookup_failed') {
      _actionableSummary =
        "Couldn't be rehydrated from the current screen snapshot. Treat as stale / unverified, not an automatic fade.";
    } else if (verdict === 'CONSIDER') {
      const cbk = Number(matchingRow?.consensusBookCount || 0);
      const edge = Number(matchingRow?.consensusEdge || args.screenConsensusEdge || 0);
      const clv = Number(matchingRow?.clvProxyPct || 0);
      const riskFlagsSuffix = _riskFlags.length > 0 ? ` — ${_riskFlags.join(', ')}` : '';

      if (cbk >= 10 && _disposition === 'supportive_clean') {
        _actionableSummary = `Deep consensus (${cbk} books, ${edge.toFixed(1)}% edge). Clean movement — playable with standard sizing.`;
      } else if (cbk >= 8 && _disposition === 'supportive_clean' && edge > 1.5) {
        _actionableSummary = `Strong signal across deep consensus (${cbk} books, ${edge.toFixed(1)}% edge). Playable with standard sizing.`;
      } else if (cbk >= 8 && _disposition === 'supportive_bouncy' && edge > 1.0) {
        _actionableSummary = `Deep consensus (${cbk} books, ${edge.toFixed(1)}% edge). Direction is right but path was rocky — standard sizing.`;
      } else if (cbk >= 8 && _disposition === 'supportive_clean') {
        _actionableSummary = `Deep consensus (${cbk} books). Clean movement, edge is thin (${edge.toFixed(1)}%) — reduce stake.`;
      } else if (cbk >= 8 && _disposition === 'supportive_bouncy') {
        _actionableSummary = `Deep consensus (${cbk} books). Bouncy movement, edge is thin (${edge.toFixed(1)}%) — reduce stake${riskFlagsSuffix}.`;
      } else if (cbk >= 5 && _disposition === 'supportive_clean' && edge > 0.5) {
        _actionableSummary = `Solid signal — ${cbk} books agree, clean movement. Standard sizing${riskFlagsSuffix}.`;
      } else if (cbk >= 5 && _disposition === 'supportive_bouncy' && edge > 0.5) {
        _actionableSummary = `Decent consensus (${cbk} books, ${edge.toFixed(1)}% edge). Bouncy but direction is right — reduce stake${riskFlagsSuffix}.`;
      } else if (cbk >= 3 && _disposition !== 'adverse_recent') {
        _actionableSummary = `Thin consensus (${cbk} books) but direction is right. Reduce stake or skip${riskFlagsSuffix}.`;
      } else if (cbk >= 1) {
        _actionableSummary = `Marginal — only ${cbk} book${cbk > 1 ? 's' : ''} in consensus. Skip unless you have a strong read${riskFlagsSuffix}.`;
      } else {
        _actionableSummary = `No comp book consensus. Pass${riskFlagsSuffix}.`;
      }
      if (clv > 4) {
        _actionableSummary += ` Strong CLV (${clv.toFixed(1)}%) confirms the move direction.`;
      } else if (clv < -4) {
        _actionableSummary += ` Weak CLV (${clv.toFixed(1)}%) — line moved against you. Reduce stake or pass.`;
      }
    } else {
      _actionableSummary = 'PASS — one or more hard checks failed.';
    }

    const verdictSummary = {
      displayTier: verdict === 'BET' ? 'BET' : verdict === 'CONSIDER' ? 'CONSIDER' : 'PASS',
      movementDisposition: _disposition,
      movementStatus: _statusMessages[_disposition] || 'unknown',
      executionQuality: matchingRow?.executionQuality || null,
      consensusSupport:
        matchingRow?.consensusBookCount > 0 ? `${matchingRow.consensusBookCount} books` : 'no consensus',
      riskFlags: _riskFlags,
      actionableSummary: _actionableSummary,
      rationale: (() => {
        const parts = [];
        const sharpSource = matchingRow?.sharpBookMovementSource || null;
        if (sharpSource) parts.push(`${sharpSource} confirms`);
        if (_disposition === 'supportive_clean') parts.push('clean movement');
        else if (_disposition === 'supportive_bouncy') parts.push('direction right, bouncy path');
        else if (_disposition === 'adverse_recent' || _disposition === 'adverse_full')
          parts.push('movement went against');
        else if (_disposition === 'insufficient') parts.push('no directional signal');
        const cbk = Number(matchingRow?.consensusBookCount || 0);
        if (cbk >= 3) parts.push(`${cbk} books`);
        const edgeVal = Number(matchingRow?.consensusEdge || args.screenConsensusEdge || 0);
        if (edgeVal > 0) parts.push(`+${edgeVal.toFixed(1)}% edge`);
        const clvVal = Number(matchingRow?.clvProxyPct ?? 0);
        if (clvVal > 0) parts.push(`+${clvVal.toFixed(1)}% CLV`);
        else if (clvVal < 0) parts.push(`${clvVal.toFixed(1)}% CLV`);
        else parts.push('0% CLV');
        if (consensusDrift && driftReason) parts.push(`drift: ${driftReason}`);
        return parts.length ? parts.join(' · ') : null;
      })()
    };

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
      play: matchingRow
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
              `&game=${encodeURIComponent(gameId)}` +
              `&league=${encodeURIComponent(league)}` +
              `&participant=${encodeURIComponent(selection)}`
          }
        : null,
      research: research
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
          : { error: researchError || 'research failed' },
      gameContext: gameContext
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
          : null
    };
  }

  return {
    runValidatePlayImpl
  };
}

module.exports = { createValidatePlayHandlers };
