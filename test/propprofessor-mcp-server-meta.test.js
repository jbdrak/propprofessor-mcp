'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMcpServer } = require('../scripts/propprofessor-mcp-server');
const { buildToolDefinitions } = require('../lib/tool-definitions/index');

describe('MCP server — tools/list _meta block', () => {
  it('includes _meta with mode, toolCount, liteToolCount, fullToolCount', async () => {
    const server = createMcpServer();
    // initialize first so the server reports ready
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    assert.ok(response.result._meta, '_meta block should be present');
    assert.equal(response.result._meta.mode, 'lite');
    assert.equal(response.result._meta.toolCount, 15);
    assert.equal(response.result._meta.liteToolCount, 15);
    assert.equal(response.result._meta.fullToolCount, 31);
  });

  it('_meta.mode reflects the ACTUAL tool list length when toolDefinitions are injected', async () => {
    // Override the tool surface directly (test injection). The _meta.mode
    // should derive from the actual list, not from the module-level
    // PROPPROFESSOR_MCP_MODE env var — otherwise the _meta would lie.
    const liteToolDefinitions = buildToolDefinitions({ mode: 'lite' });
    const server = createMcpServer({
      handlers: {
        ask: async () => ({ ok: true })
      },
      toolDefinitions: liteToolDefinitions
    });
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    assert.equal(response.result._meta.mode, 'lite');
    assert.equal(response.result._meta.toolCount, 15);
    // fullToolCount is the catalog total (31), not the served count (15)
    assert.equal(response.result._meta.fullToolCount, 31);
    assert.equal(response.result.tools.length, 15);
  });

  it('_meta.toolCount matches the tools array length', async () => {
    const server = createMcpServer();
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    assert.equal(response.result._meta.toolCount, response.result.tools.length);
  });
});

describe('MCP server — tool definitions contract', () => {
  it('every served tool has a category field', async () => {
    const server = createMcpServer();
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    for (const tool of response.result.tools) {
      assert.ok(tool.category, `${tool.name} should have a category field`);
    }
  });

  it('every served tool has a name, description, and inputSchema', async () => {
    const server = createMcpServer();
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    for (const tool of response.result.tools) {
      assert.equal(typeof tool.name, 'string', `${tool.name}: name`);
      assert.ok(tool.description && tool.description.length > 20, `${tool.name}: description must be substantive`);
      assert.ok(tool.inputSchema, `${tool.name}: inputSchema`);
    }
  });
});
