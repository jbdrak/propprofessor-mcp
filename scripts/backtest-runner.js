#!/usr/bin/env node
'use strict';

/**
 * PropProfessor Backtest Runner
 *
 * Prints settled-pick performance across a date range.  Does NOT fabricate ROI
 * — if there are no settled picks in range, it says so honestly.
 *
 * Usage:
 *   node scripts/backtest-runner.js --from 2026-06-01 --to 2026-07-20
 *   node scripts/backtest-runner.js --days 30
 *   node scripts/backtest-runner.js --help
 *
 * Reads from ~/.propprofessor/picks.json (logged via `pp log` / `pp picks`).
 */

const { getPickStats, readPicks } = require('../lib/propprofessor-picks');

// ═══════════════════════════════════════════════════════════════════════════
// CLI argument parsing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse CLI arguments.
 * @param {string[]} [argv] - Arguments to parse (defaults to process.argv.slice(2))
 * @returns {{ from: string|null, to: string|null, days: number|null, help: boolean }}
 */
function parseArgs(argv) {
  const args = argv || process.argv.slice(2);
  const opts = { from: null, to: null, days: null, help: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--from':
        opts.from = args[++i] || null;
        break;
      case '--to':
        opts.to = args[++i] || null;
        break;
      case '--days':
        opts.days = parseInt(args[++i], 10);
        break;
      default:
        break;
    }
  }

  return opts;
}

