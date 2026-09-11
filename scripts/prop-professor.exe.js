#!/usr/bin/env node
/**
 * SSB.exe - Tier Ranked Plays Display
 *
 * A quick CLI tool to display tier-ranked prop bets from SSB.
 * Shows plays grouped by confidence tier (1 = highest, 4 = lowest).
 *
 * Usage:
 *   node scripts/prop-professor.exe.js
 *   pp-exe
 *
 * Examples:
 *   pp-exe --leagues NBA,MLB --limit 5
 *   pp-exe --tier 1
 */

const { spawn } = require('child_process');

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  clear: '\x1b[2J\x1b[H'
};

const DEFAULT_PP_QUERY = require('path').join(__dirname, 'query-ssb.js');

function runQuery(args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [DEFAULT_PP_QUERY, 'sharp-plays', ...args], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => (stdout += data));
    proc.stderr.on('data', (data) => (stderr += data));

    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `Exit code ${code}`));
      else resolve(stdout);
    });
  });
}

function formatBet(play) {
  const tierNum = play.confidenceTier?.split?.(' ')?.[1] || '?';
  const tierColor =
    tierNum === '1' ? colors.green : tierNum === '2' ? colors.yellow : tierNum === '3' ? colors.cyan : colors.red;
  const kaiColor = play.kaiCall === 'BET' ? colors.green : colors.yellow;

  const edge =
    play.consensusEdge !== null && play.consensusEdge !== undefined
      ? `${Math.abs(play.consensusEdge).toFixed(2)}%`
      : 'N/A';

  return {
    tier: tierNum,
    league: play.league || 'Unknown',
    game: play.game || `${play.homeTeam} vs ${play.awayTeam}`,
    selection: play.selection || play.pick,
    odds: play.odds?.toString() || play.currentOdds?.toString() || 'N/A',
    edge: edge,
    kai: play.kaiCall || 'CONSIDER',
    color: tierColor,
    kaiColor
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--leagues=')) opts.leagues = arg.split('=')[1];
    else if (arg.startsWith('--limit=')) opts.limit = parseInt(arg.split('=')[1]);
    else if (arg.startsWith('--tier=')) opts.tier = arg.split('=')[1];
    else if (arg === '--leagues' && args[i + 1]) opts.leagues = args[++i];
    else if (arg === '--limit' && args[i + 1]) opts.limit = parseInt(args[++i]);
    else if (arg === '--tier' && args[i + 1]) opts.tier = args[++i];
  }

  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);

  console.log(`${colors.clear}${colors.bold}🎯 PROPFPROFESSOR.EXE - TIER RANKED PLAYS${colors.reset}`);
  console.log(`${colors.dim}Fetching live data...${colors.reset}\n`);

  try {
    const args = [
      '--leagues',
      opts.leagues || 'MLB,NBA,NHL,Tennis,WNBA,UFC',
      '--limit',
      (opts.limit || 10).toString(),
      '--json'
    ];
    const result = await runQuery(args);
    const data = JSON.parse(result);

    let bets = (data?.result || []).map(formatBet);

    // Filter by tier if specified
    if (opts.tier) {
      bets = bets.filter((b) => b.tier === opts.tier);
    }

    // Group by tier
    const byTier = {};
    bets.forEach((bet) => {
      if (!byTier[bet.tier]) byTier[bet.tier] = [];
      byTier[bet.tier].push(bet);
    });

    // Display
    ['1', '2', '3', '4'].forEach((tier) => {
      const plays = byTier[tier] || [];
      const tierColor =
        tier === '1' ? colors.green : tier === '2' ? colors.yellow : tier === '3' ? colors.cyan : colors.red;

      console.log(`${tierColor}TIER ${tier}${colors.reset}`);
      if (plays.length === 0) {
        console.log(`${colors.dim}  (none)${colors.reset}`);
      } else {
        plays.slice(0, 5).forEach((play) => {
          console.log(
            `  ${colors.dim}${play.league}${colors.reset} ${play.game}`,
            `${colors.dim}${play.selection}${colors.reset}@${play.odds}`,
            `${play.edge}`,
            `${play.kaiColor}${play.kai}${colors.reset}`
          );
        });
      }
      console.log('');
    });
  } catch (error) {
    console.error(`${colors.red}Error: ${error.message}${colors.reset}`);
    process.exit(1);
  }

  console.log(`${colors.dim}Press Ctrl+C to exit${colors.reset}`);
}

main();
