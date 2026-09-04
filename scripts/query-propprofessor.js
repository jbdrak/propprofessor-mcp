#!/usr/bin/env node
'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_LEAGUES } = require('../lib/propprofessor-shared-utils');
const { getMarketsForSport } = require('../lib/propprofessor-market-registry');

const {
  createPropProfessorClient,
  DEFAULT_USER_AUTH_FILE,
  installAuthFile,
  inspectAuthSetup,
  resolveAuthFile
} = require('../lib/propprofessor-api');
const { analyzePlayerPropBet } = require('../lib/propprofessor-analysis');
const { getLocalTimezone, getOddsHistoryLookbackHours } = require('../lib/mcp-runtime-config');
const { correctTennisTimes } = require('../lib/propprofessor-tennis');
const { rankTennisScreenRows, normalizeTennisMarketQuery } = require('../lib/screen-tennis');
const { rankLeagueScreenRows, getLeagueRankingPreset } = require('../lib/screen-ranker');
const { extractScreenRows } = require('../lib/screen-parser');
const { buildRankedScreenResponse, getDebugFlag } = require('../lib/propprofessor-mcp-ranked-screen');
const { createMcpHandlers } = require('./propprofessor-mcp-server');
const { resolveSoccerLeague, filterPayloadByLeagueName } = require('./server/handlers/handler-utils');
const { clearScoreTimeline } = require('../lib/propprofessor-risk-score');

const LEAGUE_ALIASES = {
  sport: null,
  nba: 'NBA',
  wnba: 'WNBA',
  mlb: 'MLB',
  nfl: 'NFL',
  nhl: 'NHL',
  ufc: 'UFC',
  mma: 'UFC',
  soccer: 'Soccer',
  ncaab: 'NCAAB',
  ncaaf: 'NCAAF'
};

function getCommandInventory() {
  return [
    { command: 'setup', description: 'Install default config to ~/.propprofessor/config.json (idempotent)' },
    { command: 'opinion', description: 'Analyze a single prop from sportsbook rows' },
    { command: 'sportsbook', description: 'Fetch sportsbook +EV rows' },
    { command: 'smart', description: 'Fetch smart money rows' },
    { command: 'tennis', description: 'Query and rank tennis screen rows' },
    { command: 'sharp-plays', description: 'Scan target-book plays with supportive non-target sharp movement' },
    { command: 'screen', description: 'Query and rank any supported league screen with --league' },
    { command: 'sport', description: 'Alias for screen, use --league to pick the sport' },
    { command: 'nba', description: 'NBA screen shorthand' },
    { command: 'wnba', description: 'WNBA screen shorthand' },
    { command: 'mlb', description: 'MLB screen shorthand' },
    { command: 'nfl', description: 'NFL screen shorthand' },
    { command: 'nhl', description: 'NHL screen shorthand' },
    { command: 'ufc', description: 'UFC screen shorthand' },
    { command: 'ufc-card', description: 'Query a UFC card shortlist' },
    { command: 'mma', description: 'MMA alias for UFC screen shorthand' },
    { command: 'soccer', description: 'Soccer screen shorthand' },
    { command: 'ncaab', description: 'NCAAB screen shorthand' },
    { command: 'ncaaf', description: 'NCAAF screen shorthand' },
    { command: 'presets', description: 'Show active league ranking presets' },
    { command: 'exe', description: 'Display tier-ranked plays in a quick CLI view (pp-exe)' },
    { command: 'list', description: 'Show the command inventory' },
    { command: 'health', description: 'Check auth and endpoint health' },
    { command: 'doctor', description: 'Run first-time setup checks and explain next steps' },
    { command: 'install-auth', description: 'Copy a saved browser session into the default auth location' },
    {
      command: 'login',
      description: 'Open a browser to log in to PropProfessor and save auth automatically (requires playwright)'
    },
    {
      command: 'init',
      description:
        'One-command setup: checks Node version, verifies auth, runs doctor, prints ready-to-paste MCP config for your client'
    }
  ];
}