function printHelp() {
  console.log(`PropProfessor Backtest Runner

USAGE
  node scripts/backtest-runner.js [options]

OPTIONS
  --from <YYYY-MM-DD>   Start of date range (inclusive)
  --to   <YYYY-MM-DD>   End of date range (inclusive)
  --days <N>            Last N days (overrides --from/--to)
  -h, --help            Show this help

EXAMPLES
  node scripts/backtest-runner.js --days 30
  node scripts/backtest-runner.js --from 2026-06-01 --to 2026-07-20

Reads settled picks from ~/.propprofessor/picks.json.  Picks are logged
via \`pp log <gameId>\` and resolved via the picks tools.
`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Date filtering
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Filter picks by a `loggedAt` date range (inclusive).
 * @param {Array} picks
 * @param {string|null} from - YYYY-MM-DD
 * @param {string|null} to   - YYYY-MM-DD
 * @returns {Array}
 */
function filterByDateRange(picks, from, to) {
  if (!from && !to) return picks;

  const fromTs = from ? new Date(from + 'T00:00:00Z').getTime() : 0;
  const toTs = to ? new Date(to + 'T23:59:59Z').getTime() : Infinity;

  return picks.filter((p) => {
    const ts = new Date(p.loggedAt).getTime();
    return ts >= fromTs && ts <= toTs;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Output formatting
// ═══════════════════════════════════════════════════════════════════════════

function padR(str, len) {
  return String(str).padEnd(len);
}

function padL(str, len) {
  return String(str).padStart(len);
}

function fmtCurrency(n) {
  if (!Number.isFinite(n)) return '-';
  const sign = n >= 0 ? '+' : '';
  return sign + n.toFixed(2);
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] || '').length)));

  // Header
  const headerLine = headers.map((h, i) => padR(h, widths[i])).join('  ');
  console.log(headerLine);
  console.log('─'.repeat(headerLine.length));

  // Rows
  for (const row of rows) {
    const line = row
      .map((cell, i) => {
        // Right-align numeric columns (2+)
        if (i >= 2) return padL(String(cell || ''), widths[i]);
        return padR(String(cell || ''), widths[i]);
      })
      .join('  ');
    console.log(line);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

function run() {
  const opts = parseArgs();
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const picks = readPicks();
  const filtered = filterByDateRange(picks, opts.from, opts.to);

  // Override readPicks with filtered set for getPickStats
  // getPickStats calls readPicks() internally, but we need it scoped.
  // Use getPickStats days filter if --days given; otherwise compute manually.
  const days = opts.days || null;
  const stats = days ? getPickStats({ days }).stats : computeStatsFromPicks(filtered);

  if (!stats) {
    console.log('No settled data in range.');
    console.log();
    console.log(
      'Honest scope: tier / kaiCall / edge / screenScore are signal-quality ' +
        'ratings, not win-probability predictions. Profitability is UNPROVEN.'
    );
    process.exit(0);
  }

  const rangeLabel = days
    ? `last ${days} days`
    : opts.from && opts.to
      ? `${opts.from} – ${opts.to}`
      : opts.from
        ? `since ${opts.from}`
        : opts.to
          ? `until ${opts.to}`
          : 'all time';

  console.log(`Backtest summary: ${rangeLabel}`);
  console.log();

  // Overview
  console.log(`Total picks:   ${stats.total}`);
  console.log(`Pending:       ${stats.pending}`);
  console.log(`Settled:       ${stats.resolved} (${stats.wins}W / ${stats.losses}L / ${stats.pushes}P)`);
  console.log(`Win rate:      ${stats.winRate || 'n/a'}`);
  console.log(`P&L:           ${fmtCurrency(stats.profit)}`);
  console.log();

  // By tier
  const tiers = Object.keys(stats.byTier || {}).sort();
  if (tiers.length > 0) {
    console.log('By tier:');
    console.log();
    const tierRows = tiers.map((t) => {
      const d = stats.byTier[t];
      return [
        t,
        String(d.picks),
        String(d.wins),
        String(d.losses),
        String(d.pushes),
        d.winRate || '-',
        d.roi || '-',
        fmtCurrency(d.profit)
      ];
    });
    printTable(['Tier', 'Picks', 'W', 'L', 'P', 'Win %', 'ROI', 'P&L'], tierRows);
    console.log();
  }

  // By league
  const leagues = Object.keys(stats.byLeague || {}).sort();
  if (leagues.length > 0) {
    console.log('By league:');
    console.log();
    const leagueRows = leagues.map((l) => {
      const d = stats.byLeague[l];
      return [l, String(d.picks), String(d.wins), String(d.losses), String(d.pushes), d.winRate || '-'];
    });
    printTable(['League', 'Picks', 'W', 'L', 'P', 'Win %'], leagueRows);
    console.log();
  }

  // Honest-scope caveat
  console.log(
    'Honest scope: tier / kaiCall / edge / screenScore are signal-quality ' +
      'ratings, not win-probability predictions. Profitability is UNPROVEN — ' +
      'this tool shows settled data honestly; it does not guarantee future results. ' +
      'The betting decision stays with you.'
  );
}

/**
 * Compute stats from a pre-filtered picks array (used when --from/--to is given
 * instead of --days).
 */
function computeStatsFromPicks(picks) {
  const total = picks.length;
  const pending = picks.filter((p) => p.status === 'pending').length;
  const resolved = picks.filter((p) => p.status !== 'pending');
  const wins = resolved.filter((p) => p.status === 'won').length;
  const losses = resolved.filter((p) => p.status === 'lost').length;
  const pushes = resolved.filter((p) => p.status === 'push').length;
  const decidable = wins + losses;
  const winRate = decidable > 0 ? ((wins / decidable) * 100).toFixed(1) + '%' : null;

  // Profit/loss
  const profit = resolved.reduce((sum, p) => {
    if (!Number.isFinite(p.stake)) return sum;
    if (p.status === 'won') {
      const odds = p.odds;
      const stake = p.stake;
      if (odds > 0) return sum + stake * (odds / 100);
      return sum + stake * (100 / Math.abs(odds));
    }
    if (p.status === 'lost') return sum - p.stake;
    return sum;
  }, 0);

  // By league
  const byLeague = {};
  for (const pick of resolved) {
    const league = pick.league || 'Unknown';
    if (!byLeague[league]) byLeague[league] = { wins: 0, losses: 0, pushes: 0, picks: 0 };
    byLeague[league].picks++;
    if (pick.status === 'won') byLeague[league].wins++;
    else if (pick.status === 'lost') byLeague[league].losses++;
    else byLeague[league].pushes++;
  }
  for (const s of Object.values(byLeague)) {
    const dec = s.wins + s.losses;
    s.winRate = dec > 0 ? ((s.wins / dec) * 100).toFixed(1) + '%' : null;
  }

  // By tier
  const byTier = {};
  for (const pick of resolved) {
    const tier = pick.confidenceTier || 'Unranked';
    if (!byTier[tier]) byTier[tier] = { wins: 0, losses: 0, pushes: 0, picks: 0, profit: 0, totalStake: 0 };
    byTier[tier].picks++;
    if (pick.status === 'won') byTier[tier].wins++;
    else if (pick.status === 'lost') byTier[tier].losses++;
    else byTier[tier].pushes++;
    if (Number.isFinite(pick.stake)) {
      byTier[tier].totalStake += pick.stake;
      if (pick.status === 'won') {
        const odds = pick.odds;
        if (odds > 0) byTier[tier].profit += pick.stake * (odds / 100);
        else byTier[tier].profit += pick.stake * (100 / Math.abs(odds));
      } else if (pick.status === 'lost') {
        byTier[tier].profit -= pick.stake;
      }
    }
  }
  for (const s of Object.values(byTier)) {
    const dec = s.wins + s.losses;
    s.winRate = dec > 0 ? ((s.wins / dec) * 100).toFixed(1) + '%' : null;
    s.profit = Math.round(s.profit * 100) / 100;
    s.roi = s.totalStake > 0 ? ((s.profit / s.totalStake) * 100).toFixed(1) + '%' : null;
  }

  return {
    total,
    pending,
    resolved: resolved.length,
    wins,
    losses,
    pushes,
    winRate,
    profit: Math.round(profit * 100) / 100,
    byLeague,
    byTier
  };
}

if (require.main === module) {
  run();
}

module.exports = { parseArgs, filterByDateRange, computeStatsFromPicks, run };
