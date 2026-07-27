# Configuration

Environment variables and book configuration for the PropProfessor MCP.

## Environment Variables

| Variable                                   | Default                                              | Description                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_FILE`                                | `~/.propprofessor/auth.json`                         | Path to the auth file (cookies + tokens)                                                                                                                                        |
| `PROPPROFESSOR_MCP_NDJSON`                 | (required)                                           | Set to `'true'` to enable NDJSON framing (required for stdio MCP)                                                                                                               |
| `PROPPROFESSOR_CACHE_TTL_MS`               | `60000`                                              | Response cache TTL in milliseconds                                                                                                                                              |
| `PROPPROFESSOR_CACHE_MAX`                  | `50`                                                 | Max cache entries (LRU eviction)                                                                                                                                                |
| `LOCAL_TIMEZONE`                           | `America/Chicago`                                    | Display timezone for CLI output                                                                                                                                                 |
| `PROPPROFESSOR_DEBUG`                      | (unset)                                              | Set to any value to enable debug logging to stderr                                                                                                                              |
| `PROPPROFESSOR_MCP_MODE`                   | `lite`                                               | Tool surface mode. `lite` (default) exposes the 15 essentials for agent-friendly workflows. `full` exposes all 31 tools for power users.                                        |
| `NITTER_BASE`                              | `http://localhost:8080`                              | Nitter instance for `player_context` tweet lookup                                                                                                                               |
| `PROPPROFESSOR_MCP_STDIO_COALESCE_MS`      | `0`                                                  | Batch stdout writes (ms). `0` = passthrough (no change). `1`+ buffers and flushes on a timer. Reduces write syscalls during bursty JSON-RPC responses. Requires server restart. |
| `PROPPROFESSOR_MCP_PREWARM`                | `1`                                                  | Pre-warm odds-history cache on session start. Set `0` to disable. League screens fire in parallel.                                                                              |
| `PROPPROFESSOR_MCP_PREWARM_LEAGUES`        | `NBA,MLB,NFL,NHL,WNBA,NCAAB,NCAAF,Soccer,Tennis,UFC` | Comma-separated list of leagues to pre-warm. Ordered by betting activity.                                                                                                       |
| `PROPPROFESSOR_MCP_PREWARM_TIMEOUT_MS`     | `10000`                                              | Max ms before pre-warming aborts (best-effort, returns partial results).                                                                                                        |
| `PROPPROFESSOR_CIRCUIT_BREAKER_THRESHOLD`  | `5`                                                  | Consecutive upstream failures before the circuit opens.                                                                                                                         |
| `PROPPROFESSOR_CIRCUIT_BREAKER_TIMEOUT_MS` | `30000`                                              | Ms until the circuit transitions open → half-open for a test request.                                                                                                           |

## Book configuration

The MCP uses three book categories. These are passed as parameters to specific tools.

### 1. Target execution books (your betting books)

Books you actually place bets on. Pass to `quick_screen`, `smart_bet`:

```json
{ "targetBooks": ["Fliff", "NoVigApp", "Rebet"] }
```

### 2. Sharp comparison books (movement detection)

Books whose line movement signals sharp action. Pass to `quick_screen` (mode='sharp'), `sharp_consensus`, `screen_ranked`:

```json
{ "sharpBooks": ["Pinnacle", "Circa", "BookMaker", "BetOnline"] }
```

### 3. Display books (line shopping)

Books to show in `find_best_price` or `screen_raw`:

```json
{ "books": ["Pinnacle", "FanDuel", "DraftKings", "NoVigApp"] }
```

### Default sharp sets (per sport/market)

Pre-configured in `lib/propprofessor-sharp-books.js`:

| Sport                               | Main market                                               | Props                                                     |
| ----------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| **NBA**                             | Circa, Pinnacle, BookMaker, BetOnline, DraftKings         | FanDuel, BookMaker, PropBuilder, NoVigApp, Pinnacle       |
| **NFL**                             | Circa, Pinnacle, BookMaker, NoVigApp, FanDuel             | Pinnacle, FanDuel, BookMaker, Circa, BetOnline            |
| **MLB**                             | Pinnacle, Circa, BookMaker, BetOnline, DraftKings, BetMGM | Circa, FanDuel, PropBuilder, Pinnacle, DraftKings, Bet365 |
| **NHL**                             | Pinnacle, Circa, BookMaker, BetOnline, DraftKings         | (same as main)                                            |
| **Soccer, UFC, NCAAB, NCAAF, WNBA** | Pinnacle, Polymarket, Kalshi, BetOnline, Circa            | (same as main)                                            |

## Token compression

For agents that hit context-window limits:

1. Install `caveman-shrink` globally: `npm install -g caveman-shrink`
2. Use it as the command wrapper in your MCP client config:

```yaml
mcp_servers:
  propprofessor:
    command: caveman-shrink
    args:
      - node
      - /path/to/propprofessor-mcp/scripts/propprofessor-mcp-server.js
    enabled: true
    env:
      AUTH_FILE: /path/to/.propprofessor/auth.json
      PROPPROFESSOR_MCP_NDJSON: 'true'
```

Typically cuts token usage 30–50% on large responses with minimal loss of meaning.
