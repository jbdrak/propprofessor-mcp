'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildToolDefinitions } = require('../lib/tool-definitions/index');
const { createMcpHandlers } = require('../scripts/propprofessor-mcp-server');

describe('get_started tool definition', () => {
  const definitions = buildToolDefinitions();
  const tool = definitions.find((t) => t.name === 'get_started');

  it('exists in tool definitions', () => {
    assert.ok(tool, 'get_started tool should exist in definitions');
  });

  it('description mentions workflow', () => {
    assert.ok(tool.description.toLowerCase().includes('workflow'), 'description should mention workflow');
  });

  it('user_type param has correct enum values', () => {
    const userType = tool.inputSchema.properties.user_type;
    assert.ok(userType, 'user_type property should exist');
    assert.deepEqual(userType.enum, ['casual', 'intermediate', 'sharp']);
  });

  it('user_type is required', () => {
    assert.ok(tool.inputSchema.required.includes('user_type'), 'user_type should be required');
  });

  it('has additionalProperties set to false', () => {
    assert.equal(tool.inputSchema.additionalProperties, false);
  });
});

describe('get_started handler', () => {
  const handlers = createMcpHandlers();

  it('returns prompt for casual user type', async () => {
    const result = await handlers.get_started({ user_type: 'casual' });
    assert.ok(result.summary);
    assert.ok(Array.isArray(result.prompt));
    assert.ok(result.prompt.length > 0);
    assert.ok(Array.isArray(result.key_tools));
    assert.ok(result.key_tools.includes('quick_screen'));
    assert.ok(typeof result.pitfall === 'string');
  });

  it('returns prompt for sharp user type', async () => {
    const result = await handlers.get_started({ user_type: 'sharp' });
    assert.ok(result.summary);
    assert.ok(Array.isArray(result.prompt));
    assert.ok(result.key_tools.includes('quick_screen'));
    assert.ok(result.key_tools.includes('sharp_consensus'));
    assert.ok(result.key_tools.includes('staking_plan'));
    assert.ok(typeof result.pitfall === 'string');
  });

  it('defaults to intermediate when user_type is missing', async () => {
    const result = await handlers.get_started({});
    assert.ok(result.summary.includes('edge and tier'));
  });

  it('falls back to intermediate for unknown user type', async () => {
    const result = await handlers.get_started({ user_type: 'unknown' });
    assert.ok(result.summary.includes('edge and tier'));
  });

  it('each workflow has all required fields', async () => {
    for (const userType of ['casual', 'intermediate', 'sharp']) {
      const result = await handlers.get_started({ user_type: userType });
      assert.ok(typeof result.summary === 'string', `${userType} should have summary string`);
      assert.ok(Array.isArray(result.prompt), `${userType} should have prompt array`);
      assert.ok(result.prompt.length >= 2, `${userType} should have at least 2 steps`);
      assert.ok(Array.isArray(result.key_tools), `${userType} should have key_tools array`);
      assert.ok(result.key_tools.length >= 1, `${userType} should recommend at least 1 tool`);
      assert.ok(typeof result.pitfall === 'string', `${userType} should have pitfall string`);
    }
  });

  it('appends a today_briefing field (live or graceful error)', async () => {
    const result = await handlers.get_started({ user_type: 'intermediate' });
    assert.ok('today_briefing' in result, 'get_started should attach a today_briefing block');
    assert.ok(
      result.today_briefing && typeof result.today_briefing === 'object',
      'today_briefing should always be an object'
    );
  });
});
