'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const packageJson = require('../package.json');
const {
  createMcpHandlers,
  createMcpServer,
  createStdioMessageReader,
  mapWithConcurrency
} = require('../scripts/propprofessor-mcp-server');
const { runSharpPlays } = require('../lib/propprofessor-sharp-plays-service');
const { ALL_SCREEN_BOOKS } = require('../lib/propprofessor-sharp-books');
const { RateLimiter } = require('../lib/rate-limiter');

const serverPath = path.join(__dirname, '..', 'scripts', 'propprofessor-mcp-server.js');

function createRankedScreenClientStub({
  rankedPayload = {
    game_data: [
      {
        gameId: 'stub-game-1',
        league: 'NBA',
        market: 'Moneyline',
        updatedAt: new Date(Date.now() - 30 * 1000).toISOString(),
        homeTeam: 'Stub Home',
        awayTeam: 'Stub Away',
        selections: {
          a: {
            selection1: 'Stub Home',
            participant1: 'Stub Home',
            selection1Id: 'Moneyline:Stub_Home',
            selection2: 'Stub Away',
            participant2: 'Stub Away',
            selection2Id: 'Moneyline:Stub_Away',
            odds: {
              NoVigApp: { odds1: -118, odds2: 104 },
              Fliff: { odds1: -118, odds2: 104 },
              Polymarket: { odds1: -125, odds2: 110 }
            }
          }
        },
        defaultKey: 'a'
      }
    ]
  },
  rawPayload = { ok: true, rows: [] },
  healthPayload = { ok: true, screen: { reachable: true } }
} = {}) {
  const calls = {
    queryBackendFantasyPicks: [],
    querySportsbook: [],
    queryScreenOdds: [],
    queryScreenOddsBestComps: [],
    healthStatus: 0
  };

  return {
    calls,
    client: {
      queryBackendFantasyPicks: async (filters) => {
        calls.queryBackendFantasyPicks.push(filters);
        return [{ id: 'fantasy-row-1', sportsbook: filters?.sportsbook || 'DraftKings6' }];
      },
      queryFantasyPicks: async () => {
        throw new Error('legacy fantasy endpoint must not be called');
      },
      querySportsbook: async (filters) => {
        calls.querySportsbook.push(filters);
        return [{ id: 'ev-row-1', book: 'Fliff', ev: 4.2 }];
      },
      queryScreenOdds: async (filters) => {
        calls.queryScreenOdds.push(filters);
        return rawPayload;
      },
      queryScreenOddsBestComps: async (filters) => {
        calls.queryScreenOddsBestComps.push(filters);
        return rankedPayload;
      },
      queryOddsHistory: async ({ sportsbooks } = {}) => {
        const requested = Array.isArray(sportsbooks) && sportsbooks.length ? sportsbooks : ['NoVigApp'];
        const book = requested.length > 1 ? requested[1] : requested[0];
        // Movement for the primary side (selection1). With the isOppositeSide
        // fix (2026-06-27), selection2 rows correctly invert this, so Lakers
        // (sel1) gets supportive and Warriors (sel2) gets adverse from the
        // same history stream. This is correct — you can't claim supportive
        // movement for both sides from the same book's odds.
        return {
          [book]: [
            { odds: -118, start_ts: 1 },
            { odds: -130, start_ts: 2 }
          ]
        };
      },
      healthStatus: async () => {
        calls.healthStatus += 1;
        return healthPayload;
      }
    }
  };
}

function assertBasicRankedResponse(result, expectedLeague) {
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.result));
  assert.equal(result.league, expectedLeague);
  assert.ok(result.resultMeta && typeof result.resultMeta === 'object');
  assert.equal(typeof result.resultMeta.debugEnabled, 'boolean');
}