function buildHelpText() {
  return [
    'PropProfessor query CLI',
    '',
    'Start here:',
    '  pp-query login',
    '  pp-query doctor',
    '  pp-query health',
    '',
    'Common commands:',
    '  pp-query init                            # one-command setup (Node check + auth + doctor + config)',
    '  pp-query login                           # automated browser login (requires playwright)',
    '  pp-query install-auth --source /path/to/auth.json',
    '  pp-query doctor',
    '  pp-query health',
    '  pp-query screen --league NBA --market Moneyline',
    '  pp-query screen --league EPL --market Total Goals',
    '  pp-query screen --league Soccer --league-name EPL --market Total Goals',
    '  pp-query sharp-plays --book Fliff --leagues NBA,MLB,NHL,Tennis,WNBA,UFC --market Moneyline',
    '  pp-query nba --market Moneyline',
    '  pp-query ufc --market Moneyline',
    '  pp-query ufc-card --book NoVigApp --market Moneyline',
    '  pp-query tennis --market Moneyline --limit 10',
    '  pp-query exe                             # display tier-ranked plays',
    '',
    'Useful flags:',
    '  --league NBA',
    '  --market Moneyline',
    '  --books NoVigApp,Polymarket',
    '  --lookback-hours 6',
    '  --limit 10',
    '  --verbosity minimal|standard|full  # response size: minimal ~1KB, standard ~10KB, full raw',
    '',
    'Auth file lookup order:',
    '  1. AUTH_FILE',
    `  2. ${os.homedir()}/.propprofessor/auth.json`,
    '  3. ./auth.json in this repo',
    '',
    'If you are new here, install your browser session with:',
    '  pp-query install-auth --source /path/to/auth.json',
    '',
    'Default auth location:',
    `  ${os.homedir()}/.propprofessor/auth.json`
  ].join('\n');
}

function buildInstallAuthReport(result) {
  return {
    command: 'install-auth',
    ok: true,
    sourceFile: result.sourceFile,
    destinationFile: result.destinationFile,
    usedExistingFile: Boolean(result.usedExistingFile),
    nextStep: 'Run `pp-query doctor` to verify that the installed auth file works.'
  };
}

function getNodeVersionStatus() {
  // Keep this in sync with the "node" engine in package.json (>=20.0.0).
  // The doctor must report the package's actual minimum, not a stale floor.
  const MIN_NODE_MAJOR = 20;
  const major = Number(String(process.versions?.node || '').split('.')[0] || 0);
  return {
    ok: major >= MIN_NODE_MAJOR,
    current: process.versions?.node || 'unknown',
    required: `${MIN_NODE_MAJOR}+`
  };
}

