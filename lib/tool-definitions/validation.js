'use strict';

const { DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS } = require('../propprofessor-mcp-ranked-screen');
const { VERBOSITY_PARAM } = require('./screen');

/** @returns {import('./types').ToolDefinition[]} */
function buildValidationTools() {
  return [
    {
      name: 'ev_candidates',
      description:
        'Query the +EV endpoint and return candidate plays for enabled books. Secondary discovery tool. NOTE: tier/kaiCall/edge/screenScore are signal-quality ratings (what sharp books are doing), NOT win-probability predictions.',
      inputSchema: {
        type: 'object',
        usage_example: 'Call with leagues=["NBA"], validated=true.',
        properties: {
          sportsbooks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional target books such as Fliff, NoVigApp, FanDuel, or DraftKings'
          },
          leagues: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Required league filter, e.g. NBA, MLB, NHL, Tennis, UFC, Soccer. Omitting this will cause a backend 400 error.'
          },
          marketTypes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional market-type filters such as Main Lines or Player Props'
          },
          periodTypes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional period-type filters such as Full Game or Single Period'
          },
          minValue: {
            type: 'number',
            description:
              'Minimum EV/value threshold. Optional here because the frontend Positive EV screen may already enforce this.'
          },
          maxValue: { type: 'number', description: 'Maximum EV/value threshold' },
          minOdds: { type: 'number', description: 'Minimum American odds' },
          maxOdds: { type: 'number', description: 'Maximum American odds' },
          minHoursAway: { type: 'number', description: 'Minimum hours until start' },
          maxHoursAway: { type: 'number', description: 'Maximum hours until start' },
          minLiquidity: { type: 'number', description: 'Minimum liquidity filter' },
          maxLiquidity: { type: 'number', description: 'Maximum liquidity filter' },
          showBreakOnly: { type: 'boolean' },
          showTimeoutOnly: { type: 'boolean' },
          showPeriodEndOnly: { type: 'boolean' },
          timeAvailable: { type: 'number' },
          userState: { type: 'string', description: 'User state code, default tx' },
          hideNCAAPlayerProps: { type: 'boolean' },
          weightSettings: { type: 'object', description: 'Optional backend weight-settings override object' },
          validated: {
            type: 'boolean',
            description: 'When true, runs sharp-movement and odds-history validation on candidates. Default false.'
          },
          league: {
            type: 'string',
            description: 'Ranking league override when validating a single-sport candidate set'
          },
          market: {
            type: 'string',
            description: 'Ranking market override when validating a single-market candidate set'
          },
          books: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional sharp-book override for validation and odds-history queries'
          },
          limit: { type: 'number', description: 'Max number of validated rows to return' },
          includeAll: { type: 'boolean', description: 'Include rows even when consensus or movement data is missing' },
          maxAgeMs: { type: 'number', description: 'Treat rows older than this many milliseconds as stale' },
          lookbackHours: {
            type: 'number',
            description: `Odds-history lookback window in hours, default ${DEFAULT_ODDS_HISTORY_LOOKBACK_HOURS}`
          },
          debug: {
            type: 'boolean',
            description:
              'Include verbose movement debug payloads such as filtered line history and dropped-point reasons, default false'
          },
          verbosity: VERBOSITY_PARAM
        },
        required: ['leagues'],
        additionalProperties: false
      }
    },
    {
      name: 'get_play_details',
      description:
        'DRILL DOWN — get full details (line history, consensus, movement debug) for specific plays. Use after a screen call when you need the raw data behind a ranked play. NOTE: tier/kaiCall/edge/screenScore are signal-quality ratings (what sharp books are doing), NOT win-probability predictions.',
      inputSchema: {
        type: 'object',
        usage_example: 'Call with league="NBA", gameIds=["id1","id2"].',
        properties: {
          league: {
            type: 'string',
            description: 'League such as NBA, Tennis, MLB. Required.'
          },
          gameIds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Game IDs to fetch full details for. These are the gameId values from screen rows.'
          },
          market: {
            type: 'string',
            description: 'Market type, default Moneyline'
          },
          books: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional book filter'
          },
          book: {
            type: 'string',
            description:
              'Convenience single-book alias — coerced into books:[book] by the handler. Accepts "NoVigApp" etc. Equivalent to passing books:["NoVigApp"].'
          },
          participants: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional participant filter (team/player names). Mirrors the /screen "Participants" filter — only rows for these participants are returned.'
          },
          live: {
            type: 'boolean',
            description:
              'Query live (in-play) odds instead of pre-match. Mirrors the /screen Pre-match/Live toggle. Default: false (pre-match).'
          },
          lookbackHours: {
            type: 'number',
            description: 'Odds-history lookback window in hours, default 6'
          },
          verbosity: VERBOSITY_PARAM
        },
        required: ['league', 'gameIds'],
        additionalProperties: false
      }
    },
    {
      name: 'validate_play',
      description:
        'PRE-BET CHECK — run validation on a play. Returns BET/CONSIDER/PASS. Always pass playId from a prior screen row. NOTE: tier/kaiCall/edge/screenScore are signal-quality ratings (what sharp books are doing), NOT win-probability predictions.',
      inputSchema: {
        type: 'object',
        usage_example:
          'Call with league="NBA", gameId="id-from-screen", selection="Celtics", book="Fliff". For exact matching, pass playId from the screen row instead of (or with) selection — this avoids "no row matched" lookup_failed errors on totals/spread markets.',
        properties: {
          league: { type: 'string', description: 'League such as NBA, Tennis. Required.' },
          gameId: {
            type: 'string',
            description: 'Game ID from a prior screen_ranked row (gameId field). Required.'
          },
          selection: {
            type: 'string',
            description:
              'Player or team name from a prior screen_ranked row (selection or participant field). Required UNLESS playId is provided.'
          },
          playId: {
            type: 'string',
            description:
              'Canonical playId from a prior quick_screen / recommended_bets / screen_ranked row. When provided, row matching uses exact playId lookup and skips fragile string comparison — pass this to avoid "no row matched" lookup_failed errors. Takes priority over selection string matching.'
          },
          market: {
            type: 'string',
            description:
              'Market type, default Moneyline. Required for correct row matching when playId is NOT supplied — use the league-specific market name (e.g. "Total Points", "Point Spread", "Draw No Bet", "Total Games").'
          },
          books: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Books to include in the validation, e.g. ["Fliff", "Pinnacle"]. Default uses the league preset.'
          },
          book: {
            type: 'string',
            description:
              'Execution book — the book you intend to place the bet on. Used for the executable-price check. Defaults to the first book in `books` or the league preset preferred book.'
          },
          lookbackHours: {
            type: 'number',
            description: 'Odds-history lookback window in hours, default 6'
          },
          skipResearch: {
            type: 'boolean',
            description:
              'When true, skip the player_context research step. Use this for ultra-fast validation when you only need odds/execution checks. Default false.'
          }
        },
        required: ['league', 'gameId'],
        additionalProperties: false
      }
    },
    {
      name: 'find_best_price',
      description:
        'LINE SHOP — check which book has the best price. Shows every book sorted best-to-worst. PITFALL: use get_market_registry first to discover market names.',
      inputSchema: {
        type: 'object',
        usage_example: 'Call with league="NBA", market="Moneyline", game="Lakers vs Celtics", selection="Lakers".',
        properties: {
          game: { type: 'string', description: 'Game matchup or team name to match' },
          league: { type: 'string', description: 'League such as NBA' },
          market: { type: 'string', description: 'Market type, e.g. Moneyline, Spread, Total' },
          selection: { type: 'string', description: 'Player or team selection to match' },
          books: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional book filter - show only these books'
          },
          is_live: {
            type: 'boolean',
            description:
              'Whether to query live odds. Deprecated alias — prefer the canonical "live" param (same value, cleaner name). Both names accepted.'
          },
          live: {
            type: 'boolean',
            description: 'Whether to query live odds. Canonical name (preferred over "is_live").'
          }
        },
        required: ['league', 'market', 'game', 'selection'],
        additionalProperties: false
      }
    }
  ];
}

module.exports = { buildValidationTools };
