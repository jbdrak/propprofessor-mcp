'use strict';

const fs = require('fs');
const path = require('path');
const { createSSBClient } = require('../lib/ssb-api');
const { extractScreenRows } = require('../lib/screen-parser');
const { rankTennisScreenRows } = require('../lib/screen-tennis');
const { rankLeagueScreenRows } = require('../lib/screen-ranker');
const { summarizeFreshness } = require('../lib/screen-summary');
const { hydrateScreenRowsWithHistory } = require('../lib/ssb-screen-history');
const { getOddsHistoryLookbackHours } = require('../lib/mcp-runtime-config');
const { getDebugFlag } = require('../lib/ssb-mcp-ranked-screen');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    league: 'NBA',
    market: 'Moneyline',
    limit: 12,
    output: path.resolve(process.cwd(), 'ranked-screen-rows.json'),
    books: null,
    live: false,
    input: ''
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--league' || arg === '-g') {
      opts.league = next;
      i += 1;
    } else if (arg === '--market' || arg === '-m') {
      opts.market = next;
      i += 1;
    } else if (arg === '--limit' || arg === '-l') {
      opts.limit = Number(next);
      i += 1;
    } else if (arg === '--books' || arg === '-b') {
      opts.books = String(next)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
    } else if (arg === '--output' || arg === '-o') {
      opts.output = path.resolve(next);
      i += 1;
    } else if (arg === '--lookback-hours' || arg === '--lookbackHours') {
      opts.lookbackHours = next;
      i += 1;
    } else if (arg === '--debug') {
      opts.debug = true;
    } else if (arg === '--no-debug') {
      opts.debug = false;
    } else if (arg === '--input') {
      opts.input = next;
      i += 1;
    } else if (arg === '--live') {
      opts.live = true;
    }
  }

  return opts;
}

function loadRowsFromFile(inputPath) {
  if (!inputPath) return null;
  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.rows)) return payload.rows;
  if (payload && Array.isArray(payload.sample)) return payload.sample;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.game_data)) return payload.game_data;
  return null;
}

function toRankedRows(payload, league, limit, options = {}) {
  const rows = extractScreenRows(payload);
  const debug = getDebugFlag(options.debug, true);
  if (league && String(league).toUpperCase() === 'TENNIS') {
    return rankTennisScreenRows(rows, { limit, includeAll: true, debug });
  }
  return rankLeagueScreenRows(rows, { league, limit, includeAll: true, debug });
}

function toCandidateRows(rankedRows) {
  return (Array.isArray(rankedRows) ? rankedRows : []).map((row) => ({
    sport: row.league || row.sport || '',
    league: row.league || row.sport || '',
    market: row.market || row.screenMarket || '',
    participant: row.participant || row.selection || row.pick || '',
    side: row.side || '',
    line: row.line ?? null,
    book: row.book || row.sportsbook || '',
    odds: row.odds ?? row.currentOdds ?? null,
    game_id: row.gameId || null,
    play_id: row.playId || null,
    selection_key: row.selectionKey || null,
    start_time: row.start || null,
    selection_id: row.selectionId || null,
    play_type: row.playType || row.betType || null,
    game: row.game || null,
    consensus_edge: row.consensusEdge ?? null,
    clv_proxy_pct: row.clvProxyPct ?? null,
    screen_score: row.screenScore ?? null,
    is_actionable: Boolean(row.isActionable),
    lineHistoryUsable: row.lineHistoryUsable ?? false,
    freshnessSource: row.freshnessSource ?? null,
    freshnessAgeMs: row.freshnessAgeMs ?? null,
    freshnessFallbackUsed: row.freshnessFallbackUsed ?? false,
    movementSourceBook: row.movementSourceBook ?? null,
    movementMode: row.movementMode ?? null,
    movementLabel: row.movementLabel ?? null,
    recentClvPct: row.recentClvPct ?? null,
    movementQuality: row.movementQuality ?? null,
    movementPointCount: row.movementPointCount ?? null,
    filteredHistoryPointCount: row.filteredHistoryPointCount ?? null,
    droppedHistoryPointCount: row.droppedHistoryPointCount ?? null,
    historySportsbooksRequested: row.historySportsbooksRequested ?? [],
    rankingProvenance: row.rankingProvenance ?? null,
    ranking_reason: row.rankingReason || null,
    notes: [
      row.gateReason ? `gate=${row.gateReason}` : null,
      row.marketHintMatch ? `market=${row.marketHintMatch}` : null
    ].filter(Boolean)
  }));
}

async function main(argv = process.argv) {
  const opts = parseArgs(argv);
  const output = path.resolve(opts.output);
  const league = String(opts.league || 'NBA');
  const market = String(opts.market || 'Moneyline');

  let client;
  let payload;
  let rowsLoaded = 0;

  const localRows = loadRowsFromFile(opts.input);
  if (localRows) {
    payload = localRows;
    rowsLoaded = localRows.length;
  } else {
    client = createSSBClient();
    const queryFn =
      typeof client.queryScreenOddsBestComps === 'function'
        ? client.queryScreenOddsBestComps.bind(client)
        : client.queryScreenOdds.bind(client);
    payload = await queryFn({
      league,
      market,
      books: opts.books || undefined,
      is_live: Boolean(opts.live)
    });
  }

  if (!client) client = createSSBClient();
  const rows = extractScreenRows(payload);
  const lookbackHours = getOddsHistoryLookbackHours(opts.lookbackHours);
  const debug = getDebugFlag(opts.debug, true);
  rowsLoaded = rowsLoaded || rows.length;
  const hydratedRows = await hydrateScreenRowsWithHistory(rows, {
    client,
    lookbackHours,
    preferredBook: opts.books?.[0] || 'Pinnacle',
    sharpBooks: opts.books || ['Pinnacle', 'Polymarket', 'Kalshi', 'BetOnline', 'Circa'],
    historySportsbooks: opts.books || ['Pinnacle', 'Polymarket', 'Kalshi', 'BetOnline', 'Circa']
  });
  const rankedRows = toRankedRows(hydratedRows, league, opts.limit, { debug });

  const candidates = toCandidateRows(rankedRows);
  const result = {
    league,
    market,
    rowsLoaded,
    rankedCount: rankedRows.length,
    freshness: summarizeFreshness(rows),
    debugEnabled: debug,
    candidates,
    rows: rankedRows,
    sample: candidates,
    generatedAt: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  loadRowsFromFile,
  toRankedRows,
  main
};