function buildDoctorReport(healthResult) {
  const node = getNodeVersionStatus();
  const auth = inspectAuthSetup();
  const endpointOk = Boolean(healthResult?.ok);
  const sessionExpiry = auth.sessionExpiry;

  let nextStep = 'Ready to add this server to your MCP client.';
  if (!node.ok) {
    nextStep = `Install Node.js ${node.required} or newer, then rerun \`pp-query doctor\`.`;
  } else if (!auth.ok) {
    nextStep = `Save your PropProfessor browser session to ${auth.defaultUserAuthFile} or set AUTH_FILE, then rerun \`pp-query doctor\`.`;
  } else if (sessionExpiry && sessionExpiry.status === 'expired') {
    nextStep = `Session expired. Run \`pp-query login\` to re-authenticate.`;
  } else if (sessionExpiry && sessionExpiry.status === 'critical') {
    nextStep = `Session expires in ${sessionExpiry.daysRemaining} day(s). Run \`pp-query login\` before it expires.`;
  } else if (!endpointOk) {
    nextStep =
      'Your auth file was found, but the live health check failed. Refresh your browser session and rerun `pp-query doctor`.';
  }

  return {
    command: 'doctor',
    ok: node.ok && auth.ok && endpointOk,
    checks: {
      node,
      auth,
      endpoint: {
        ok: endpointOk,
        details: healthResult || null
      }
    },
    summary: {
      node: node.ok ? 'ok' : 'error',
      auth: auth.ok ? 'ok' : 'error',
      endpoint: endpointOk ? 'ok' : 'error',
      session: sessionExpiry ? sessionExpiry.status : 'unknown',
      sessionExpiresAt: sessionExpiry?.sessionExpiry || null,
      sessionDaysRemaining: sessionExpiry?.daysRemaining || null,
      sessionWarning: sessionExpiry?.warning || null
    },
    nextStep
  };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const [rawCommand = 'help'] = args;
  const command = rawCommand === '--help' || rawCommand === '-h' ? 'help' : rawCommand;
  const opts = {};

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--player' || arg === '-p') {
      opts.player = next;
      i += 1;
    } else if (arg === '--market' || arg === '-m') {
      opts.market = next;
      i += 1;
    } else if (arg === '--line' || arg === '-l') {
      opts.line = next;
      i += 1;
    } else if (arg === '--side' || arg === '-s') {
      opts.side = next;
      i += 1;
    } else if (arg === '--limit') {
      opts.limit = next;
      i += 1;
    } else if (arg === '--verbosity' || arg === '-v') {
      opts.verbosity = next;
      i += 1;
    } else if (arg === '--max-age-ms' || arg === '--maxAgeMs') {
      opts.maxAgeMs = next;
      i += 1;
    } else if (arg === '--lookback-hours' || arg === '--lookbackHours') {
      opts.lookbackHours = next;
      i += 1;
    } else if (arg === '--league' || arg === '-g') {
      opts.league = next;
      i += 1;
    } else if (arg === '--league-name' || arg === '--leagueName') {
      opts.leagueName = next;
      i += 1;
    } else if (arg === '--books' || arg === '-b') {
      opts.books = next;
      i += 1;
    } else if (arg === '--book' || arg === '--target-book' || arg === '--targetBook') {
      opts.book = next;
      opts.targetBook = next;
      i += 1;
    } else if (arg === '--leagues') {
      opts.leagues = next;
      i += 1;
    } else if (arg === '--reset') {
      // Audit fix (2026-07-11): clear the module-level score timeline so a
      // new CLI invocation starts with no cross-session vote history.
      opts.reset = true;
    } else if (arg === '--markets') {
      opts.market = next;
      opts.markets = next;
      i += 1;
    } else if (arg === '--event-date' || arg === '--eventDate') {
      opts.eventDate = next;
      i += 1;
    } else if (arg === '--card-window' || arg === '--cardWindow') {
      opts.cardWindow = next;
      i += 1;
    } else if (arg === '--upcoming-only' || arg === '--upcomingOnly') {
      opts.upcomingOnly = true;
    } else if (arg === '--max-hours-away' || arg === '--maxHoursAway') {
      opts.maxHoursAway = next;
      i += 1;
    } else if (arg === '--scan-limit' || arg === '--scanLimit') {
      opts.scanLimit = next;
      i += 1;
    } else if (arg === '--min-odds' || arg === '--minOdds') {
      opts.minOdds = next;
      i += 1;
    } else if (arg === '--max-odds' || arg === '--maxOdds') {
      opts.maxOdds = next;
      i += 1;
    } else if (arg === '--min-consensus-book-count' || arg === '--minConsensusBookCount') {
      opts.minConsensusBookCount = next;
      i += 1;
    } else if (arg === '--broad') {
      opts.broad = true;
      opts.strict = false;
    } else if (arg === '--include-passes' || arg === '--includePasses') {
      opts.includePasses = true;
    } else if (arg === '--hide-passes' || arg === '--hidePasses') {
      opts.hidePasses = true;
    } else if (arg === '--focus-book-only' || arg === '--focusBookOnly') {
      opts.focusBookOnly = true;
    } else if (arg === '--allow-recent-only' || arg === '--allowRecentOnly') {
      opts.allowRecentOnly = true;
    } else if (arg === '--source') {
      opts.source = next;
      i += 1;
    } else if (arg === '--dest' || arg === '--destination') {
      opts.destination = next;
      i += 1;
    } else if (arg === '--live') {
      opts.live = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--debug') {
      opts.debug = true;
    } else if (arg === '--no-debug') {
      opts.debug = false;
    } else if (arg === '--group-by' || arg === '--groupBy') {
      opts.groupBy = next;
      i += 1;
    } else if (arg === '--since') {
      opts.since = next;
      i += 1;
    } else if (arg === '--days') {
      opts.days = next;
      i += 1;
    } else if (arg === '--timeout') {
      opts.timeout = next;
      i += 1;
    }
  }

  return { command, opts };
}

function extractRows(payload) {
  return extractScreenRows(payload);
}

function emitJson(logger, payload) {
  logger.log(JSON.stringify(payload, null, 2));
}

async function queryTennisPayloads(client, { market, books, is_live } = {}) {
  const tennisQuery =
    typeof client.queryScreenOdds === 'function'
      ? client.queryScreenOdds.bind(client)
      : client.queryScreenOddsBestComps.bind(client);
  const payloads = [];

  for (const tennisMarket of normalizeTennisMarketQuery(market || 'Moneyline')) {
    payloads.push(
      await tennisQuery({
        league: 'Tennis',
        market: tennisMarket,
        books,
        is_live
      })
    );
  }

  return payloads;
}

