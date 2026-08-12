#!/usr/bin/env node
'use strict';

/**
 * Generate an OpenAPI 3.0 specification from the PropProfessor MCP tool definitions.
 *
 * Usage: node scripts/generate-openapi-spec.js > docs/openapi.json
 */

const { buildToolDefinitions } = require('../lib/propprofessor-tool-definitions');

// Response schemas for each tool — maps tool name to response schema
const RESPONSE_SCHEMAS = {
  ev_candidates: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      count: { type: 'integer' },
      result: { type: 'array', items: { type: 'object' } },
      notes: { type: 'object', properties: { workflow: { type: 'string' }, minValueBehavior: { type: 'string' } } },
      resultMeta: { type: 'object' }
    }
  },
  screen_ranked: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      count: { type: 'integer' },
      result: { type: 'array', items: { type: 'object' } },
      freshness: { type: 'object' },
      resultMeta: { type: 'object' }
    }
  },
  sharp_consensus: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      count: { type: 'integer' },
      summary: { type: 'object' },
      result: { type: 'array', items: { type: 'object' } },
      resultMeta: { type: 'object' }
    }
  },
  all_slates: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      totalPlays: { type: 'integer' },
      leaguesQueried: { type: 'array', items: { type: 'string' } },
      leagueMeta: { type: 'object' },
      consolidated: { type: 'array', items: { type: 'object' } }
    }
  },
  ufc_card: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      league: { type: 'string' },
      officialPlays: { type: 'array', items: { type: 'object' } },
      bestLooks: { type: 'array', items: { type: 'object' } },
      count: { type: 'integer' },
      resultMeta: { type: 'object' }
    }
  },
  staking_plan: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      bankroll: { type: 'number' },
      totalStake: { type: 'number' },
      playCount: { type: 'integer' },
      stakes: { type: 'array', items: { type: 'object' } },
      warnings: { type: 'array', items: { type: 'string' } }
    }
  },
  player_context: {
    type: 'object',
    properties: {
      player: { type: 'string' },
      riskFlag: { type: 'string', enum: ['low', 'medium', 'high', 'unknown'] },
      summary: { type: 'string' },
      tweets: { type: 'array', items: { type: 'object' } },
      news: { type: 'array', items: { type: 'object' } }
    }
  },
  get_play_details: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      count: { type: 'integer' },
      result: { type: 'array', items: { type: 'object' } },
      resultMeta: { type: 'object' }
    }
  },
  health_status: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      auth: {
        type: 'object',
        properties: { valid: { type: 'boolean' }, file: { type: 'string' }, message: { type: 'string' } }
      },
      backend: { type: 'object' }
    }
  },
  league_presets: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      result: { type: 'array', items: { type: 'object' } }
    }
  },
  find_best_price: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      selection: { type: 'string' },
      books: { type: 'array', items: { type: 'object' } }
    }
  },
  clear_score_timeline: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      message: { type: 'string', description: 'Confirmation message' }
    },
    required: ['ok', 'message']
  },
  get_started: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      steps: { type: 'array', items: { type: 'string' } },
      tools_to_use: { type: 'array', items: { type: 'string' } },
      avoid: { type: 'array', items: { type: 'string' } }
    }
  }
};

// Error response schema (used by all tools)
const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', enum: [false] },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        category: { type: 'string', enum: ['auth', 'transport', 'backend', 'validation', 'internal'] },
        status: { type: 'integer' },
        recovery: { type: 'string' }
      }
    }
  }
};

function generateOpenApiSpec() {
  const tools = buildToolDefinitions();

  const paths = {};

  for (const tool of tools) {
    const toolName = tool.name;
    const paramProperties = tool.inputSchema?.properties || {};
    const requiredParams = tool.inputSchema?.required || [];

    paths[`/tools/${toolName}`] = {
      post: {
        summary: tool.description,
        operationId: toolName,
        tags: ['PropProfessor MCP Tools'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  ...paramProperties,
                  verbosity: {
                    type: 'string',
                    enum: ['minimal', 'standard', 'full'],
                    description: 'Output detail level. Default: standard.'
                  }
                },
                required: requiredParams.length ? requiredParams : undefined,
                additionalProperties: false
              }
            }
          }
        },
        responses: {
          200: {
            description: 'Successful tool execution',
            content: {
              'application/json': {
                schema: RESPONSE_SCHEMAS[toolName] || {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    result: { type: 'object' }
                  }
                }
              }
            }
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: ERROR_RESPONSE_SCHEMA } }
          },
          401: {
            description: 'Auth error',
            content: { 'application/json': { schema: ERROR_RESPONSE_SCHEMA } }
          },
          503: {
            description: 'Backend error',
            content: { 'application/json': { schema: ERROR_RESPONSE_SCHEMA } }
          }
        }
      }
    };
  }

  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'PropProfessor MCP API',
      version: require('../package.json').version,
      description: `Lean, fast odds analysis engine for AI agents. Screens 36+ sportsbooks across NBA, MLB, NHL, NFL, WNBA, UFC, Tennis, Soccer — ranks plays by sharp movement, consensus edge, and steam detection.\n\nSee the README for setup instructions and tool guides by user type.`,
      contact: {
        name: 'James Drake',
        url: 'https://github.com/jbdrak/propprofessor-mcp'
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT'
      }
    },
    servers: [
      {
        url: 'http://localhost:3100',
        description: 'Local MCP server (stdio transport — use an MCP client to connect)'
      }
    ],
    tags: [
      {
        name: 'PropProfessor MCP Tools',
        description: 'Sports betting odds analysis tools'
      }
    ],
    paths,
    components: {
      schemas: {
        Error: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            category: { type: 'string' },
            recovery: { type: 'string' }
          }
        }
      }
    }
  };

  return spec;
}

const spec = generateOpenApiSpec();
process.stdout.write(JSON.stringify(spec, null, 2));
