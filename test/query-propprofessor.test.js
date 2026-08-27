'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildDoctorReport,
  buildHelpText,
  buildInstallAuthReport,
  getCommandInventory,
  main,
  parseArgs,
  resolveScreenCommand,
  resolveSharpPlaysMarkets
} = require('../scripts/query-propprofessor');

describe('query-propprofessor CLI parsing', () => {
  it('accepts lookback-hours aliases', () => {
    const dashed = parseArgs(['node', 'query', 'screen', '--lookback-hours', '4']);
    assert.equal(dashed.command, 'screen');
    assert.equal(dashed.opts.lookbackHours, '4');

    const camel = parseArgs(['node', 'query', 'screen', '--lookbackHours', '8']);
    assert.equal(camel.command, 'screen');
    assert.equal(camel.opts.lookbackHours, '8');
  });

  it('accepts --verbosity flag and short alias -v', () => {
    const long = parseArgs(['node', 'query', 'sharp-plays', '--verbosity', 'minimal']);
    assert.equal(long.opts.verbosity, 'minimal');

    const short = parseArgs(['node', 'query', 'sharp-plays', '-v', 'full']);
    assert.equal(short.opts.verbosity, 'full');
  });

  it('accepts debug flags', () => {
    const enabled = parseArgs(['node', 'query', 'screen', '--debug']);
    assert.equal(enabled.opts.debug, true);

    const disabled = parseArgs(['node', 'query', 'screen', '--no-debug']);
    assert.equal(disabled.opts.debug, false);
  });

  it('accepts --hide-passes flag and camelCase alias', () => {
    const dashed = parseArgs(['node', 'query', 'tennis', '--hide-passes']);
    assert.equal(dashed.opts.hidePasses, true);
    assert.equal(dashed.command, 'tennis');

    const camel = parseArgs(['node', 'query', 'tennis', '--hidePasses']);
    assert.equal(camel.opts.hidePasses, true);
  });

  it('does not set hidePasses by default', () => {
    const parsed = parseArgs(['node', 'query', 'tennis']);
    assert.notEqual(parsed.opts.hidePasses, true);
  });

  it('accepts positive EV discovery flags', () => {
    const parsed = parseArgs([
      'node',
      'query',
      'sportsbook',
      '--league',
      'NBA',
      '--books',
      'Fliff,NoVigApp',
      '--market',
      'Player Props',
      '--line',
      '-3'
    ]);

    assert.equal(parsed.command, 'sportsbook');
    assert.equal(parsed.opts.league, 'NBA');
    assert.equal(parsed.opts.books, 'Fliff,NoVigApp');
    assert.equal(parsed.opts.market, 'Player Props');
    assert.equal(parsed.opts.line, '-3');
  });

  it('accepts dedicated UFC card aliases and flags', () => {
    const parsed = parseArgs([
      'node',
      'query',
      'ufc-card',
      '--target-book',
      'NoVigApp',
      '--markets',
      'Moneyline,Total',
      '--event-date',
      '2026-05-10',
      '--card-window',
      'today',
      '--upcoming-only',
      '--max-hours-away',
      '24',
      '--scan-limit',
      '10'
    ]);

    assert.equal(parsed.command, 'ufc-card');
    assert.equal(parsed.opts.book, 'NoVigApp');
    assert.equal(parsed.opts.targetBook, 'NoVigApp');
    assert.equal(parsed.opts.market, 'Moneyline,Total');
    assert.equal(parsed.opts.markets, 'Moneyline,Total');
    assert.equal(parsed.opts.eventDate, '2026-05-10');
    assert.equal(parsed.opts.cardWindow, 'today');
    assert.equal(parsed.opts.upcomingOnly, true);
    assert.equal(parsed.opts.maxHoursAway, '24');
    assert.equal(parsed.opts.scanLimit, '10');
  });

  it('resolves documented screen aliases to supported leagues', () => {
    assert.deepEqual(resolveScreenCommand('sport', { league: 'WNBA' }), { command: 'screen', league: 'WNBA' });
    assert.deepEqual(resolveScreenCommand('nba', {}), { command: 'screen', league: 'NBA' });
    assert.deepEqual(resolveScreenCommand('wnba', {}), { command: 'screen', league: 'WNBA' });
    assert.deepEqual(resolveScreenCommand('ufc', {}), { command: 'screen', league: 'UFC' });
    assert.deepEqual(resolveScreenCommand('mma', {}), { command: 'screen', league: 'UFC' });
    assert.deepEqual(resolveScreenCommand('soccer', {}), { command: 'screen', league: 'Soccer' });
  });

  it('exposes the documented command inventory', () => {
    const commands = getCommandInventory().map((c) => c.command);
    assert.deepEqual(commands, [
      'setup',
      'opinion',
      'sportsbook',
      'smart',
      'tennis',
      'sharp-plays',
      'screen',
      'sport',
      'nba',
      'wnba',
      'mlb',
      'nfl',
      'nhl',
      'ufc',
      'ufc-card',
      'mma',
      'soccer',
      'ncaab',
      'ncaaf',
      'presets',
      'exe',
      'list',
      'health',
      'doctor',
      'install-auth',
      'login',
      'init'
    ]);
  });

  it('prints beginner-friendly help text', () => {
    const help = buildHelpText();
    assert.match(help, /Start here:/);
    assert.match(help, /install-auth/);
    assert.match(help, /pp-query doctor/);
    assert.match(help, /pp-query ufc-card/);
    assert.match(help, /Auth file lookup order:/);
  });
});