function resolveScreenCommand(command, opts = {}) {
  if (Object.prototype.hasOwnProperty.call(LEAGUE_ALIASES, command)) {
    const baseLeague = LEAGUE_ALIASES[command] || opts.league || 'NBA';
    const resolved = resolveSoccerLeague(baseLeague, opts.leagueName);
    return {
      command: 'screen',
      league: resolved.league,
      ...(resolved.leagueName ? { leagueName: resolved.leagueName } : {})
    };
  }
  const resolved = resolveSoccerLeague(opts.league || 'NBA', opts.leagueName);
  return {
    command,
    league: resolved.league,
    ...(resolved.leagueName ? { leagueName: resolved.leagueName } : {})
  };
}

function formatLocalStart(value, timeZone = getLocalTimezone()) {
  if (!value) return null;
  const raw = String(value);
  const hasExplicitZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(raw);
  const date = new Date(hasExplicitZone ? raw : `${raw}Z`);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(date);
}

function normalizeScreenRowTimes(rows, timeZone = getLocalTimezone()) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const startLabel = formatLocalStart(row?.start, timeZone);
    return {
      ...row,
      startRaw: row?.start ?? null,
      startLocal: startLabel,
      startDisplay: startLabel
    };
  });
}

function getMultiValueOption(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  if (value === undefined || value === null || value === '') return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toBooleanOption(value) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return !['false', '0', 'no', 'off'].includes(normalized);
}

function renderUfcCardOutput(result, logger = console) {
  const officialPlays = Array.isArray(result?.officialPlays) ? result.officialPlays : [];
  const bestLooks = Array.isArray(result?.bestLooks) ? result.bestLooks : [];
  const passes = Array.isArray(result?.passes) ? result.passes : [];
  const summaryText =
    result?.summaryText ||
    result?.summary ||
    `UFC card: ${officialPlays.length} official bet${officialPlays.length === 1 ? '' : 's'}, ${bestLooks.length} look${bestLooks.length === 1 ? '' : 's'}, ${passes.length} pass${passes.length === 1 ? '' : 'es'}.`;

  const lines = [];
  const addSection = (title, rows) => {
    lines.push(title);
    if (!rows.length) {
      lines.push('  (none)');
      return;
    }
    rows.slice(0, 10).forEach((row, index) => {
      const label =
        row?.summary ||
        row?.label ||
        row?.name ||
        row?.fighter ||
        row?.participant ||
        row?.selection ||
        row?.market ||
        row?.title ||
        JSON.stringify(row);
      lines.push(`  ${index + 1}. ${label}`);
    });
  };

  addSection('Official UFC bets', officialPlays);
  addSection('Best UFC looks', bestLooks);
  addSection('Passes', passes);
  lines.push('Summary');
  lines.push(`  ${summaryText}`);

  logger.log(lines.join('\n'));
}

async function runInitCommand({ opts, client, logger }) {

    const authPath = resolveAuthFile();
    const authInfo = inspectAuthSetup();
    const nodeVer = getNodeVersionStatus();

    if (!nodeVer.ok) {
      logger.log(`✖ Node.js ${nodeVer.current} — need ${nodeVer.required}. Install a newer Node.js first.`);
      process.exitCode = 1;
      return;
    }
    logger.log(`✓ Node.js ${nodeVer.current} (${nodeVer.required})`);

    if (!authInfo.ok) {
      logger.log('→ No valid auth found. Opening browser for PropProfessor login...');
      try {
        const { loginCli } = require('./pp-login');
        await loginCli({
          authFile: opts.destination || DEFAULT_USER_AUTH_FILE,
          timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
          json: false,
          logger
        });
        logger.log('✓ Auth saved');
      } catch (err) {
        logger.log(`✖ Login failed: ${err.message}`);
        logger.log('  → Try: pp-query login');
        process.exitCode = 1;
        return;
      }
    } else {
      logger.log(`✓ Auth file found at ${authInfo.authFilePath || authPath}`);
    }

    // Run doctor
    logger.log('');
    logger.log('Running doctor...');
    let healthResult;
    try {
      healthResult = await client.healthStatus();
    } catch (error) {
      healthResult = { ok: false, error: String(error?.message || error) };
    }
    logger.log(JSON.stringify(buildDoctorReport(healthResult), null, 2));

    // Print MCP config
    logger.log('');
    logger.log('─── Ready-to-paste MCP Config ───');
    logger.log('');
    const scriptPath = path.resolve(__dirname, 'propprofessor-mcp-server.js');
    const config = {
      mcpServers: {
        propprofessor: {
          command: 'node',
          args: [scriptPath],
          env: {
            PROPPROFESSOR_MCP_NDJSON: 'true',
            AUTH_FILE: authInfo.authFilePath || path.join(os.homedir(), '.propprofessor', 'auth.json')
          }
        }
      }
    };
    logger.log(JSON.stringify(config, null, 2));
    logger.log('');
    logger.log("Copy the above into your client's MCP config, then restart.");
    return;

}

