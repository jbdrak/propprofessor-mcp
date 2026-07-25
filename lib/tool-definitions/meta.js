'use strict';

function buildMetaTools() {
  return [
    {
      name: 'ask',
      description:
        'ROUTER — parse a natural language betting query and return parsed components plus a suggested tool and args. Pure parser — no data fetched. Call this when you dont know which tool to use.',
      inputSchema: {
        type: 'object',
        usage_example: 'Call with query="best plays on Fliff tonight".',
        properties: {
          query: {
            type: 'string',
            description:
              'Natural language betting query, e.g. "best plays on Fliff today", "Tatum over 29.5 points", "what should I bet on Novig tonight". Full sentence or shorthand both fine.'
          }
        },
        required: ['query'],
        additionalProperties: false
      }
    },
    {
      name: 'get_market_registry',
      description:
        'REGISTRY — discover available markets for a sport on a specific book. Call before quick_screen to know which markets are available for your league+book combo.',
      inputSchema: {
        type: 'object',
        usage_example: 'Call with sport="Soccer".',
        properties: {
          sport: { type: 'string', description: 'Sport name (e.g. Soccer, NBA, Tennis)' },
          book: {
            type: 'string',
            description: 'Book name (e.g. NoVigApp, DraftKings). If omitted, returns default markets for the sport.'
          }
        },
        required: ['sport'],
        additionalProperties: false
      }
    },
    {
      name: 'get_started',
      description:
        'Get the recommended workflow based on use case (casual/intermediate/sharp). Call first to understand which tools to use.',
      inputSchema: {
        type: 'object',
        usage_example: 'Call with user_type="casual".',
        properties: {
          user_type: {
            type: 'string',
            enum: ['casual', 'intermediate', 'sharp'],
            description:
              'casual: just wants top picks with plain English. intermediate: understands edge/tier, wants guidance. sharp: wants full movement data and control.'
          }
        },
        required: ['user_type'],
        additionalProperties: false
      }
    },
    {
      name: 'league_presets',
      description:
        'Show current sport-specific ranking presets: sharp books per league, default market bundles, and preferred execution book.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false, usage_example: 'Call with no args.' }
    },
    {
      name: 'health_status',
      description:
        'HEALTH CHECK — zero-risk, no backend calls. Check auth freshness and endpoint connectivity. Call first to verify server is responsive before making data calls.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false, usage_example: 'Call with no args.' }
    },
    {
      name: 'fantasy_optimizer',
      description:
        'Query the Fantasy Optimizer for DFS-style player picks across fantasy apps (PrizePicks, Underdog, etc.). Returns projected values, odds, and risk metrics. NOTE: tier/kaiCall/edge/screenScore are signal-quality ratings (what sharp books are doing), NOT win-probability predictions.',
      inputSchema: {
        type: 'object',
        usage_example: 'Call with fantasyApps=["PrizePicks","Underdog"], leagues=["NBA"].',
        properties: {
          fantasyApps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Fantasy apps to query, e.g., ["PrizePicks", "Underdog", "DraftKings6"].'
          },
          leagues: {
            type: 'array',
            items: { type: 'string' },
            description:
              'League filter, e.g., ["NBA", "MLB"]. Defaults to NBA, MLB, NFL, NHL, WNBA, NCAAB, NCAAF, Soccer, Tennis, UFC, NBASL — every league the PropProfessor backend supports.'
          },
          market: { type: 'string', description: 'Market filter, e.g., "Fantasy Points".' },
          sportsbooks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Sportsbooks to compare (fallback for fantasy apps without odds).'
          },
          minOdds: { type: 'number', description: 'Minimum American odds.' },
          maxOdds: { type: 'number', description: 'Maximum American odds.' },
          minValue: { type: 'number', description: 'Minimum projected value (percentage).' },
          maxValue: { type: 'number', description: 'Maximum projected value (percentage).' },
          minLegEV: { type: 'number', description: 'Minimum leg EV threshold.' },
          maxLegEV: { type: 'number', description: 'Maximum leg EV threshold.' },
          minSlipEV: { type: 'number', description: 'Minimum slip EV threshold.' },
          maxSlipEV: { type: 'number', description: 'Maximum slip EV threshold.' },
          hiddenBets: {
            type: 'array',
            items: { type: 'object' },
            description: 'Array of hidden bet objects to exclude from results.'
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'today',
      description:
        'FIRST CALL — daily briefing: top sharp plays, pending picks, and betting stats. Then drill down with quick_screen. NOTE: tier/kaiCall/edge/screenScore are signal-quality ratings (what sharp books are doing), NOT win-probability predictions.',
      inputSchema: {
        type: 'object',
        usage_example: 'Call with leagues=["WNBA","NBA"], book="NoVigApp", limit=100.',
        properties: {
          leagues: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Leagues to include (default all supported leagues: NBA, MLB, NFL, NHL, WNBA, NCAAB, NCAAF, Soccer, Tennis, UFC, NBASL)'
          },
          league: { type: 'string', description: 'Single league shortcut (alternative to leagues)' },
          book: { type: 'string', description: 'Sportsbook to screen (default NoVigApp)' },
          limit: { type: 'number', description: 'Max plays to return from the slate (default 100)' },
          targetTiers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tier filter for the slate (default ["TIER 1", "TIER 2"]). Pass ["TIER 1"] for locks only.'
          },
          statsDays: { type: 'number', description: 'Window for the stats block (default 30)' }
        },
        additionalProperties: false
      }
    }
  ];
}

module.exports = { buildMetaTools };