describe('query-propprofessor CLI command execution', () => {
  function createLogger() {
    const lines = [];
    return {
      logger: {
        log(value) {
          lines.push(String(value));
        }
      },
      lines
    };
  }

  it('renders presets without throwing and includes WNBA', async () => {
    const { logger, lines } = createLogger();

    await main({
      argv: ['node', 'query', 'presets'],
      client: {},
      logger
    });

    const payload = JSON.parse(lines[0]);
    assert.equal(payload.command, 'presets');
    assert.ok(Array.isArray(payload.presets));
    assert.ok(payload.presets.some((entry) => entry.league === 'WNBA'));
  });

  it('renders the command list locally', async () => {
    const { logger, lines } = createLogger();

    await main({
      argv: ['node', 'query', 'list'],
      client: {},
      logger
    });

    const payload = JSON.parse(lines[0]);
    assert.equal(payload.command, 'list');
    assert.ok(Array.isArray(payload.commands));
    assert.ok(payload.commands.some((entry) => entry.command === 'sport'));
  });

  it('routes the sport alias through screen ranking with the requested league', async () => {
    const { logger, lines } = createLogger();
    const calls = [];

    await main({
      argv: ['node', 'query', 'sport', '--league', 'WNBA', '--market', 'Moneyline'],
      client: {
        queryScreenOddsBestComps: async (filters) => {
          calls.push(filters);
          return { game_data: [] };
        }
      },
      logger
    });

    const payload = JSON.parse(lines[0]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].league, 'WNBA');
    assert.equal(payload.league, 'WNBA');
  });

  it('routes ufc-card through ufc_card with UFC card flags', async () => {
    const { logger, lines } = createLogger();
    const calls = [];

    await main({
      argv: [
        'node',
        'query',
        'ufc-card',
        '--book',
        'NoVigApp',
        '--markets',
        'Moneyline,Total',
        '--eventDate',
        '2026-05-10',
        '--cardWindow',
        'today',
        '--upcomingOnly',
        '--maxHoursAway',
        '48',
        '--limit',
        '5',
        '--scanLimit',
        '10',
        '--debug',
        '--live',
        '--json'
      ],
      client: {
        queryScreenOddsBestComps: async (filters) => {
          calls.push(filters);
          return { game_data: [] };
        }
      },
      logger
    });

    const payload = JSON.parse(lines[0]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].league, 'UFC');
    assert.equal(calls[0].market, 'Moneyline');
    assert.equal(calls[0].is_live, false);
    assert.equal(payload.league, 'UFC');
    assert.ok(Array.isArray(payload.officialPlays));
  });

  it('renders concise UFC output for non-json command output', async () => {
    const { logger, lines } = createLogger();

    await main({
      argv: ['node', 'query', 'ufc-card'],
      client: {
        queryScreenOddsBestComps: async () => ({ game_data: [] })
      },
      logger
    });

    const output = lines.join('\n');
    assert.match(output, /Official UFC bets/);
    assert.match(output, /Best UFC looks/);
    assert.match(output, /Passes/);
    assert.match(output, /Summary/);
  });

  it('preserves structured payloads when json output is requested for ufc-card', async () => {
    const { logger, lines } = createLogger();

    await main({
      argv: ['node', 'query', 'ufc-card', '--json'],
      client: {
        queryScreenOddsBestComps: async () => ({ game_data: [] })
      },
      logger
    });

    const payload = JSON.parse(lines[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.league, 'UFC');
    assert.ok(Array.isArray(payload.officialPlays));
    assert.ok(Array.isArray(payload.bestLooks));
    assert.ok(Array.isArray(payload.passes));
    assert.equal(payload.resultMeta.source, 'ufc_card');
  });

  it('routes the nba shorthand alias through screen ranking', async () => {
    const { logger, lines } = createLogger();
    const calls = [];

    await main({
      argv: ['node', 'query', 'nba', '--market', 'Moneyline'],
      client: {
        queryScreenOddsBestComps: async (filters) => {
          calls.push(filters);
          return { game_data: [] };
        }
      },
      logger
    });

    const payload = JSON.parse(lines[0]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].league, 'NBA');
    assert.equal(payload.league, 'NBA');
  });

  for (const [command, expectedLeague] of [
    ['wnba', 'WNBA'],
    ['mlb', 'MLB'],
    ['nfl', 'NFL'],
    ['nhl', 'NHL'],
    ['ufc', 'UFC'],
    ['mma', 'UFC'],
    ['soccer', 'Soccer'],
    ['ncaab', 'NCAAB'],
    ['ncaaf', 'NCAAF']
  ]) {
    it(`smoke-routes ${command} through screen ranking`, async () => {
      const { logger, lines } = createLogger();
      const calls = [];

      await main({
        argv: ['node', 'query', command, '--market', 'Moneyline'],
        client: {
          queryScreenOddsBestComps: async (filters) => {
            calls.push(filters);
            return { game_data: [] };
          }
        },
        logger
      });

      const payload = JSON.parse(lines[0]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].league, expectedLeague);
      assert.equal(payload.league, expectedLeague);
    });
  }

  it('defaults screen markets to the league registry default when --market is omitted (Soccer → Draw No Bet)', async () => {
    const { logger } = createLogger();
    const calls = [];

    await main({
      argv: ['node', 'query', 'soccer'],
      client: {
        queryScreenOddsBestComps: async (filters) => {
          calls.push(filters);
          return { game_data: [] };
        }
      },
      logger
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].league, 'Soccer');
    assert.equal(calls[0].market, 'Draw No Bet');
  });

  it('defaults screen markets to the league registry default when --market is omitted (NBA → Moneyline)', async () => {
    const { logger } = createLogger();
    const calls = [];

    await main({
      argv: ['node', 'query', 'nba'],
      client: {
        queryScreenOddsBestComps: async (filters) => {
          calls.push(filters);
          return { game_data: [] };
        }
      },
      logger
    });

    assert.equal(calls[0].market, 'Moneyline');
  });

  it('honors an explicit --market over the league registry default', async () => {
    const { logger } = createLogger();
    const calls = [];

    await main({
      argv: ['node', 'query', 'soccer', '--market', 'Total Goals'],
      client: {
        queryScreenOddsBestComps: async (filters) => {
          calls.push(filters);
          return { game_data: [] };
        }
      },
      logger
    });

    assert.equal(calls[0].market, 'Total Goals');
  });

  it('resolves sharp-plays default markets from the registry for a single league', () => {
    assert.deepEqual(resolveSharpPlaysMarkets({ leagues: ['Tennis'], book: 'NoVigApp' }), [
      'Moneyline',
      'Total Games',
      'Set Handicap'
    ]);
    assert.deepEqual(resolveSharpPlaysMarkets({ leagues: ['NBA'], book: 'NoVigApp' }), [
      'Moneyline',
      'Point Spread',
      'Total Points'
    ]);
  });

  it('leaves sharp-plays markets to the service default for multi-league scans', () => {
    assert.equal(resolveSharpPlaysMarkets({ leagues: ['NBA', 'Soccer'], book: 'NoVigApp' }), undefined);
  });

  it('honors explicit sharp-plays markets over registry defaults', () => {
    assert.deepEqual(resolveSharpPlaysMarkets({ leagues: ['NBA'], book: 'NoVigApp', markets: ['Player Points'] }), [
      'Player Points'
    ]);
    assert.deepEqual(resolveSharpPlaysMarkets({ leagues: ['NBA'], book: 'NoVigApp', market: 'Total Rounds' }), [
      'Total Rounds'
    ]);
  });

  it('smoke-runs the documented health command', async () => {
    const { logger, lines } = createLogger();

    await main({
      argv: ['node', 'query', 'health'],
      client: {
        healthStatus: async () => ({ ok: true, endpoints: { screen: 'ok' } })
      },
      logger
    });

    const payload = JSON.parse(lines[0]);
    assert.equal(payload.command, 'health');
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.endpoints, { screen: 'ok' });
  });

  it('smoke-runs the doctor command and reports success when health passes', async () => {
    const { logger, lines } = createLogger();

    await main({
      argv: ['node', 'query', 'doctor'],
      client: {
        healthStatus: async () => ({ ok: true, endpoints: { screen: 'ok' } })
      },
      logger
    });

    const payload = JSON.parse(lines[0]);
    assert.equal(payload.command, 'doctor');
    assert.equal(typeof payload.checks.auth.selectedAuthFile, 'string');
    assert.equal(payload.summary.endpoint, 'ok');
  });

  it('smoke-runs the install-auth command and copies a source file', async () => {
    const { logger, lines } = createLogger();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cli-install-auth-'));
    const sourceFile = path.join(tempDir, 'source-auth.json');
    const destinationFile = path.join(tempDir, '.propprofessor', 'auth.json');
    fs.writeFileSync(
      sourceFile,
      JSON.stringify({ cookies: [{ domain: '.propprofessor.com', name: 'session', value: 'abc' }] }),
      'utf8'
    );

    try {
      await main({
        argv: ['node', 'query', 'install-auth', '--source', sourceFile, '--destination', destinationFile],
        client: {},
        logger
      });

      const payload = JSON.parse(lines[0]);
      assert.equal(payload.command, 'install-auth');
      assert.equal(payload.ok, true);
      assert.equal(fs.existsSync(destinationFile), true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('smoke-runs the documented sportsbook and smart commands', async () => {
    const sportsbook = createLogger();
    await main({
      argv: ['node', 'query', 'sportsbook'],
      client: {
        querySportsbook: async () => [{ player: 'A' }]
      },
      logger: sportsbook.logger
    });
    const sportsbookPayload = JSON.parse(sportsbook.lines[0]);
    assert.equal(sportsbookPayload.command, 'sportsbook');
    assert.equal(sportsbookPayload.count, 1);

    const smart = createLogger();
    await main({
      argv: ['node', 'query', 'smart'],
      client: {
        querySmartMoney: async () => [{ player: 'B' }]
      },
      logger: smart.logger
    });
    const smartPayload = JSON.parse(smart.lines[0]);
    assert.equal(smartPayload.command, 'smart');
    assert.equal(smartPayload.count, 1);
  });

  it('expands tennis market aliases the same way as MCP tennis queries', async () => {
    const { logger, lines } = createLogger();
    const calls = [];

    await main({
      argv: ['node', 'query', 'tennis', '--market', 'Spread'],
      client: {
        queryScreenOdds: async (filters) => {
          calls.push(filters);
          return { game_data: [] };
        }
      },
      logger
    });

    const payload = JSON.parse(lines[0]);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls.map((call) => call.market),
      ['Game Handicap']
    );
    assert.equal(payload.league, 'Tennis');
  });

  it('builds a doctor report with a clear next step when endpoint health fails', () => {
    const report = buildDoctorReport({ ok: false, error: 'boom' });
    assert.equal(report.command, 'doctor');
    assert.equal(report.summary.endpoint, 'error');
    assert.equal(typeof report.nextStep, 'string');
  });

  it('doctor reports the package Node 20 minimum (matches engines.node >=20.0.0)', () => {
    const report = buildDoctorReport({ ok: true, endpoints: { screen: 'ok' } });
    const node = report.checks.node;
    assert.equal(node.required, '20+');
    assert.equal(node.ok, true);
    assert.equal(report.summary.node, 'ok');
  });

  it('doctor fails the node check on a stale Node 18 floor', () => {
    // Simulate a Node 18 runtime: process.versions.node is read at call time,
    // so verify the threshold math directly via the exported helper behavior.
    const { getNodeVersionStatus } = require('../scripts/query-propprofessor');
    // Force a Node 18 major through a patched view of process.versions.
    const realVersions = process.versions;
    try {
      Object.defineProperty(process, 'versions', {
        configurable: true,
        value: { ...realVersions, node: '18.20.4' }
      });
      const status = getNodeVersionStatus();
      assert.equal(status.ok, false);
      assert.equal(status.required, '20+');
    } finally {
      Object.defineProperty(process, 'versions', { configurable: true, value: realVersions });
    }
  });

  it('builds an install-auth report with a follow-up step', () => {
    const report = buildInstallAuthReport({
      sourceFile: '/tmp/source.json',
      destinationFile: '/tmp/auth.json',
      usedExistingFile: false
    });
    assert.equal(report.command, 'install-auth');
    assert.equal(report.ok, true);
    assert.match(report.nextStep, /pp-query doctor/);
  });

  it('accepts --group-by and --since flags', () => {
    const parsed = parseArgs(['node', 'query', 'stats', '--group-by', 'league,book', '--since', '2026-01-01']);
    assert.equal(parsed.command, 'stats');
    assert.equal(parsed.opts.groupBy, 'league,book');
    assert.equal(parsed.opts.since, '2026-01-01');
  });

  it('accepts --days flag', () => {
    const parsed = parseArgs(['node', 'query', 'calibration', '--days', '30']);
    assert.equal(parsed.command, 'calibration');
    assert.equal(parsed.opts.days, '30');
  });

  it('accepts --reset flag (boolean, no value)', () => {
    const parsed = parseArgs(['node', 'query', 'presets', '--reset']);
    assert.equal(parsed.opts.reset, true);
  });
});

describe('query-propprofessor CLI: --reset clears score timeline (audit finding #1 defense)', () => {
  it('main() calls clearScoreTimeline when --reset is passed', async () => {
    // The CLI imports clearScoreTimeline at module load. Verify the wiring
    // by intercepting the require cache: load a fresh copy of the CLI into
    // a sandboxed require where we control the risk-score module.
    const Module = require('module');
    const originalLoad = Module._load;
    const calls = [];
    Module._load = function (request, parent, isMain) {
      const resolved = originalLoad.call(this, request, parent, isMain);
      if (request.endsWith('propprofessor-risk-score')) {
        return new Proxy(resolved, {
          get(target, prop) {
            if (prop === 'clearScoreTimeline') {
              return () => calls.push('cleared');
            }
            return target[prop];
          }
        });
      }
      return resolved;
    };
    try {
      // Re-require the CLI with the proxy in place
      delete require.cache[require.resolve('../scripts/query-propprofessor')];
      const cli = require('../scripts/query-propprofessor');
      const { logger } = { logger: { log() {} } };
      await cli.main({ argv: ['node', 'query', 'presets', '--reset'], client: {}, logger });
      assert.ok(calls.length >= 1, 'clearScoreTimeline should be called when --reset is passed');
    } finally {
      Module._load = originalLoad;
      delete require.cache[require.resolve('../scripts/query-propprofessor')];
    }
  });
});
