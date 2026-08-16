'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildToolDefinitions } = require('../lib/tool-definitions/index');

describe('verbosity parameter in tool definitions', () => {
  const tools = buildToolDefinitions();
  const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));

  const VERBOSITY_ENUM = ['minimal', 'standard', 'full', 'bets'];

  const toolsWithVerbosity = ['screen_ranked', 'all_slates', 'staking_plan', 'ev_candidates', 'ufc_card'];

  it('should have correct enum values for verbosity', () => {
    for (const name of toolsWithVerbosity) {
      const tool = toolMap[name];
      assert.ok(tool, `${name} tool should exist`);
      const v = tool.inputSchema.properties.verbosity;
      assert.ok(v, `${name} should have verbosity param`);
      assert.deepStrictEqual(v.enum, VERBOSITY_ENUM, `${name} verbosity enum mismatch`);
    }
  });

  it('should have verbosity on at least 3 other tools besides recommended_bets', () => {
    const others = toolsWithVerbosity.filter((n) => n !== 'recommended_bets');
    assert.ok(others.length >= 3, `Expected at least 3 other tools, got ${others.length}`);
    for (const name of others) {
      const tool = toolMap[name];
      assert.ok(tool.inputSchema.properties.verbosity, `${name} should have verbosity`);
    }
  });

  it('should have a description on verbosity param', () => {
    for (const name of toolsWithVerbosity) {
      const tool = toolMap[name];
      const v = tool.inputSchema.properties.verbosity;
      assert.ok(v.description, `${name} verbosity should have a description`);
      assert.ok(v.description.includes('minimal'), `${name} description should mention minimal`);
      assert.ok(v.description.includes('standard'), `${name} description should mention standard`);
      assert.ok(v.description.includes('full'), `${name} description should mention full`);
    }
  });

  it('should not add verbosity to tools that do not return bet data', () => {
    const toolsWithoutVerbosity = [
      'health_status',
      'league_presets',
      'get_hidden_bets',
      'clear_hidden_bets',
      'hide_bet',
      'unhide_bet',
      'find_best_price',
      'player_context'
    ];
    for (const name of toolsWithoutVerbosity) {
      const tool = toolMap[name];
      if (tool) {
        assert.ok(!tool.inputSchema.properties.verbosity, `${name} should NOT have verbosity param`);
      }
    }
  });
});