async function runOpinionCommand({ opts, client, logger }) {

    const rows = extractRows(await client.querySportsbook());
    const query = {
      player: opts.player,
      market: opts.market,
      line: opts.line !== undefined ? Number(opts.line) : undefined,
      side: opts.side
    };
    const result = analyzePlayerPropBet(query, rows);
    emitJson(logger, result);
    return;

}

async function runMiscCommands({ command, opts, client, logger }) {
  if (command === 'ufc-card') {

    const handlers = createMcpHandlers({ client });
    const result = await handlers.ufc_card({
      book: opts.book || opts.targetBook,
      targetBook: opts.targetBook || opts.book,
      markets: getMultiValueOption(opts.markets || opts.market),
      eventDate: opts.eventDate,
      cardWindow: opts.cardWindow,
      upcomingOnly: toBooleanOption(opts.upcomingOnly),
      maxHoursAway: opts.maxHoursAway !== undefined ? Number(opts.maxHoursAway) : undefined,
      limit: opts.limit !== undefined ? Number(opts.limit) : undefined,
      scanLimit: opts.scanLimit !== undefined ? Number(opts.scanLimit) : undefined,
      debug: toBooleanOption(opts.debug),
      is_live: Boolean(opts.live)
    });
    if (opts.json) {
      emitJson(logger, result);
    } else {
      renderUfcCardOutput(result, logger);
    }
    return true;

  }

  if (command === 'presets') {

    const leagues = ['NBA', 'WNBA', 'MLB', 'NFL', 'NHL', 'UFC', 'SOCCER', 'TENNIS', 'NCAAB', 'NCAAF'];
    const presets = leagues.map((league) => getLeagueRankingPreset(league));
    emitJson(logger, { command, presets });
    return true;

  }

  if (command === 'health') {

    const result = await client.healthStatus();
    emitJson(logger, { command, ...result });
    return true;

  }

  if (command === 'doctor') {

    let healthResult;
    try {
      healthResult = await client.healthStatus();
    } catch (error) {
      healthResult = {
        ok: false,
        error: String(error?.message || error)
      };
    }
    emitJson(logger, buildDoctorReport(healthResult));
    return true;

  }

  if (command === 'install-auth') {

    if (!opts.source) {
      throw new Error(`install-auth requires --source. Example: pp-query install-auth --source /path/to/auth.json`);
    }
    const installResult = installAuthFile({
      sourceFile: opts.source,
      destinationFile: opts.destination || DEFAULT_USER_AUTH_FILE
    });
    emitJson(logger, buildInstallAuthReport(installResult));
    return true;

  }

  if (command === 'login') {

    const { loginCli } = require('./pp-login');
    await loginCli({
      authFile: opts.destination || DEFAULT_USER_AUTH_FILE,
      timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
      json: Boolean(opts.json),
      logger
    });
    return true;

  }

  if (command === 'exe') {

    // Launch the tier-ranked plays display
    const { execSync } = require('child_process');
    const scriptPath = require('path').join(__dirname, 'prop-professor.exe.js');
    execSync(`node "${scriptPath}"`, { stdio: 'inherit' });
    return true;

  }

  return false;
}

async function runSharpPlaysCommand({ opts, client, logger, lookbackHours, debug }) {

    const targetBook = opts.book || opts.targetBook || opts.books?.split(',')?.[0] || 'NoVigApp';
    const leagues = opts.leagues
      ? String(opts.leagues)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : opts.league
        ? [opts.league]
        : Array.from(DEFAULT_LEAGUES);
    const markets = resolveSharpPlaysMarkets({
      leagues,
      book: targetBook,
      markets: opts.markets
        ? String(opts.markets)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      market: opts.market
    });
    const { createMcpHandlers } = require('./propprofessor-mcp-server');
    const handlers = createMcpHandlers({ client });
    const result = await handlers.sharp_plays({
      book: targetBook,
      leagues,
      markets,
      limit: opts.limit ? Number(opts.limit) : 10,
      scanLimit: opts.scanLimit ? Number(opts.scanLimit) : undefined,
      minOdds: opts.minOdds !== undefined ? Number(opts.minOdds) : undefined,
      maxOdds: opts.maxOdds !== undefined ? Number(opts.maxOdds) : undefined,
      minConsensusBookCount: opts.minConsensusBookCount !== undefined ? Number(opts.minConsensusBookCount) : undefined,
      includePasses: Boolean(opts.includePasses),
      strict: opts.strict !== undefined ? opts.strict : !opts.broad,
      allowRecentOnly: Boolean(opts.allowRecentOnly),
      maxAgeMs: opts.maxAgeMs ? Number(opts.maxAgeMs) : undefined,
      lookbackHours,
      debug,
      is_live: Boolean(opts.live),
      verbosity: opts.verbosity || 'standard'
    });
    emitJson(logger, result);
    return;

}

