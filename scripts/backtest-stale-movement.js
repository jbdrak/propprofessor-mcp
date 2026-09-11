#!/usr/bin/env node
'use strict';

/**
 * StaleMovementWarning contrarian signal backtest.
 *
 * Generates 'contrarian_value' scenarios: strong consensus (10+ books)
 * but adverse recent movement — exactly the staleMovementWarning condition.
 *
 * Compares hit rates: stale-flagged TIER 1/2 vs clean TIER 1/2.
 *
 * Usage:
 *   node scripts/backtest-stale-movement.js [--scenarios=1000] [--seed=42]
 */

const { generateScenario, setRandomSeed, resetRandomSeed } = require('./backtest-synthetic');
const { extractScreenRows } = require('../lib/screen-parser');
const { rankLeagueScreenRows } = require('../lib/screen-ranker');
const { clearTierCache, clearScoreTimeline } = require('../lib/ssb-risk-score');

// ── Targeted scenario: contrarian value ──

const TEAMS = [
  ['Lakers', 'Celtics'],
  ['Warriors', 'Nuggets'],
  ['Bucks', 'Heat'],
  ['76ers', 'Knicks'],
  ['Suns', 'Clippers'],
  ['Mavericks', 'Grizzlies']
];

const BOOKS = [
  'Pinnacle',
  'Circa',
  'BetOnline',
  'BookMaker',
  'NoVigApp',
  'Fliff',
  'DraftKings',
  'FanDuel',
  'BetMGM',
  'Caesars',
  'PointsBet',
  'BetRivers'
];

