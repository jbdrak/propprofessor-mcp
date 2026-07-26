# Performance & Response Tuning

Every screen/recommended/staking tool supports a set of params that let you trade off response size, latency, and data completeness. Use these to keep your agent's context window small and fast.

## Quick reference

| Flag                                                      | Effect                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `compact: true`                                           | ~90% smaller response. Retains movement signals (steamMove, consensusEdge, movementLabel). Does **NOT** skip history hydration. |
| `skipHistory: true`                                       | Skips odds history hydration entirely. Use when you only need current odds/edges. ~10–50× faster on large queries.              |
| `fields: ["game","selection","odds","edge","tier","kai"]` | Selective field return. Overrides `compact` when both are set.                                                                  |
| `include: ["resultMeta"]`                                 | Top-level section filtering. Values: `"freshness"`, `"warnings"`, `"resultMeta"`, `"league"`.                                   |
| `verbosity: "minimal" \| "standard" \| "full"`            | Pre-set response shapes. `minimal` = plain English. `standard` = structured. `full` = everything (default).                     |

## When to use what

**Casual bettor asking "what should I bet on tonight?"**

```js
recommended_bets({ verbosity: 'minimal' }); // retired — use quick_screen(...)
```

Returns plain-English picks with the kaiCall and a one-line reason.

**Agent that's about to call multiple tools and needs to stay fast**

```js
screen_ranked({ compact: true, skipHistory: true });
```

Strips response to ~25 essential fields per row and skips the N+1 history API calls. 10–50× faster.

**Agent drilling into a specific play it already saw in a compact list**

```js
get_play_details({ league: 'NBA', gameIds: ['abc123'] });
```

Returns the full row (line history, consensus, movement debug) for the specific game. This is the canonical "compact list → drill into selected" workflow.

**Agent building a custom view that needs only specific fields**

```js
screen_ranked({ fields: ['game', 'selection', 'odds', 'edge', 'tier', 'kaiCall'] });
```

Returns only the fields you asked for. Overrides `compact` if both are set.

**Agent validating a pick against historical movement**

```js
sharp_consensus({ gameId: 'abc123', windows: [1, 6, 24, 48] });
```

Returns the multi-window sharp consensus trace for a specific game.

## Caching

The MCP has a built-in in-memory LRU cache:

- **TTL**: 60s default, configurable via `PROPPROFESSOR_CACHE_TTL_MS`
- **Max entries**: 50, configurable via `PROPPROFESSOR_CACHE_MAX`
- **Cache hits**: reported via `resultMeta.cached: true`
- **Caches only**: full responses (not compact or fields-filtered)

If your agent is hitting the same screen rapidly, the second call within 60s will be a cache hit and near-instant.

## Token compression

For agents that hit context-window limits with large responses, install `caveman-shrink` globally and use it as the command wrapper:

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

This typically cuts token usage 30–50% on large responses with minimal loss of meaning.