async function runTennisCommand({ opts, payloads, client, logger, lookbackHours, debug, command, payload }) {

    // --book (singular) sets the focus/preferred book; --books (plural) sets
    // the full list. --book wins when both are provided. The full list defaults
    // to the standard sharp set so consensus comparison still has data; the
    // focus book defaults to NoVigApp (the most common user request for tennis).
    const focusBookName = opts.book ? String(opts.book).trim() : null;
    const tennisBooks = opts.books
      ? String(opts.books)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : focusBookName
        ? [focusBookName, 'Pinnacle', 'Polymarket', 'Kalshi', 'BetOnline', 'Circa']
        : ['NoVigApp', 'Pinnacle', 'Polymarket', 'Kalshi', 'BetOnline', 'Circa'];
    const preferredBookName = focusBookName || tennisBooks[0];
    const result = await buildRankedScreenResponse({
      client,
      payloads: Array.isArray(payloads) && payloads.length ? payloads : [payload],
      args: {
        books: tennisBooks,
        historySportsbooks: tennisBooks,
        limit: opts.limit ? Number(opts.limit) : 12,
        includeAll: true,
        maxAgeMs: opts.maxAgeMs ? Number(opts.maxAgeMs) : null,
        lookbackHours,
        debug
      },
      league: 'Tennis',
      focusBook: preferredBookName,
      rankRows: (hydratedRows, { debug: rankedDebug } = {}) =>
        rankTennisScreenRows(hydratedRows, {
          limit: opts.limit ? Number(opts.limit) : 12,
          includeAll: true,
          maxAgeMs: opts.maxAgeMs ? Number(opts.maxAgeMs) : null,
          preferredBook: preferredBookName,
          debug: rankedDebug
        }),
      resultMeta: {
        command,
        notes: {
          consensusEdgeSource: 'row.value/row.ev/row.edge if exposed by PP',
          clvProxy: 'open odds vs current odds when history fields are present',
          timeInterpretation: `start values without an explicit timezone are treated as UTC, displayed in ${getLocalTimezone()}`
        }
      }
    });
    // Correct tennis match times via SportScore before localizing
    if (result?.result) {
      // Preserve the non-enumerable focusBookMissingRows before replacing
      // result.result with the corrected array (which loses the property).
      const fallbackRows = result.result.focusBookMissingRows;
      result.result = await correctTennisTimes(result.result);
      if (fallbackRows) {
        Object.defineProperty(result.result, 'focusBookMissingRows', {
          value: fallbackRows,
          enumerable: false,
          writable: false,
          configurable: false
        });
      }
    }
    const normalized = normalizeScreenRowTimes(result.result);
    // After normalizeScreenRowTimes (which returns a new array), re-attach
    // the non-enumerable focusBookMissingRows if the original result had them.
    if (result.result.focusBookMissingRows) {
      Object.defineProperty(normalized, 'focusBookMissingRows', {
        value: result.result.focusBookMissingRows,
        enumerable: false,
        writable: false,
        configurable: false
      });
    }
    // Preserve focusBookMissingRows across the filter/slice. normalizeScreenRowTimes
    // returns a new array; `filter` below also returns a new array. Hold it
    // on the outer response object so it's always reachable.
    const fallbackRows = result.focusBookMissingRows || result.result.focusBookMissingRows || null;
    // --hide-passes: drop kaiCall=PASS rows. The ranker still ranks them
    // (so PASS rows are surfaced at lower positions in the slate), but the
    // default response can drown the user in noise on a wide slate — 42 of
    // the 100 rows in the last live tennis query were TIER 4 PASS.
    if (opts.hidePasses) {
      const hiddenPassesCount = normalized.filter((row) => row.kaiCall === 'PASS').length;
      result.result = normalized.filter((row) => row.kaiCall !== 'PASS');
      result.count = result.result.length;
      result.resultMeta = result.resultMeta || {};
      result.resultMeta.hiddenPassesCount = hiddenPassesCount;
    } else {
      result.result = normalized;
      result.count = normalized.length;
    }
    // --focus-book-only: drop focusBookMissingRows from the response. By
    // default the ranker surfaces these as a separate top-level field so
    // users can see "what did the ranker find that I can't execute on my
    // focus book?" — the flag is for users who want a pure focus-book
    // response (e.g. "all TIER 1 bets on NoVigApp today" returns exactly
    // the 2 rows executable on NoVigApp, not 3 with one fallback).
    if (opts.focusBookOnly) {
      const fallbackCount = (fallbackRows || []).length;
      result.resultMeta = result.resultMeta || {};
      result.resultMeta.hiddenFallbackRowsCount = fallbackCount;
    } else {
      result.focusBookMissingRows = fallbackRows || [];
    }
    result.notes = {
      ...(result.notes || {}),
      movementAvailable: normalized.some((row) => row.lineHistoryUsable || row.clvProxyPct !== null),
      consensusEdgeSource: 'row.value/row.ev/row.edge if exposed by PP',
      clvProxy: 'open odds vs current odds when history fields are present',
      timeInterpretation: `start values without an explicit timezone are treated as UTC, displayed in ${getLocalTimezone()}`
    };
    result.sample = normalized;
    emitJson(logger, result);
    return;

}