function createJsonRpcMessage(id, method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  return `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
}

function waitForJsonRpcMessage(proc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for MCP response. Buffer: ${buffer.slice(0, 500)}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onStderr);
      proc.off('exit', onExit);
    }

    function maybeParse() {
      const separator = '\r\n\r\n';
      const headerEnd = buffer.indexOf(separator);
      if (headerEnd === -1) return null;
      const headerText = buffer.slice(0, headerEnd);
      const headers = {};
      for (const line of headerText.split('\r\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      const contentLength = Number(headers['content-length'] || 0);
      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        throw new Error(`Invalid Content-Length header: ${headers['content-length'] || '<missing>'}`);
      }
      // Content-Length is UTF-8 bytes, but buffer is a JS string (UTF-16).
      // Multi-byte Unicode characters make byte count differ from char count.
      // Convert to Buffer for accurate byte arithmetic.
      const bodyStart = headerEnd + separator.length;
      const bodySectionBytes = Buffer.from(buffer.slice(bodyStart), 'utf8');
      if (bodySectionBytes.length < contentLength) return null;
      const body = bodySectionBytes.slice(0, contentLength).toString('utf8');
      // Consume the header + exact body bytes from the buffer.
      // Encode full buffer to bytes, slice off consumed bytes, decode back.
      const headerBytes = Buffer.byteLength(buffer.slice(0, bodyStart), 'utf8');
      buffer = Buffer.from(buffer, 'utf8')
        .slice(headerBytes + contentLength)
        .toString('utf8');
      return JSON.parse(body);
    }

    function onData(chunk) {
      buffer += chunk.toString('utf8');
      try {
        const message = maybeParse();
        if (message) {
          cleanup();
          resolve(message);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    }

    function onStderr(chunk) {
      buffer += `\n[stderr] ${chunk.toString('utf8')}`;
    }

    function onExit(code) {
      cleanup();
      reject(new Error(`MCP server exited early with code ${code}. Buffer: ${buffer.slice(0, 500)}`));
    }

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onStderr);
    proc.on('exit', onExit);
  });
}

function waitForNdjsonMessage(proc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for NDJSON MCP response. Buffer: ${buffer.slice(0, 500)}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onStderr);
      proc.off('exit', onExit);
    }

    function onData(chunk) {
      buffer += chunk.toString('utf8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) return;
      cleanup();
      resolve(JSON.parse(line));
    }

    function onStderr(chunk) {
      buffer += `\n[stderr] ${chunk.toString('utf8')}`;
    }

    function onExit(code) {
      cleanup();
      reject(new Error(`MCP server exited early with code ${code}. Buffer: ${buffer.slice(0, 500)}`));
    }

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onStderr);
    proc.on('exit', onExit);
  });
}

describe('propprofessor MCP server stdio contract', () => {
  // Direct smoke coverage checklist for public MCP tools:
  // covered: ev_candidates, screen_raw, screen_ranked, screen, sharp_plays, ufc_card,
  // covered: ev_candidates, screen_raw, screen_ranked, screen, sharp_plays, ufc_card,
  it('responds to initialize and lists the expected tools', async () => {
    const proc = spawn(process.execPath, [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PROPPROFESSOR_MCP_MODE: 'full' }
    });

    try {
      proc.stdin.write(
        createJsonRpcMessage(1, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        })
      );

      const initializeResponse = await waitForJsonRpcMessage(proc);
      assert.equal(initializeResponse.id, 1);
      assert.equal(initializeResponse.jsonrpc, '2.0');
      assert.equal(initializeResponse.result.serverInfo.name, 'propprofessor');
      assert.equal(initializeResponse.result.serverInfo.version, packageJson.version);
      assert.ok(initializeResponse.result.capabilities.tools);

      proc.stdin.write(createJsonRpcMessage(2, 'tools/list', {}));
      const toolsResponse = await waitForJsonRpcMessage(proc);
      assert.equal(toolsResponse.id, 2);
      const toolNames = toolsResponse.result.tools.map((tool) => tool.name).sort();
      assert.deepEqual(toolNames, [
        'all_slates',
        'ask',
        'clear_score_timeline',
        'ev_candidates',
        'fantasy_optimizer',
        'find_best_price',
        'get_alerts',
        'get_market_registry',
        'get_pick_history',
        'get_pick_stats',
        'get_play_details',
        'get_started',
        'health_status',
        'league_presets',
        'log_pick',
        'manage_hidden_bets',
        'mlb_game_context',
        'place_bet',
        'player_context',
        'quick_screen',
        'resolve_pick',
        'scan',
        'screen_ranked',
        'sharp_alerts',
        'sharp_consensus',
        'smart_bet',
        'smart_money',
        'staking_plan',
        'today',
        'ufc_card',
        'validate_play'
      ]);
    } finally {
      proc.kill('SIGTERM');
    }
  });

  it('supports NDJSON initialize and tools/list framing when enabled', async () => {
    const proc = spawn(process.execPath, [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PROPPROFESSOR_MCP_NDJSON: 'true' }
    });

    try {
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' }
          }
        }) + '\n'
      );

      const initializeResponse = await waitForNdjsonMessage(proc);
      assert.equal(initializeResponse.id, 1);
      assert.equal(initializeResponse.result.serverInfo.name, 'propprofessor');

      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
      const toolsResponse = await waitForNdjsonMessage(proc);
      assert.equal(toolsResponse.id, 2);
      assert.ok(Array.isArray(toolsResponse.result.tools));
      assert.ok(toolsResponse.result.tools.length > 0);
    } finally {
      proc.kill('SIGTERM');
    }
  });

  it('returns server not initialized for tools/call before initialize', async () => {
    const server = createMcpServer({
      handlers: {
        screen_ranked: async () => ({ ok: true })
      },
      toolDefinitions: [
        {
          name: 'screen_ranked',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }
      ]
    });

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'screen_ranked', arguments: {} }
    });

    assert.equal(response.error.code, -32002);
    assert.equal(response.error.message, 'Server not initialized');
  });

  it('ignores notifications/initialized without breaking the session', async () => {
    const server = createMcpServer();

    const initializeResponse = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
    });
    assert.equal(initializeResponse.result.serverInfo.name, 'propprofessor');

    const notificationResponse = await server.handleRequest({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    });
    assert.equal(notificationResponse, null);

    const toolsResponse = await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.ok(Array.isArray(toolsResponse.result.tools));
    assert.ok(toolsResponse.result.tools.length > 0);
  });

  it('returns structured categorized errors for failed tool calls', async () => {
    const server = createMcpServer({
      handlers: {
        fail_tool: async () => {
          const error = new Error('Missing PropProfessor auth token');
          error.code = 'AUTH_REQUIRED';
          error.category = 'auth';
          error.status = 401;
          throw error;
        }
      },
      toolDefinitions: [
        {
          name: 'fail_tool',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }
      ]
    });

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'fail_tool', arguments: {} }
    });

    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.ok, false);
    const errObj = response.result.structuredContent.error;
    assert.equal(errObj.code, 'AUTH_REQUIRED');
    assert.equal(errObj.message, 'Missing PropProfessor auth token');
    assert.equal(errObj.category, 'auth');
    assert.equal(errObj.status, 401);
    assert.ok(errObj.recovery.includes('PP_LOGIN_HEADLESS'));
  });

  it('keeps a null tool throw inside the structured error envelope', async () => {
    const server = createMcpServer({
      handlers: {
        fail_tool: async () => {
          throw null;
        }
      },
      toolDefinitions: [
        {
          name: 'fail_tool',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }
      ]
    });

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'fail_tool', arguments: {} }
    });

    assert.equal(response.result.isError, true);
    const errObj = response.result.structuredContent.error;
    assert.equal(errObj.code, 'INTERNAL_ERROR');
    assert.equal(errObj.message, 'Unexpected PropProfessor MCP error');
  });

  it('returns backend validation errors when validated candidates cannot validate any rows', async () => {
    const handlers = createMcpHandlers({
      client: {
        querySportsbook: async () => [
          {
            id: 'row-1',
            league: 'NBA',
            market: 'Moneyline',
            book: 'Fliff',
            participant: 'A',
            selection: 'A',
            gameId: 'game-1',
            selectionId: 'Moneyline:A'
          }
        ],
        queryOddsHistory: async () => {
          const error = new Error('history backend unavailable');
          error.status = 503;
          throw error;
        }
      }
    });

    const server = createMcpServer({
      handlers,
      toolDefinitions: [
        {
          name: 'ev_candidates',
          inputSchema: { type: 'object', properties: {}, additionalProperties: true }
        }
      ]
    });

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ev_candidates', arguments: { leagues: ['NBA'], validated: true } }
    });

    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.ok, false);
    assert.equal(response.result.structuredContent.error.code, 'VALIDATION_INCOMPLETE');
    assert.equal(response.result.structuredContent.error.category, 'backend');
  });

  it('skips malformed Content-Length frames gracefully without crashing', () => {
    const messages = [];
    const reader = createStdioMessageReader((message) => {
      messages.push(message);
    });

    assert.doesNotThrow(() => {
      reader(Buffer.from('Content-Length: nope\r\n\r\n{"jsonrpc":"2.0"}', 'utf8'));
    });
    assert.deepEqual(messages, []);
  });

  // NOTE: screen_raw tests removed — tool deprecated in v1.6.3, folded into screen_ranked.

  // NOTE: query_fantasy_picks test removed — handler not implemented (no fantasy subscription).
  // Re-add when the fantasy tool is wired up. See SKILL.md references/fantasy-surface-guidance.md.

  it('ev_candidates returns sportsbook discovery rows and forwards filters', async () => {
    const { client, calls } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });

    const result = await handlers.ev_candidates({
      sportsbooks: ['Fliff', 'NoVigApp'],
      leagues: ['NBA', 'MLB'],
      marketTypes: ['Main Lines', 'Player Props'],
      periodTypes: ['Full Game'],
      minValue: -3,
      maxValue: 20,
      minOdds: -120,
      maxOdds: 200,
      minHoursAway: 0,
      maxHoursAway: 24,
      minLiquidity: 10,
      maxLiquidity: 1000,
      isLive: false,
      userState: 'tx'
    });

    assert.equal(calls.querySportsbook.length, 1);
    assert.deepEqual(calls.querySportsbook[0], {
      isLive: false,
      userState: 'tx',
      sportsbooks: ['Fliff', 'NoVigApp'],
      leagues: ['NBA', 'MLB'],
      minOdds: -120,
      maxOdds: 200,
      minValue: -3,
      maxValue: 20,
      marketTypes: ['Main Lines', 'Player Props'],
      periodTypes: ['Full Game'],
      minHoursAway: 0,
      maxHoursAway: 24,
      minLiquidity: 10,
      maxLiquidity: 1000
    });
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.equal(result.result[0].book, 'Fliff');
    assert.match(result.notes.workflow, /fast discovery candidates/i);
  });

  it('ev_candidates leaves minValue unset when omitted so frontend filtering can drive it', async () => {
    const { client, calls } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });

    const result = await handlers.ev_candidates({
      sportsbooks: ['Fliff'],
      leagues: ['NBA']
    });

    assert.equal(calls.querySportsbook.length, 1);
    assert.equal(calls.querySportsbook[0].minValue, undefined);
    assert.equal(result.notes.minValueBehavior, 'unset_here_use_frontend_filter');
  });

  it('ev_candidates (validated) ranks sportsbook candidates with movement metadata', async () => {
    const { client } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });

    const result = await handlers.ev_candidates({
      sportsbooks: ['Fliff'],
      leagues: ['NBA'],
      limit: 5,
      debug: false,
      validated: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.resultMeta.source, 'positive_ev_candidates');
    assert.equal(result.resultMeta.candidateCount, 1);
    assert.equal(result.resultMeta.debugEnabled, false);
    assert.ok(Array.isArray(result.result));
    assert.equal(result.result.length, 1);
    assert.equal(result.result[0].book, 'Fliff');
    assert.ok(Object.prototype.hasOwnProperty.call(result.result[0], 'movementLabel'));
    assert.ok(Object.prototype.hasOwnProperty.call(result.result[0], 'rankingProvenance'));
  });

  it('fantasy_optimizer returns fantasy picks with filters', async () => {
    const { client, calls } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });

    const result = await handlers.fantasy_optimizer({
      fantasyApps: ['PrizePicks', 'Underdog'],
      leagues: ['NBA', 'MLB'],
      market: 'Fantasy Points',
      isLive: false
    });

    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.equal(result.result[0].id, 'fantasy-row-1');
    assert.equal(calls.queryBackendFantasyPicks.length, 1);
    assert.deepEqual(calls.queryBackendFantasyPicks[0].fantasyApps, ['PrizePicks', 'Underdog']);
    assert.deepEqual(calls.queryBackendFantasyPicks[0].leagues, ['NBA', 'MLB']);
    assert.equal(calls.queryBackendFantasyPicks[0].market, 'Fantasy Points');
  });

  it('fantasy_optimizer handles empty results gracefully', async () => {
    const handlers = createMcpHandlers({
      client: {
        queryBackendFantasyPicks: async () => [],
        queryFantasyPicks: async () => {
          throw new Error('legacy fantasy endpoint must not be called');
        }
      }
    });

    const result = await handlers.fantasy_optimizer({ leagues: ['NBA'] });

    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
    assert.deepEqual(result.result, []);
  });

  // NOTE: screen_raw (bestComps) test removed — tool deprecated in v1.6.3.
  // NOTE: fantasy_optimizer test added — handler implemented for Fantasy Optimizer subscription.

  it('league presets expose sharpMainMarkets and sharpProps labels', async () => {
    const handlers = createMcpHandlers({
      client: {
        queryScreenOddsBestComps: async (filters) => ({ ok: true, filters }),
        queryOddsHistory: async () => ({})
      }
    });

    const presets = await handlers.league_presets();
    const nba = presets.result.find((entry) => entry.league === 'NBA');
    const wnba = presets.result.find((entry) => entry.league === 'WNBA');
    const nfl = presets.result.find((entry) => entry.league === 'NFL');
    const mlb = presets.result.find((entry) => entry.league === 'MLB');

    assert.ok(wnba);
    assert.equal(wnba.displayName, 'WNBA');

    assert.deepEqual(nba.sharpMainMarkets, ['Circa', 'Pinnacle', 'BookMaker', 'BetOnline', 'DraftKings']);
    assert.deepEqual(nba.sharpProps, ['FanDuel', 'BookMaker', 'PropBuilder', 'NoVigApp', 'Pinnacle']);
    assert.deepEqual(nfl.sharpMainMarkets, ['Circa', 'Pinnacle', 'BookMaker', 'NoVigApp', 'FanDuel']);
    assert.deepEqual(nfl.sharpProps, ['Pinnacle', 'FanDuel', 'BookMaker', 'Circa', 'BetOnline']);
    assert.deepEqual(mlb.sharpMainMarkets, ['Pinnacle', 'Circa', 'BookMaker', 'BetOnline', 'DraftKings', 'BetMGM']);
    assert.deepEqual(mlb.sharpProps, ['Circa', 'FanDuel', 'PropBuilder', 'Pinnacle', 'DraftKings', 'Bet365']);
  });

  it('ufc_card returns a first-class shortlist response and honors card filters', async () => {
    const now = new Date('2026-05-09T12:00:00Z');
    const futureEventDate = '2026-05-10';
    const rankedPayload = {
      game_data: [
        {
          gameId: 'ufc-game-1',
          league: 'UFC',
          market: 'Moneyline',
          updatedAt: new Date(now.getTime() - 45 * 1000).toISOString(),
          start: new Date('2026-05-10T03:00:00Z').toISOString(),
          homeTeam: 'Fighter B',
          awayTeam: 'Fighter A',
          selections: {
            a: {
              selection1: 'Fighter A',
              participant1: 'Fighter A',
              selection1Id: 'Moneyline:Fighter_A',
              selection2: 'Fighter B',
              participant2: 'Fighter B',
              selection2Id: 'Moneyline:Fighter_B',
              odds: {
                NoVigApp: { odds1: 120, odds2: -140 },
                Polymarket: { odds1: 118, odds2: -138 }
              }
            }
          },
          defaultKey: 'a'
        },
        {
          gameId: 'ufc-game-2',
          league: 'UFC',
          market: 'Moneyline',
          updatedAt: new Date(now.getTime() - 45 * 1000).toISOString(),
          start: new Date('2026-05-12T03:00:00Z').toISOString(),
          homeTeam: 'Fighter D',
          awayTeam: 'Fighter C',
          selections: {
            a: {
              selection1: 'Fighter C',
              participant1: 'Fighter C',
              selection1Id: 'Moneyline:Fighter_C',
              selection2: 'Fighter D',
              participant2: 'Fighter D',
              selection2Id: 'Moneyline:Fighter_D',
              odds: {
                NoVigApp: { odds1: 135, odds2: -155 },
                Polymarket: { odds1: 130, odds2: -150 }
              }
            }
          },
          defaultKey: 'a'
        }
      ]
    };
    const { client, calls } = createRankedScreenClientStub({ rankedPayload });
    const handlers = createMcpHandlers({ client });

    assert.equal(typeof handlers.ufc_card, 'function');

    const result = await handlers.ufc_card({
      eventDate: futureEventDate,
      cardWindow: 'today',
      limit: 5,
      scanLimit: 10,
      includePasses: true,
      debug: false,
      is_live: false,
      books: ['NoVigApp', 'Polymarket']
    });

    assert.equal(calls.queryScreenOddsBestComps.length, 1);
    assert.equal(calls.queryScreenOddsBestComps[0].league, 'UFC');
    assert.equal(calls.queryScreenOddsBestComps[0].market, 'Moneyline');
    assert.equal(result.ok, true);
    assert.equal(result.league, 'UFC');
    assert.ok(Number.isFinite(result.count));
    assert.ok(Array.isArray(result.officialPlays));
    assert.ok(Array.isArray(result.bestLooks));
    assert.ok(Array.isArray(result.passes));
    assert.equal(result.summaryText.includes('UFC'), true);
    assert.equal(result.resultMeta.source, 'ufc_card');
    assert.equal(result.resultMeta.cardWindow, 'eventDate');
    assert.equal(result.resultMeta.eventDate, futureEventDate);
    assert.ok(Number.isFinite(result.resultMeta.shortlist.count));
    assert.ok(result.passes.every((row) => row.shortlistEventDate === futureEventDate));
    assert.ok(result.passes.length === 0 || result.passes[0].shortlistCardWindow === 'eventDate');
  });

  it('ufc_card forwards book/targetBook into ranked scanning and normalizes markets arrays', async () => {
    const { client, calls } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });

    const bookResult = await handlers.ufc_card({
      book: 'NoVigApp',
      markets: ['Moneyline', 'Total'],
      limit: 1,
      scanLimit: 4,
      includePasses: false,
      debug: false,
      is_live: false
    });

    const targetBookResult = await handlers.ufc_card({
      targetBook: 'DraftKings',
      markets: ['Total', 'Moneyline'],
      limit: 1,
      scanLimit: 4,
      includePasses: false,
      debug: false,
      is_live: false
    });

    assert.equal(calls.queryScreenOddsBestComps.length, 2);
    // UFC is a non-major league, so the book augmentation sends ALL_SCREEN_BOOKS
    // to ensure the backend returns multi-book consensus data.
    assert.deepEqual(calls.queryScreenOddsBestComps[0].books, ALL_SCREEN_BOOKS);
    assert.equal(calls.queryScreenOddsBestComps[0].market, 'Moneyline');
    assert.equal(bookResult.resultMeta.focusBook, 'NoVigApp');
    assert.deepEqual(bookResult.resultMeta.historySportsbooksRequested, ALL_SCREEN_BOOKS);

    assert.deepEqual(calls.queryScreenOddsBestComps[1].books, ALL_SCREEN_BOOKS);
    // 'Total' is resolved to 'Total Rounds' for UFC via market alias
    assert.equal(calls.queryScreenOddsBestComps[1].market, 'Total Rounds');
    assert.equal(targetBookResult.resultMeta.focusBook, 'DraftKings');
    assert.deepEqual(targetBookResult.resultMeta.historySportsbooksRequested, ALL_SCREEN_BOOKS);
  });

  const screenLeagueExpectedBooks = {
    NBA: ['Pinnacle', 'Circa', 'BookMaker', 'BetOnline', 'DraftKings'],
    // Non-major leagues use ALL_SCREEN_BOOKS for multi-book backend data
    WNBA: ALL_SCREEN_BOOKS,
    MLB: ['Pinnacle', 'Circa', 'BookMaker', 'BetOnline', 'DraftKings', 'BetMGM'],
    NFL: ['Pinnacle', 'Circa', 'BookMaker', 'NoVigApp', 'FanDuel'],
    NHL: ALL_SCREEN_BOOKS,
    UFC: ALL_SCREEN_BOOKS,
    NCAAB: ALL_SCREEN_BOOKS,
    NCAAF: ALL_SCREEN_BOOKS
  };
  for (const { league } of [
    { league: 'NBA' },
    { league: 'WNBA' },
    { league: 'MLB' },
    { league: 'NFL' },
    { league: 'NHL' },
    { league: 'UFC' },
    { league: 'NCAAB' },
    { league: 'NCAAF' }
  ]) {
    it(`screen_ranked(${league}) returns a structured ranked response`, async () => {
      const { client, calls } = createRankedScreenClientStub();
      const handlers = createMcpHandlers({ client });

      const result = await handlers.screen_ranked({
        league,
        market: 'Moneyline',
        books: ['Pinnacle'],
        includeAll: true
      });

      assert.equal(calls.queryScreenOddsBestComps.length, 1);
      assert.equal(calls.queryScreenOddsBestComps[0].league, league);
      assert.equal(calls.queryScreenOddsBestComps[0].market, 'Moneyline');
      assert.deepEqual(calls.queryScreenOddsBestComps[0].books, screenLeagueExpectedBooks[league]);
      assertBasicRankedResponse(result, league);
    });
  }

  it('screen_ranked returns a structured ranked response', async () => {
    const rankedPayload = {
      game_data: [
        {
          gameId: 'game-1',
          league: 'NBA',
          market: 'Moneyline',
          updatedAt: new Date(Date.now() - 30 * 1000).toISOString(),
          homeTeam: 'Lakers',
          awayTeam: 'Warriors',
          selections: {
            a: {
              selection1: 'Lakers',
              participant1: 'Lakers',
              selection1Id: 'Moneyline:Lakers',
              selection2: 'Warriors',
              participant2: 'Warriors',
              selection2Id: 'Moneyline:Warriors',
              odds: {
                NoVigApp: { odds1: -118, odds2: 104 },
                Polymarket: { odds1: -125, odds2: 110 }
              }
            }
          },
          defaultKey: 'a'
        }
      ]
    };
    const { client, calls } = createRankedScreenClientStub({ rankedPayload });
    const handlers = createMcpHandlers({ client });

    const result = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Moneyline',
      includeAll: true,
      books: ['NoVigApp'],
      debug: true
    });

    assert.equal(calls.queryScreenOddsBestComps.length, 1);
    assert.equal(calls.queryScreenOddsBestComps[0].league, 'NBA');
    assert.equal(calls.queryScreenOddsBestComps[0].market, 'Moneyline');
    // Audit 2026-06-15: screen_ranked now augments the backend query and the
    // historySportsbooks list with the NBA Moneyline sharp-book set so
    // consensus data populates. Without augmentation, single-book queries on
    // non-sharp books returned consensusBookCount=0 on every row.
    assert.deepEqual(calls.queryScreenOddsBestComps[0].books, [
      'NoVigApp',
      'Circa',
      'Pinnacle',
      'BookMaker',
      'BetOnline',
      'DraftKings'
    ]);
    assertBasicRankedResponse(result, 'NBA');
    assert.equal(result.freshness.newestAgeMs !== null, true);
    assert.equal(result.resultMeta.focusBook, 'NoVigApp');
    assert.deepEqual(result.resultMeta.historySportsbooksRequested, [
      'NoVigApp',
      'Circa',
      'Pinnacle',
      'BookMaker',
      'BetOnline',
      'DraftKings'
    ]);
    assert.equal(result.resultMeta.debugEnabled, true);
    // Movement comes from a real sharp book (Circa) even though the focus
    // book is NoVigApp — sharp-book movement is the signal, not the no-vig
    // target's own line.
    assert.equal(result.result[0].movementMode, 'comparison_book');
    // Audit 2026-06-15: the mock returns history for requested[1] (the first
    // sharp book in the augmented list, Circa for NBA Moneyline). The ranker
    // uses that as the movement source. The real PropProfessor API would
    // return history for the focus book first; the mock simulates the
    // cross-book movement pattern that classifySharpPlay needs.
    assert.equal(result.result[0].movementSourceBook, 'Circa');
    assert.equal(result.result[0].freshnessSource, 'updatedAt');
    assert.equal(result.result[0].freshnessFallbackUsed, false);
    assert.equal(result.result[0].rankingProvenance.focusBook, 'NoVigApp');
    assert.equal(result.result[0].rankingProvenance.lineHistorySource, 'odds_history');
    assert.equal(Array.isArray(result.result[0].historySportsbooksRequested), true);
    assert.equal(typeof result.result[0].movementDebug, 'object');
    assert.equal(Array.isArray(result.result[0].filteredLineHistory), true);
  });

  it('screen_ranked can disable verbose debug payloads', async () => {
    const { client } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });

    const result = await handlers.screen_ranked({
      league: 'NBA',
      market: 'Moneyline',
      includeAll: true,
      books: ['NoVigApp'],
      debug: false
    });

    assert.equal(result.resultMeta.debugEnabled, false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.result[0], 'movementDebug'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.result[0], 'filteredLineHistory'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.result[0], 'droppedHistoryReasons'), false);
    assert.ok(result.result[0].rankingProvenance);
  });

  it('sharp_plays returns only non-target sharp-supported bet candidates by default', async () => {
    const { client, calls } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });

    const result = await handlers.sharp_plays({
      book: 'NoVigApp',
      leagues: ['NBA'],
      markets: ['Moneyline'],
      minConsensusBookCount: 1,
      limit: 5,
      debug: false
    });

    assert.equal(result.ok, true);
    assert.equal(result.resultMeta.source, 'sharp_plays_addon');
    assert.equal(result.resultMeta.targetBook, 'NoVigApp');
    assert.deepEqual(result.resultMeta.targetBooks, ['NoVigApp']);
    assert.equal(result.resultMeta.targetBookCount, 1);
    // 1 target book query + 1 sharp book group query (all sharp books together)
    assert.equal(result.resultMeta.scannedQueryCount, 2);
    assert.equal(calls.queryScreenOddsBestComps.length, 2);
    assert.equal(calls.queryScreenOddsBestComps[0].league, 'NBA');
    assert.ok(Array.isArray(result.result));
    assert.equal(result.result.length, 2);
    assert.equal(result.result[0].executionBook, 'NoVigApp');
    assert.equal(result.result[0].verdict, 'Bet candidate');
    assert.equal(result.result[0].targetBook, 'NoVigApp');
    assert.equal(result.result[0].sharpPlaySupport.movementIsSharpSourced, true);
    assert.equal(result.result[0].sharpPlaySupport.sourceIsTargetBook, false);
    assert.notEqual(result.result[0].movementSourceBook, 'NoVigApp');
    // Both sides pass — the opposite-side guard correctly prevents false
    // inversion when selectionId contains the selection name (2026-06-27 fix).
  });

  it('sharp plays service preserves the mcp result shape when reused directly', async () => {
    const { client, calls } = createRankedScreenClientStub();

    async function queryLeagueScreen(rankedArgs = {}, league) {
      const payload = await client.queryScreenOddsBestComps({
        market: rankedArgs.market || 'Moneyline',
        league,
        games: Array.isArray(rankedArgs.games) ? rankedArgs.games : [],
        participants: Array.isArray(rankedArgs.participants) ? rankedArgs.participants : [],
        books: Array.isArray(rankedArgs.books) ? rankedArgs.books : [],
        is_live: Boolean(rankedArgs.is_live)
      });
      return {
        ok: true,
        result: Array.isArray(payload?.game_data)
          ? payload.game_data.map((row) => ({
              ...row,
              book: 'NoVigApp',
              targetBook: 'NoVigApp',
              executionBook: 'NoVigApp',
              verdict: 'Bet candidate',
              sharpPlaySupport: { movementIsSharpSourced: true, sourceIsTargetBook: false },
              movementSourceBook: 'Pinnacle'
            }))
          : []
      };
    }

    async function queryTennisScreen() {
      return { ok: true, result: [] };
    }

    const result = await runSharpPlays(
      {
        book: 'NoVigApp',
        leagues: ['NBA'],
        markets: ['Moneyline'],
        minConsensusBookCount: 1,
        limit: 5,
        lookbackHours: 6
      },
      { queryLeagueScreen, queryTennisScreen }
    );

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.result));
    assert.ok(result.resultMeta && typeof result.resultMeta === 'object');
    assert.equal(result.resultMeta.source, 'sharp_plays_addon');
    assert.equal(result.resultMeta.targetBook, 'NoVigApp');
    assert.deepEqual(result.resultMeta.targetBooks, ['NoVigApp']);
    assert.equal(result.resultMeta.lookbackHoursUsed, 6);
    assert.equal(result.resultMeta.scannedQueryCount, 2);
    assert.equal(calls.queryScreenOddsBestComps.length, 2);
  });

  it('sharp_plays adds empty-state diagnostics when strict filtering removes all rows', async () => {
    const handlers = createMcpHandlers({
      client: {
        querySportsbook: async () => [],
        queryScreenOdds: async () => ({ ok: true, rows: [] }),
        queryScreenOddsBestComps: async () => ({
          game_data: [
            {
              gameId: 'empty-state-1',
              league: 'NBA',
              market: 'Moneyline',
              updatedAt: new Date().toISOString(),
              homeTeam: 'Minnesota Timberwolves',
              awayTeam: 'Denver Nuggets',
              selections: {
                a: {
                  selection1: 'Minnesota Timberwolves',
                  participant1: 'Minnesota Timberwolves',
                  selection1Id: 'Moneyline:Minnesota_Timberwolves',
                  selection2: 'Denver Nuggets',
                  participant2: 'Denver Nuggets',
                  selection2Id: 'Moneyline:Denver_Nuggets',
                  odds: {
                    NoVigApp: { odds1: 175, odds2: -200 }
                  }
                }
              },
              defaultKey: 'a'
            }
          ]
        }),
        queryOddsHistory: async () => ({
          NoVigApp: [
            { odds: -118, start_ts: 1 },
            { odds: -120, start_ts: 2 }
          ]
        }),
        healthStatus: async () => ({ ok: true, screen: { reachable: true } })
      }
    });

    const result = await handlers.sharp_plays({
      book: 'NoVigApp',
      leagues: ['NBA'],
      markets: ['Moneyline'],
      minConsensusBookCount: 1,
      limit: 5,
      maxAgeMs: 60 * 60 * 1000,
      debug: false
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.result, []);
    assert.deepEqual(result.resultMeta.classificationSummary, {
      totalRowsClassified: 2,
      verdictCounts: { Pass: 2 },
      passReasonCounts: {
        consensus_book_count_below_1: 2,
        movement_source_is_target_book: 2
      }
    });
    assert.ok(result.resultMeta.emptyState);
    assert.equal(result.resultMeta.emptyState.reason, 'rows_failed_post_filter');
    assert.equal(result.resultMeta.emptyState.scannedRowCount, 2);
    assert.deepEqual(result.resultMeta.emptyState.failureBreakdown, {
      consensus_book_count_below_1: 2,
      movement_source_is_target_book: 2
    });
    assert.equal(result.resultMeta.emptyState.topNearMisses.length, 2);
    assert.equal(result.resultMeta.emptyState.topNearMisses[0].movementSourceBook, 'NoVigApp');
    assert.equal(typeof result.resultMeta.emptyState.topNearMisses[0].marketBookCount, 'number');
    assert.equal(typeof result.resultMeta.emptyState.topNearMisses[0].supportBookCount, 'number');
    assert.equal(typeof result.resultMeta.emptyState.topNearMisses[0].executionQuality, 'string');
  });

  it('sharp_plays returns no_ranked_rows_scanned when no rows were classified', async () => {
    const { client } = createRankedScreenClientStub({ rankedPayload: { game_data: [] } });
    const handlers = createMcpHandlers({ client });

    const result = await handlers.sharp_plays({
      book: 'NoVigApp',
      leagues: ['NBA'],
      markets: ['Moneyline'],
      minConsensusBookCount: 1,
      limit: 5,
      debug: false
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.result, []);
    assert.deepEqual(result.resultMeta.classificationSummary, {
      totalRowsClassified: 0,
      verdictCounts: {},
      passReasonCounts: {}
    });
    assert.ok(result.resultMeta.emptyState);
    assert.equal(result.resultMeta.emptyState.reason, 'no_ranked_rows_scanned');
    assert.equal(result.resultMeta.emptyState.scannedRowCount, 0);
    assert.deepEqual(result.resultMeta.emptyState.failureBreakdown, {});
    assert.deepEqual(result.resultMeta.emptyState.topNearMisses, []);
  });

  it('sharp_plays fans out across multiple targetBooks and keeps per-book rows', async () => {
    const { client, calls } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });

    const result = await handlers.sharp_plays({
      targetBooks: ['Fliff', 'NoVig'],
      leagues: ['NBA'],
      markets: ['Moneyline'],
      minConsensusBookCount: 1,
      limit: 10,
      debug: false
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.resultMeta.targetBooks, ['Fliff', 'NoVigApp']);
    assert.equal(result.resultMeta.targetBookCount, 2);
    // 2 target book queries + 1 sharp book group query (all sharp books together)
    assert.equal(result.resultMeta.scannedQueryCount, 3);
    assert.equal(calls.queryScreenOddsBestComps.length, 3);
    // First two calls are target book queries, third is the sharp book group query
    assert.deepEqual(calls.queryScreenOddsBestComps[0].books, [
      'Fliff',
      'Circa',
      'Pinnacle',
      'BookMaker',
      'BetOnline',
      'DraftKings'
    ]);
    assert.deepEqual(calls.queryScreenOddsBestComps[1].books, [
      'NoVigApp',
      'Circa',
      'Pinnacle',
      'BookMaker',
      'BetOnline',
      'DraftKings'
    ]);
    assert.ok(calls.queryScreenOddsBestComps[2].books.length >= 5); // sharp book group
    assert.equal(result.result.length, 4);
    assert.equal(result.resultMeta.perTargetBook.Fliff.scanned, 2);
    assert.equal(result.resultMeta.perTargetBook.NoVigApp.scanned, 2);
  });

  it('sharp_plays exposes a UFC shortlist in metadata when UFC rows are scanned', async () => {
    const sharedUfcRow = {
      gameId: 'ufc-game-1',
      game: 'Costa vs Allen',
      participant: 'Costa',
      pick: 'Costa ML',
      odds: 133,
      price: 133,
      currentOdds: 133,
      market: 'Moneyline',
      scanMarket: 'Moneyline',
      start: Math.floor((Date.now() + 86400000) / 1000), // tomorrow as epoch seconds
      league: 'UFC',
      scanLeague: 'UFC',
      targetBook: 'NoVigApp',
      executionBook: 'NoVigApp',
      book: 'NoVigApp',
      lineHistoryUsable: false,
      movementLabel: 'insufficient_history',
      consensusBookCount: 9,
      consensusEdge: 2.5,
      screenScore: 12.7,
      gatePassed: true,
      // Required for extractScreenRows/expandScreenRow to find the price
      selections: {
        ml: {
          selection1: 'Costa',
          participant1: 'Costa',
          selection2: 'Allen',
          participant2: 'Allen',
          odds: {
            NoVigApp: { odds1: 133, odds2: -150 },
            Pinnacle: { odds1: 130, odds2: -145 }
          }
        }
      },
      defaultKey: 'ml'
    };

    const handlers = createMcpHandlers({
      client: {
        querySportsbook: async () => [],
        queryScreenOdds: async () => ({ ok: true, rows: [] }),
        queryScreenOddsBestComps: async () => ({ game_data: [sharedUfcRow] }),
        queryOddsHistory: async () => ({}),
        healthStatus: async () => ({ ok: true, screen: { reachable: true } })
      }
    });

    const result = await handlers.sharp_plays({
      book: 'NoVigApp',
      leagues: ['UFC'],
      markets: ['Moneyline'],
      minConsensusBookCount: 2,
      limit: 5,
      includePasses: true,
      debug: false
    });

    assert.equal(result.ok, true);
    assert.ok(result.resultMeta.ufcShortlist);
    assert.equal(result.resultMeta.ufcShortlist.league, 'UFC');
    assert.equal(result.resultMeta.ufcShortlist.officialCount, 0);
    assert.equal(result.resultMeta.ufcShortlist.leanCount, 0);
    assert.equal(result.resultMeta.ufcShortlist.passCount, 2);
    assert.ok(result.resultMeta.ufcShortlist.bestPasses.length >= 1);
    assert.equal(result.resultMeta.ufcShortlist.bestPasses[0].participant, 'Costa');
  });

  it('health_status returns auth error when auth is invalid', async () => {
    const healthPayload = {
      ok: true,
      endpoints: { screen: 'ok' },
      freshness: {
        screen: {
          rowCount: 2,
          newestAgeMs: 1500,
          oldestAgeMs: 4200,
          staleCount: 0,
          stale: false,
          freshnessFallbackUsed: false,
          timestampSources: { updatedAt: 2 }
        }
      }
    };
    const { client, calls } = createRankedScreenClientStub({ healthPayload });
    const handlers = createMcpHandlers({ client });

    const result = await handlers.health_status();

    // Result depends on whether auth file exists in the test environment
    if (result.ok === false) {
      // No auth file (CI environment) — should return auth error early
      assert.ok(result.auth);
      assert.equal(result.auth.valid, false);
      assert.equal(calls.healthStatus, 0); // Should not call client.healthStatus when auth is invalid
    } else {
      // Auth file exists (local environment) — should call client.healthStatus
      assert.equal(calls.healthStatus, 1);
      assert.equal(result.ok, true);
      assert.ok(result.auth);
      assert.equal(result.auth.valid, true);
      assert.equal(result.result.freshness.screen.newestAgeMs, 1500);
      assert.deepEqual(result.result.freshness.screen.timestampSources, { updatedAt: 2 });
    }
  });

  // NOTE: screen_raw (bestComps) MLB test removed — tool deprecated in v1.6.3.

  it('screen_ranked(Soccer) forwards the league casing as supplied', async () => {
    const calls = [];
    const handlers = createMcpHandlers({
      client: {
        queryScreenOddsBestComps: async (filters) => {
          calls.push(filters);
          return { game_data: [] };
        },
        queryOddsHistory: async () => ({})
      }
    });

    const result = await handlers.screen_ranked({
      league: 'Soccer',
      market: 'Moneyline',
      books: ['NoVigApp'],
      includeAll: true
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].league, 'Soccer');
    assert.equal(calls[0].market, 'Moneyline');
    assert.equal(result.ok, true);
  });

  it('recommended_bets includes gameId in each play row', async () => {
    const { client } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });

    const result = await handlers.recommended_bets({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      limit: 3,
      compact: true
    });

    assert.ok(result.ok);
    for (const league of result.leagues) {
      for (const play of league.plays) {
        assert.ok(play.gameId, `gameId missing in recommended_bets for ${play.selection}`);
      }
    }
  });

  it('quick_screen includes gameId in each candidate row', async () => {
    const { client } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });

    const result = await handlers.quick_screen({
      leagues: ['NBA'],
      markets: ['Moneyline'],
      limit: 3
    });

    assert.ok(result.ok);
    for (const leagueResult of result.results) {
      for (const candidate of leagueResult.candidates || []) {
        assert.ok(candidate.gameId, `gameId missing in quick_screen for ${candidate.selection}`);
      }
    }
  });

  it('quick_screen materializes final verdicts when validation is skipped', async () => {
    const { client } = createRankedScreenClientStub();
    const originalScreenQuery = client.queryScreenOddsBestComps;
    client.queryScreenOddsBestComps = async (...args) => {
      const payload = await originalScreenQuery(...args);
      return {
        ...payload,
        game_data: (payload.game_data || []).map((row) => ({ ...row, league: 'MLB' }))
      };
    };
    client.oddsHistoryBudgetRemaining = () => 0;
    const handlers = createMcpHandlers({ client });
    handlers.sharp_plays = async () => ({
      ok: true,
      result: [
        {
          gameId: 'unvalidated-bet-game',
          game: 'Stub Away vs Stub Home',
          selection: 'Stub Home',
          participant: 'Stub Home',
          pick: 'Stub Home',
          odds: -110,
          confidenceTier: 'TIER 1',
          displayTier: 'BET',
          kaiCall: 'BET',
          movementDisposition: 'supportive_clean',
          screenScore: 10
        }
      ]
    });

    const result = await handlers.quick_screen({
      books: ['NoVigApp'],
      leagues: ['MLB'],
      markets: ['Moneyline'],
      onlyBets: true,
      minFinalTier: 'TIER 2',
      validate: false,
      includeResearch: false,
      cardWindow: 'all'
    });

    const candidates = result.results.flatMap((entry) => entry.candidates || []);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].finalVerdict, 'BET');
    assert.equal(candidates[0].finalConfidenceTier, 'TIER 1');
    assert.equal(candidates[0].validationSkipped, true);
    assert.ok(!candidates[0].finalWarnings?.includes('validation-failed'));
  });

  it('quick_screen fans out across multiple leagues (concurrency)', async () => {
    const { client } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });

    // Three leagues, each using the same stub payload — should complete
    // successfully and return results for all requested leagues
    const result = await handlers.quick_screen({
      books: ['NoVigApp'],
      leagues: ['NBA', 'MLB', 'WNBA'],
      markets: ['Moneyline'],
      includeResearch: false,
      cardWindow: 'all'
    });

    assert.equal(result.ok, true);
    assert.ok(result.activeSlate.length <= 3, 'should have up to 3 leagues in active slate');
    // Each league should have at least one entry (or error)
    const leagueNames = result.results.map((r) => r.league);
    assert.ok(leagueNames.includes('NBA') || leagueNames.includes('MLB') || leagueNames.includes('WNBA'));
  });

  it('quick_screen includeProps merges exact MLB player and pitcher markets', async () => {
    const { client } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });
    const requestedMarkets = [];
    handlers.runLeagueScreen = async () => ({ ok: true, result: [{ gameId: 'stub-mlb-game' }] });
    handlers.sharp_plays = async (args) => {
      requestedMarkets.push(args.market);
      return { ok: true, result: [] };
    };

    const result = await handlers.quick_screen({
      books: ['NoVigApp'],
      leagues: ['MLB'],
      markets: ['Moneyline'],
      includeProps: true,
      includeResearch: false,
      cardWindow: 'all'
    });

    assert.ok(result.ok);
    assert.ok(
      requestedMarkets.includes('Player Triples'),
      `expected Player Triples in fanned-out markets, got: ${JSON.stringify(requestedMarkets)}`
    );
    assert.ok(
      requestedMarkets.includes('Pitcher Outs Recorded'),
      `expected Pitcher Outs Recorded in fanned-out markets, got: ${JSON.stringify(requestedMarkets)}`
    );
  });

  it('quick_screen includeProps merges player prop markets for NBA', async () => {
    const { client } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });

    // Spy on sharp_plays to capture the resolved (league, market) pairs
    // quick_screen fans out to.
    const requestedMarkets = [];
    handlers.sharp_plays = async (args) => {
      requestedMarkets.push(args.market);
      return { ok: true, result: [] };
    };

    const result = await handlers.quick_screen({
      books: ['NoVigApp'],
      leagues: ['NBA'],
      markets: ['Moneyline'],
      includeProps: true,
      includeResearch: false,
      cardWindow: 'all'
    });

    assert.ok(result.ok);
    assert.ok(
      requestedMarkets.includes('Player Points'),
      `expected Player Points in fanned-out markets, got: ${JSON.stringify(requestedMarkets)}`
    );
  });

  it('validate_play returns a structured response with required fields', async () => {
    const { client } = createRankedScreenClientStub();
    const handlers = createMcpHandlers({ client });
    handlers.player_context = async () => ({ riskFlag: 'low', tweets: [], news: [] });

    const result = await handlers.validate_play({
      league: 'NBA',
      gameId: 'stub-game-1',
      selection: 'Stub Home'
    });

    assert.equal(result.ok, true);
    // Core verdict fields
    assert.equal(typeof result.verdict, 'string');
    assert.ok(['BET', 'CONSIDER', 'PASS'].includes(result.verdict));
    assert.equal(typeof result.lookupStatus, 'string');
    assert.ok(['resolved', 'lookup_failed', 'stale_snapshot', 'gameId_changed'].includes(result.lookupStatus));
    assert.equal(typeof result.reasonType, 'string');
    assert.ok(Array.isArray(result.reasons));
    // Verdict summary
    assert.ok(result.verdictSummary && typeof result.verdictSummary === 'object');
    assert.equal(typeof result.verdictSummary.actionableSummary, 'string');
    assert.equal(typeof result.verdictSummary.movementDisposition, 'string');
    assert.equal(typeof result.verdictSummary.executionQuality, 'string');
    // Drift fields
    assert.equal(typeof result.consensusDrift, 'boolean');
    // Play object shape (when found)
    if (result.play) {
      assert.equal(typeof result.play.playId, 'string');
      assert.equal(typeof result.play.selectionKey, 'string');
      assert.equal(typeof result.play.gameId, 'string');
      assert.equal(typeof result.play.executionQuality, 'string');
      assert.equal(typeof result.play.consensusBookCount, 'number');
      assert.equal(typeof result.play.freshnessSource, 'string');
    }
  });
});

describe('validated candidate concurrency helpers', () => {
  it('mapWithConcurrency preserves input order while limiting in-flight workers', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      async (value) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return value * 10;
      },
      { concurrency: 2 }
    );

    assert.deepEqual(result, [10, 20, 30, 40, 50]);
    assert.equal(maxInFlight <= 2, true);
  });

  it('validated candidates use hybrid handling when only some rows fail validation', async () => {
    const handlers = createMcpHandlers({
      client: {
        querySportsbook: async () => [
          {
            id: 'ok-row',
            league: 'NBA',
            market: 'Moneyline',
            book: 'Fliff',
            participant: 'A',
            selection: 'A',
            gameId: 'game-1',
            selectionId: 'Moneyline:A'
          },
          {
            id: 'bad-row',
            league: 'NBA',
            market: 'Moneyline',
            book: 'Fliff',
            participant: 'B',
            selection: 'B',
            gameId: 'game-2',
            selectionId: 'Moneyline:B'
          }
        ],
        queryOddsHistory: async ({ gameId }) => {
          if (gameId === 'game-2') {
            throw new Error('history failed');
          }
          return {
            Fliff: [
              { odds: -110, start_ts: 1 },
              { odds: -120, start_ts: 2 }
            ]
          };
        }
      }
    });

    const result = await handlers.ev_candidates({
      sportsbooks: ['Fliff'],
      leagues: ['NBA'],
      debug: false,
      validated: true
    });
    assert.equal(result.ok, true);
    assert.equal(result.resultMeta.candidateCount, 2);
    assert.equal(result.resultMeta.validatedCount, 1);
    assert.equal(result.resultMeta.failedValidationCount, 1);
    assert.equal(result.resultMeta.partialValidation, true);
    assert.ok(Array.isArray(result.warnings));
    assert.match(result.warnings[0], /1 candidate validation lookup/);
  });

  it('validated candidates reuse identical odds-history lookups within a run', async () => {
    let historyCalls = 0;
    // Use a unique gameId/selectionId that no other test in this file uses,
    // so the cross-call LRU cache (process-shared since v2.1.9) doesn't
    // serve a previous test's result. The dedup contract this test
    // exercises (multiple rows with the same gameId+selectionId collapse
    // to a single network call) is what we still want to verify.
    const uniqueGameId = `game-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const uniqueSelectionId = `Moneyline:dedup-${Math.random().toString(36).slice(2)}`;
    const handlers = createMcpHandlers({
      client: {
        querySportsbook: async () => [
          {
            id: 'row-1',
            league: 'NBA',
            market: 'Moneyline',
            book: 'Fliff',
            participant: 'A',
            selection: 'A',
            gameId: uniqueGameId,
            selectionId: uniqueSelectionId,
            odds: -110
          },
          {
            id: 'row-2',
            league: 'NBA',
            market: 'Moneyline',
            book: 'Fliff',
            participant: 'A',
            selection: 'A',
            gameId: uniqueGameId,
            selectionId: uniqueSelectionId,
            odds: -110
          }
        ],
        queryOddsHistory: async () => {
          historyCalls += 1;
          return {
            Fliff: [
              { odds: -110, start_ts: 1 },
              { odds: -120, start_ts: 2 }
            ]
          };
        }
      }
    });

    const result = await handlers.ev_candidates({
      sportsbooks: ['Fliff'],
      leagues: ['NBA'],
      debug: false,
      validated: true
    });

    assert.equal(result.ok, true);
    assert.equal(historyCalls, 1);
  });

  it('returns RATE_LIMITED JSON-RPC success without invoking the handler', async () => {
    let handlerInvocations = 0;
    const server = createMcpServer({
      handlers: {
        screen_ranked: async () => {
          handlerInvocations += 1;
          return { ok: true };
        }
      },
      toolDefinitions: [
        {
          name: 'screen_ranked',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }
      ],
      rateLimiter: new RateLimiter({ maxCalls: 1, windowMs: 60_000, now: () => 1_000_000 })
    });

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
    });

    const first = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'screen_ranked', arguments: {} }
    });
    assert.equal(first.result.isError, undefined);
    assert.equal(first.result.structuredContent.ok, true);
    assert.equal(handlerInvocations, 1);

    const second = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'screen_ranked', arguments: {} }
    });
    // JSON-RPC success frame (no protocol-level error), tool-level failure
    assert.equal(second.error, undefined);
    assert.equal(second.id, 3);
    assert.equal(second.result.isError, true);
    assert.equal(second.result.structuredContent.ok, false);
    assert.equal(second.result.structuredContent.error.code, 'RATE_LIMITED');
    assert.match(second.result.structuredContent.error.message, /Rate limit exceeded/);
    // The rejected call must not reach the handler
    assert.equal(handlerInvocations, 1);
  });

  it('default rate limiter honors PROPPROFESSOR_RATE_LIMIT and PROPPROFESSOR_RATE_WINDOW_MS', async () => {
    const prevLimit = process.env.PROPPROFESSOR_RATE_LIMIT;
    const prevWindow = process.env.PROPPROFESSOR_RATE_WINDOW_MS;
    process.env.PROPPROFESSOR_RATE_LIMIT = '1';
    process.env.PROPPROFESSOR_RATE_WINDOW_MS = '2000';
    try {
      let handlerInvocations = 0;
      const server = createMcpServer({
        handlers: {
          screen_ranked: async () => {
            handlerInvocations += 1;
            return { ok: true };
          }
        },
        toolDefinitions: [
          {
            name: 'screen_ranked',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }
          }
        ]
      });

      await server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
      });

      await server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'screen_ranked', arguments: {} }
      });
      assert.equal(handlerInvocations, 1);

      const second = await server.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'screen_ranked', arguments: {} }
      });
      assert.equal(second.result.isError, true);
      assert.equal(second.result.structuredContent.error.code, 'RATE_LIMITED');
      // windowMs env is honored: the wait message renders the 2s window, not the hardcoded 60s
      assert.match(second.result.structuredContent.error.message, /in the last 2s/);
      assert.equal(handlerInvocations, 1);
    } finally {
      if (prevLimit === undefined) delete process.env.PROPPROFESSOR_RATE_LIMIT;
      else process.env.PROPPROFESSOR_RATE_LIMIT = prevLimit;
      if (prevWindow === undefined) delete process.env.PROPPROFESSOR_RATE_WINDOW_MS;
      else process.env.PROPPROFESSOR_RATE_WINDOW_MS = prevWindow;
    }
  });

  it('bin entrypoints include node shebangs', () => {
    const serverEntry = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'propprofessor-mcp-server.js'), 'utf8');
    const queryEntry = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'query-propprofessor.js'), 'utf8');
    assert.match(serverEntry, /^#!\/usr\/bin\/env node/);
    assert.match(queryEntry, /^#!\/usr\/bin\/env node/);
  });
});