let _rng = Math.random;
function rand() {
  return _rng();
}
function randInt(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function generateContrarianScenario() {
  const [home, away] = TEAMS[Math.floor(rand() * TEAMS.length)];
  const gameId = `contrarian-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const homeWins = rand() < 0.52; // 52% win rate for the pick

  const nowSec = Math.floor(Date.now() / 1000);
  const odds = {};
  const history = {};
  const sharpBooks = ['Pinnacle', 'Circa', 'BetOnline', 'BookMaker', 'BetMGM', 'Caesars'];

  // Home is a slight favorite at -115
  const homeOdds = -115;

  for (const book of BOOKS) {
    const bookHome = homeOdds + randInt(-5, 5);
    const bookAway = Math.round(bookHome > 0 ? -(bookHome + 100) : -bookHome + 100);
    odds[book] = {
      odds1: Math.max(-500, Math.min(500, bookHome)),
      odds2: Math.max(-500, Math.min(500, bookAway))
    };

    // History: initially stable/supportive, then recent adverse move on sharp books
    const historyPoints = [];
    for (let h = 6; h >= 0; h -= 1) {
      const ts = nowSec - h * 3600;
      const isRecentSharp = sharpBooks.includes(book) && h <= 2;
      const adverse = homeOdds - randInt(5, 15) - (3 - h) * 3;
      historyPoints.push({
        odds: isRecentSharp ? adverse + randInt(-2, 2) : homeOdds + randInt(-3, 3),
        start_ts: ts
      });
    }
    history[book] = historyPoints;
  }

  return {
    screenPayload: {
      game_data: [
        {
          gameId,
          league: 'NBA',
          market: 'Moneyline',
          updatedAt: new Date().toISOString(),
          homeTeam: home,
          awayTeam: away,
          selections: {
            ml: {
              selection1: home,
              participant1: home,
              selection1Id: `Moneyline:${home.replace(/\s+/g, '_')}`,
              selection2: away,
              participant2: away,
              selection2Id: `Moneyline:${away.replace(/\s+/g, '_')}`,
              odds
            }
          },
          defaultKey: 'ml'
        }
      ]
    },
    oddsHistory: { [gameId]: history },
    outcome: homeWins ? home : away,
    gameId,
    scenarioType: 'contrarian_value'
  };
}

function runStaleBacktest({ scenarios = 1000, seed = 42 } = {}) {
  setRandomSeed(seed);

  const results = {
    staleFlagged: { wins: 0, losses: 0 },
    notFlagged: { wins: 0, losses: 0 }
  };
  let errorCount = 0;

  // 40% contrarian, 60% standard scenarios
  const contrarianCount = Math.floor(scenarios * 0.4);

  for (let i = 0; i < scenarios; i++) {
    clearTierCache();
    clearScoreTimeline();

    const contrarian = i < contrarianCount;
    const { screenPayload, oddsHistory, outcome, gameId } = contrarian
      ? generateContrarianScenario()
      : generateScenario();

    try {
      const rows = extractScreenRows(screenPayload);

      for (const row of rows) {
        const gameHistory = oddsHistory[gameId] || {};
        const bookHistory = [];
        for (const [book, points] of Object.entries(gameHistory)) {
          for (const p of points) {
            bookHistory.push({ ...p, book });
          }
        }
        row.lineHistory = bookHistory.sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0));
        const earliest =
          bookHistory.length > 0
            ? bookHistory.reduce((min, p) => ((p.start_ts || Infinity) < (min.start_ts || Infinity) ? p : min))
            : null;
        row.openingOdds = earliest ? earliest.odds : row.odds;
      }

      const ranked = rankLeagueScreenRows(rows, {
        league: 'NBA',
        market: 'Moneyline',
        limit: 20,
        includeAll: true,
        books: ['NoVigApp']
      });

      for (const row of ranked) {
        const consensusCount = Number(row.consensusBookCount) || 0;
        const isAdverse = String(row.movementLabel || '') === 'adverse';
        // Test: "strong consensus but adverse movement" as contrarian signal
        // (movementDisposition is computed later in enrichment, not in synthetic ranker)
        const isStale = isAdverse && consensusCount >= 10;

        const selection = row.selection || row.participant || '';
        const won = selection === outcome;
        const bucket = isStale ? 'staleFlagged' : 'notFlagged';
        results[bucket][won ? 'wins' : 'losses']++;
      }
    } catch {
      errorCount++;
    }
  }

  resetRandomSeed();
  return { results, scenarios, errorCount, seed, contrarianCount };
}

function reportStaleBacktest({ results, scenarios, errorCount, seed, contrarianCount }) {
  const stale = results.staleFlagged;
  const notStale = results.notFlagged;
  const staleTotal = stale.wins + stale.losses;
  const notTotal = notStale.wins + notStale.losses;
  const staleRate = staleTotal > 0 ? ((stale.wins / staleTotal) * 100).toFixed(1) : 'N/A';
  const notRate = notTotal > 0 ? ((notStale.wins / notTotal) * 100).toFixed(1) : 'N/A';

  console.log('='.repeat(60));
  console.log('StaleMovementWarning Contrarian Signal Backtest');
  console.log('='.repeat(60));
  console.log(`Scenarios: ${scenarios} (${contrarianCount} contrarian) | Seed: ${seed} | Errors: ${errorCount}`);
  console.log('');
  console.log(`Stale-flagged (adverse+≥10bk): ${staleRate}% (${stale.wins}W/${stale.losses}L/${staleTotal} total)`);
  console.log(`Not flagged:                 ${notRate}% (${notStale.wins}W/${notStale.losses}L/${notTotal} total)`);
  console.log('');

  if (staleTotal > 10 && notTotal > 10) {
    const staleFloat = stale.wins / staleTotal;
    const notFloat = notStale.wins / notTotal;
    const diff = ((staleFloat - notFloat) * 100).toFixed(1);

    if (staleFloat > notFloat + 0.02) {
      console.log(`✅ CONTRARIAN SIGNAL CONFIRMED: stale-flagged beats clean by ${diff}pp`);
      console.log('   Reframe staleMovementWarning as contrarianSignal=true.');
    } else if (staleFloat < notFloat - 0.02) {
      console.log(`❌ Stale warning correct: flagged underperforms by ${Math.abs(Number(diff))}pp`);
    } else {
      console.log(`⚪ Neutral (${diff}pp) — stale flag adds noise. Consider removing.`);
    }
  } else {
    console.log('⚠️  Insufficient sample. Re-run with more scenarios.');
  }
  console.log('');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const sArg = args.find((a) => a.startsWith('--scenarios='));
  const seedArg = args.find((a) => a.startsWith('--seed='));
  const s = sArg ? parseInt(sArg.split('=')[1], 10) : 1000;
  const seed = seedArg ? parseInt(seedArg.split('=')[1], 10) : undefined;
  reportStaleBacktest(runStaleBacktest({ scenarios: s, seed }));
}

module.exports = { runStaleBacktest, reportStaleBacktest, generateContrarianScenario };