async function runScreenCommand({ opts, client, logger, lookbackHours, debug, command, payload, screenCommand }) {

    const screenBooks = opts.books
      ? String(opts.books)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : ['NoVigApp', 'Polymarket', 'Kalshi', 'BetOnline', 'Circa'];
    const result = await buildRankedScreenResponse({
      client,
      payloads: [filterPayloadByLeagueName(payload, screenCommand.leagueName)],
      args: {
        books: screenBooks,
        historySportsbooks: screenBooks,
        limit: opts.limit ? Number(opts.limit) : 12,
        includeAll: true,
        maxAgeMs: opts.maxAgeMs ? Number(opts.maxAgeMs) : null,
        lookbackHours,
        debug
      },
      league: screenCommand.league,
      focusBook: screenBooks[0] || 'NoVigApp',
      rankRows: (hydratedRows, { debug: rankedDebug } = {}) =>
        rankLeagueScreenRows(hydratedRows, {
          league: screenCommand.league,
          market: opts.market || 'Moneyline',
          limit: opts.limit ? Number(opts.limit) : 12,
          includeAll: true,
          maxAgeMs: opts.maxAgeMs ? Number(opts.maxAgeMs) : null,
          books: screenBooks,
          debug: rankedDebug
        }),
      resultMeta: {
        command,
        notes: {
          consensusEdgeSource: 'row.value/row.ev/row.edge if exposed by PP',
          clvProxy: 'open odds vs current odds when history fields are present',
          timeInterpretation: `start values without an explicit timezone are treated as UTC, displayed in ${getLocalTimezone()}`
        }
      }
    });
    const normalized = normalizeScreenRowTimes(result.result);
    result.result = normalized;
    result.count = normalized.length;
    result.sample = normalized;
    result.notes = {
      ...(result.notes || {}),
      movementAvailable: normalized.some((row) => row.lineHistoryUsable || row.clvProxyPct !== null),
      consensusEdgeSource: 'row.value/row.ev/row.edge if exposed by PP',
      clvProxy: 'open odds vs current odds when history fields are present',
      timeInterpretation: `start values without an explicit timezone are treated as UTC, displayed in ${getLocalTimezone()}`
    };
    emitJson(logger, result);
    return;

}

