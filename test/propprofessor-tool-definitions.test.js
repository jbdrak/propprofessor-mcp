'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildToolDefinitions, LITE_MODE_TOOLS, TOOL_CATEGORIES } = require('../lib/propprofessor-tool-definitions');

describe('propprofessor-tool-definitions', () => {
  describe('default (full) mode', () => {
    it('returns all 31 tools by default', () => {
      const tools = buildToolDefinitions();
      assert.equal(tools.length, 31);
    });

    it('returns all 31 tools when mode is explicitly "full"', () => {
      const tools = buildToolDefinitions({ mode: 'full' });
      assert.equal(tools.length, 31);
      for (const tool of tools) {
        assert.equal(typeof tool.name, 'string', `${tool.name}: name missing`);
        assert.equal(typeof tool.description, 'string', `${tool.name}: description missing`);
        assert.equal(typeof tool.category, 'string', `${tool.name}: category missing`);
        assert.ok(tool.inputSchema, `${tool.name}: inputSchema missing`);
        assert.equal(tool.inputSchema.type, 'object', `${tool.name}: schema must be object`);
      }
    });
  });

  describe('lite mode', () => {
    it('returns 15 lite tools when mode is "lite"', () => {
      const tools = buildToolDefinitions({ mode: 'lite' });
      assert.equal(tools.length, 15);
    });

    it('every lite tool is in LITE_MODE_TOOLS', () => {
      const tools = buildToolDefinitions({ mode: 'lite' });
      for (const tool of tools) {
        assert.ok(LITE_MODE_TOOLS.has(tool.name), `${tool.name} should be in LITE_MODE_TOOLS`);
      }
    });

    it('excludes admin, meta, and most discovery tools', () => {
      const tools = buildToolDefinitions({ mode: 'lite' });
      const names = new Set(tools.map((t) => t.name));
      // Tools that should NOT be in lite mode (advanced / niche):
      assert.ok(!names.has('all_slates'), 'all_slates should be full-only');
      assert.ok(!names.has('ev_candidates'), 'ev_candidates should be full-only');
      assert.ok(!names.has('fantasy_optimizer'), 'fantasy_optimizer should be full-only');
      assert.ok(!names.has('screen_ranked'), 'screen_ranked should be full-only (quick_screen covers it)');
      assert.ok(!names.has('staking_plan'), 'staking_plan should be full-only');
      assert.ok(!names.has('ufc_card'), 'ufc_card should be full-only');
      assert.ok(!names.has('manage_hidden_bets'), 'admin tools should be full-only');
      assert.ok(!names.has('clear_score_timeline'), 'admin tools should be full-only');
      // health_status IS in lite mode — zero-risk health check for all agents
      assert.ok(names.has('health_status'), 'health_status should be in lite mode');
      assert.ok(!names.has('league_presets'), 'meta tools should be full-only');
      assert.ok(!names.has('get_started'), 'meta tools should be full-only');
    });

    it('includes the casual/intermediate workflow essentials', () => {
      const names = new Set(buildToolDefinitions({ mode: 'lite' }).map((t) => t.name));
      // Discover → validate → track
      assert.ok(names.has('ask'), 'ask (router) is essential');
      assert.ok(names.has('quick_screen'), 'quick_screen bundles screen+research');
      assert.ok(names.has('validate_play'), 'validate_play is the pre-bet check');
      assert.ok(names.has('find_best_price'), 'find_best_price is line-shopping');
      assert.ok(names.has('log_pick'), 'log_pick is the tracking entry');
      assert.ok(names.has('resolve_pick'), 'resolve_pick settles picks');
      assert.ok(names.has('get_pick_history'), 'history review is essential');
      assert.ok(names.has('player_context'), 'player_context for injury check');
      assert.ok(names.has('get_play_details'), 'get_play_details for raw detail');
    });
  });

  describe('category field', () => {
    it('every tool is in TOOL_CATEGORIES (no orphan tools)', () => {
      const tools = buildToolDefinitions();
      for (const tool of tools) {
        assert.ok(TOOL_CATEGORIES[tool.name], `${tool.name} missing from TOOL_CATEGORIES`);
      }
    });

    it('every TOOL_CATEGORIES entry corresponds to a real tool (no orphans in map)', () => {
      const toolNames = new Set(buildToolDefinitions().map((t) => t.name));
      for (const name of Object.keys(TOOL_CATEGORIES)) {
        assert.ok(toolNames.has(name), `TOOL_CATEGORIES has ${name} but no such tool exists`);
      }
    });

    it('only uses the 7 known categories', () => {
      const validCategories = new Set([
        'discovery',
        'screen',
        'alerts',
        'drill_down',
        'research',
        'tracking',
        'admin',
        'meta'
      ]);
      for (const [name, cat] of Object.entries(TOOL_CATEGORIES)) {
        assert.ok(validCategories.has(cat), `${name} has unknown category: ${cat}`);
      }
    });

    it('category distribution matches the documented counts', () => {
      // Documented counts in the README. Locking these in as a test means a
      // future tool addition forces a conscious decision about whether to
      // bump the count or leave it stale.
      const expected = {
        discovery: 6,
        screen: 6,
        alerts: 1,
        drill_down: 3,
        research: 4,
        tracking: 5,
        admin: 2,
        meta: 4
      };
      const actual = {};
      for (const cat of Object.values(TOOL_CATEGORIES)) {
        actual[cat] = (actual[cat] || 0) + 1;
      }
      assert.deepStrictEqual(actual, expected);
    });
  });

  describe('validateTop defaults to 0 on quick_screen', () => {
    it('quick_screen validateTop default is 0', () => {
      const tools = buildToolDefinitions();
      const qs = tools.find((t) => t.name === 'quick_screen');
      assert.ok(qs, 'quick_screen tool definition exists');
      assert.strictEqual(
        qs.inputSchema.properties.validateTop.default,
        0,
        'quick_screen validateTop should default to 0'
      );
    });
  });

  describe('validate defaults to true on quick_screen', () => {
    it('quick_screen validate default is true', () => {
      const tools = buildToolDefinitions();
      const qs = tools.find((t) => t.name === 'quick_screen');
      assert.ok(qs, 'quick_screen tool definition exists');
      assert.strictEqual(
        qs.inputSchema.properties.validate.default,
        true,
        'quick_screen validate should default to true'
      );
    });
  });

  describe('tools are sorted alphabetically by name', () => {
    it('returns tools in alphabetical order', () => {
      const tools = buildToolDefinitions();
      const names = tools.map((t) => t.name);
      const sorted = [...names].sort();
      assert.deepStrictEqual(names, sorted);
    });

    it('sorted in lite mode too', () => {
      const tools = buildToolDefinitions({ mode: 'lite' });
      const names = tools.map((t) => t.name);
      const sorted = [...names].sort();
      assert.deepStrictEqual(names, sorted);
    });
  });
});