async function main({ argv = process.argv, client = createPropProfessorClient(), logger = console } = {}) {
  const { command, opts } = parseArgs(argv);

  // Audit fix (2026-07-11): --reset clears the module-level score timeline
  // so a fresh CLI invocation starts with no cross-session tier history.
  if (opts.reset === true) {
    try {
      clearScoreTimeline();
    } catch {
      /* defensive: never block startup */
    }
  }

  const screenCommand = resolveScreenCommand(command, opts);

  if (command === 'help') {
    logger.log(buildHelpText());
    process.exitCode = 0;
    return;
  }

  if (command === 'list') {
    emitJson(logger, { command, commands: getCommandInventory() });
    return;
  }

  if (command === 'init')   if (command === 'init') {
    await runInitCommand({ opts, client, logger });
    return;
  }

  if (command === 'setup') {
    const CONFIG_DIR = path.join(os.homedir(), '.propprofessor');
    const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
    const DEFAULT_PATH = path.join(__dirname, '..', 'config.default.json');

    fs.mkdirSync(CONFIG_DIR, { recursive: true });

    if (fs.existsSync(CONFIG_PATH)) {
      emitJson(logger, { command: 'setup', status: 'exists', path: CONFIG_PATH });
      return;
    }

    const defaults = fs.readFileSync(DEFAULT_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, defaults, { mode: 0o600 });
    emitJson(logger, { command: 'setup', status: 'created', path: CONFIG_PATH });
    return;
  }

  if (command === 'opinion')   if (command === 'opinion') {
    await runOpinionCommand({ opts, client, logger });
    return;
  }

  if (await runMiscCommands({ command, opts, client, logger })) {
    return;
  }

  let payload;
  let payloads = null;
  if (command === 'sportsbook') {
    payload = await client.querySportsbook();
  } else if (command === 'smart') {
    payload = await client.querySmartMoney();
  } else if (command === 'tennis') {
    payloads = await queryTennisPayloads(client, {
      market: opts.market || 'Moneyline',
      books: opts.books
        ? String(opts.books)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      is_live: Boolean(opts.live)
    });
    payload = payloads[0] || { game_data: [] };
  } else if (command === 'sharp-plays') {
    payload = { game_data: [] };
  } else if (screenCommand.command === 'screen') {
    payload = await client.queryScreenOddsBestComps({
      league: screenCommand.league,
      leagueName: screenCommand.leagueName,
      market: opts.market || getMarketsForSport(screenCommand.league)[0] || 'Moneyline',
      books: opts.books
        ? String(opts.books)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      is_live: Boolean(opts.live)
    });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  const rows = extractRows(payload);
  const lookbackHours = getOddsHistoryLookbackHours(opts.lookbackHours);
  const debug = getDebugFlag(opts.debug, true);
  if (command === 'sharp-plays')   if (command === 'sharp-plays') {
    await runSharpPlaysCommand({ opts, client, logger, lookbackHours, debug });
    return;
  }
  if (command === 'tennis')   if (command === 'tennis') {
    await runTennisCommand({ opts, payloads, client, logger, lookbackHours, debug, command, payload });
    return;
  }

  if (screenCommand.command === 'screen')   if (screenCommand.command === 'screen') {
    await runScreenCommand({ opts, client, logger, lookbackHours, debug, command, payload, screenCommand });
    return;
  }

  const filtered = rows.filter((row) => {
    const text = JSON.stringify(row).toLowerCase();
    const playerOk = !opts.player || text.includes(String(opts.player).toLowerCase());
    const marketOk = !opts.market || text.includes(String(opts.market).toLowerCase());
    const lineOk = opts.line === undefined || text.includes(String(opts.line));
    const sideOk = !opts.side || text.includes(String(opts.side).toLowerCase());
    return playerOk && marketOk && lineOk && sideOk;
  });
  emitJson(logger, { command, count: filtered.length, sample: filtered.slice(0, 10) });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  });
}

/**
 * Resolve default markets for the sharp-plays command.
 *
 * Single league: use the per-league registry default (e.g. Tennis →
 * Moneyline / Total Games / Set Handicap). Multi-league: return undefined so
 * the sharp_plays service resolves each league independently. Explicit
 * --markets / --market always win.
 *
 * @param {Object} opts
 * @param {string[]} [opts.leagues]
 * @param {string[]} [opts.markets]
 * @param {string} [opts.market]
 * @param {string} [opts.book]
 * @returns {string[]|undefined}
 */
function resolveSharpPlaysMarkets({ leagues, markets, market, book } = {}) {
  if (Array.isArray(markets) && markets.length) {
    return markets.map((m) => String(m).trim()).filter(Boolean);
  }
  if (market) return [String(market).trim()];
  const leagueList = Array.isArray(leagues) ? leagues.filter(Boolean) : leagues ? [leagues] : [];
  if (leagueList.length === 1) {
    return getMarketsForSport(String(leagueList[0]).trim(), book);
  }
  return undefined;
}

module.exports = {
  buildDoctorReport,
  buildHelpText,
  buildInstallAuthReport,
  getCommandInventory,
  getNodeVersionStatus,
  parseArgs,
  resolveScreenCommand,
  resolveSharpPlaysMarkets,
  extractRows,
  main
};
