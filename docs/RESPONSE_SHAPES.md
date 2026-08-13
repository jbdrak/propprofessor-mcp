# Response Shape Reference

Every MCP tool returns a JSON object. The contract is **loose by intent** — the project does not enforce a single envelope on every tool — but the patterns below describe what agents can rely on.

## Universal fields

Most tools return at least:

| Field        | Type                    | Meaning                                                                              |
| ------------ | ----------------------- | ------------------------------------------------------------------------------------ |
| `ok`         | `boolean`               | `true` on success. `false` for any failure.                                          |
| `error`      | `object \| undefined`   | Present when `ok: false`. Shape: `{ code, message, category?, status?, recovery? }`. |
| `result`     | `any`                   | The payload on success. Shape varies per tool.                                       |
| `resultMeta` | `object \| undefined`   | Optional metadata: counts, freshness, alias resolution, tier counts.                 |
| `freshness`  | `object \| undefined`   | `{ fetchedAt, ageMs, stale }` when the response includes time-sensitive data.        |
| `warnings`   | `string[] \| undefined` | Non-fatal advisories (e.g. degraded line history, missing sharp book).               |

## Filtering & sorting (screen-family tools)

The screen-family tools (`quick_screen`, `screen_ranked`, `sharp_consensus`) accept two optional input params that operate on the final result set before verbosity formatting:

| Param     | Type            | Effect                                                                                         |
| --------- | --------------- | ---------------------------------------------------------------------------------------------- |
| `kaiCall` | `string[]`      | Keep only rows whose `kaiCall` is in the list. Default: no filter. Example: `["BET"]`.         |
| `sortBy`  | `string` (enum) | Sort by `start` / `edge` / `tier` / `consensusBookCount` / `riskScore`. Default: server order. |
| `sortDir` | `string` (enum) | `asc` / `desc`. Overrides per-field default.                                                   |

**Field-specific default direction:** `start` asc (soonest first), `edge` desc (largest first), `tier` asc (TIER 1 first), `consensusBookCount` desc (most books first), `riskScore` asc (lowest risk first).

**Missing-field rows always sort to the end**, regardless of direction. A row with no `start` value won't get stuck at position 1 of a `sortBy: "start", sortDir: "desc"` call.

**Missing/garbage `kaiCall` is treated as `PASS`.** A row with no kaiCall field, or `kaiCall: "unknown"`, will only be returned when you explicitly include `"PASS"` in the filter.

## Tier-bearing fields (signal-quality, NOT win-probability)

When a tool returns ranked rows, each row may include:

| Field                | Type                                           | Meaning                                                                                     |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `confidenceTier`     | `"TIER 1" \| "TIER 2" \| "TIER 3" \| "TIER 4"` | Signal-quality rating on what sharp books are doing. Lower = cleaner signal.                |
| `kaiCall`            | `"BET" \| "CONSIDER" \| "PASS"`                | Layered action label derived from tier + risk + edge.                                       |
| `movementGrade`      | `"green" \| "yellow" \| "red"`                 | Movement quality band.                                                                      |
| `riskScore`          | `number`                                       | 1-10, lower = cleaner. Weighted factors: consensus, steam, execution, history completeness. |
| `consensusEdge`      | `number \| null`                               | Consensus-vs-target edge in percentage points. May be negative.                             |
| `consensusBookCount` | `number`                                       | Number of sharp books agreeing on direction.                                                |
| `consensusStrength`  | `"strong" \| "moderate" \| "weak" \| "none"`   | Categorical version of the above.                                                           |
| `screenScore`        | `number`                                       | Composite score. Higher = stronger signal.                                                  |
| `rationale`          | `string`                                       | Human-readable explanation of the tier + risk + movement.                                   |

**These are quality ratings on what sharp books are doing, NOT predictions about which side will win.** TIER 1 hit rate sits around chance on the synthetic backtest. Use to inform handicapping, not to outsource decisions.

## Per-tool shapes

### `screen_ranked`

```jsonc
{
  "ok": true,
  "result": [/* ranked rows */],
  "resultMeta": {
    "tierCounts": { "TIER 1": 1, "TIER 2": 2, "TIER 3": 0, "TIER 4": 5 },
    "markets_alias_used": []
  },
  "freshness": { "fetchedAt": "2026-06-16T11:55:00Z", "ageMs": 1234, "stale": false },
  "warnings": [],
  "league": "NBA"
}
```

### `all_slates`

```jsonc
{
  "ok": true,
  "totalPlays": 42,
  "leaguesQueried": ["NBA", "MLB", "NHL"],
  "leagueMeta": { "NBA": { "tierCounts": {...} } },
  "consolidated": [ /* ranked rows */ ]
}
```

**Note:** `all_slates` does NOT include `result`, `resultMeta`, or `freshness` at the top level. Use `consolidated` instead. Returns ALL ranked rows regardless of tier; use `quick_screen` with `targetTiers: ['TIER 1','TIER 2']` for the filtered shortlist.

### `quick_screen` filtered shortlist

Use `quick_screen` with `targetTiers: ['TIER 1','TIER 2']` (or any tier filter). The response shape below is what `quick_screen` returns when filtered.

```jsonc
{
  "ok": true,
  "totalRecommended": 8,
  "focusBook": "Fliff",       // v2.2.0: the execution book from the user's `books` param
  "markets_queried": ["Moneyline", "Spread", "Total"],
  "leagues": [
    {
      "league": "NBA",
      "count": 3,
      "markets_queried": ["Moneyline", "Spread", "Total"],
      "downgradedCount": 0,
      "plays": [
        {
          "game": "Lakers @ Celtics",
          "selection": "Lakers ML",
          "book": "Fliff",    // v2.2.0: the book this play is executable on
          "odds": -135,
          "edge": 2.4,
          "tier": "TIER 1",
          ...
        }
        /* tier-tagged rows with optional research attached */
      ]
    }
  ],
  "summary": { "TIER 1": 2, "TIER 2": 6 },
  "tierFilter": ["TIER 1", "TIER 2"]
}
```

### `quick_screen`

```jsonc
{
  "ok": true,
  "targetBook": "Fliff",
  "targetBooks": ["Fliff"],
  "leagues": ["NBA", "MLB"],
  "markets": ["Moneyline", "Spread", "Total"],
  "totalCandidates": 5,
  "results": [
    {
      "league": "NBA",
      "market": "Moneyline",
      "candidates": [
        {
          "game": "Lakers @ Celtics",
          "selection": "Lakers ML",
          "odds": -135,
          "edge": 2.4,
          "confidenceTier": "TIER 1",
          "rationale": "...",
          ...
        }
      ]
    }
  ],
  "research": [
    { "player": "Tatum", "riskFlag": "low", "riskSummary": "..." }
  ],
  "workflow": "Fliff target book(s). Playable price (not necessarily best). Sharp book movement cross-referenced. Player context research included.",
  "markets_alias_used": []
}
```

#### validated fields (when `validate` is true — the default)

| Field                        | Type     | Source                                                                                                                                        |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| validatedTier                | string   | BET/CONSIDER/PASS from validate_play                                                                                                          |
| validatedConsensusBookCount  | number   | Re-fetched consensus count. 0 when the line could not be re-found (validatedUnverified=true) — never silently reuses the screen's stale count |
| validatedMovementDisposition | string   | supportive_clean / supportive_bouncy / adverse_full / insufficient                                                                            |
| validatedRiskFlags           | string[] | Risk flags from validation                                                                                                                    |
| validatedActionableSummary   | string   | Human-readable summary from validate_play verdictSummary                                                                                      |
| validatedEdge                | number   | Validated consensus edge (may differ from screen value)                                                                                       |
| validatedClv                 | number   | Validated CLV                                                                                                                                 |
| validatedGameContext         | object   | MLB weather/pitchers/park or Tennis surface/tournament                                                                                        |

#### `finalVerdict` (authoritative bet/no-bet call)

Computed server-side by merging the screen tier and the validation verdict into ONE field, so agents no longer reconcile a screen BET against a validation PASS by hand.

| Field               | Type     | Meaning                                                                |
| ------------------- | -------- | ---------------------------------------------------------------------- |
| finalVerdict        | string   | `BET` \| `CONSIDER` \| `PASS`. Validation wins; hard fails force PASS. |
| finalConfidenceTier | string   | `TIER 1`..`TIER 4`. `validatedTier` if present, else `confidenceTier`. |
| priceDrift          | number   | `\|validatedOdds - odds\|` when both finite; null otherwise.           |
| finalWarnings       | string[] | `price-drift`, `unknown-game-context`, `validation-failed`.            |

#### `sharp_alerts` response shape

```jsonc
{
  "ok": true,
  "newAlerts": [/* finalVerdict=BET plays seen for the first time in the dedup window */],
  "repeatAlerts": [/* same plays re-confirmed within the dedup window */],
  "allBets": [/* every finalVerdict=BET play this scan, new+repeat */],
  "message": null /* or "No new sharp plays right now." when newAlerts is empty */
}
```

Each alert: `{ game, selection, market, odds (validatedOdds ?? odds), edge, clv, startCST, finalConfidenceTier, researchRiskFlag, priceDrift, finalWarnings }`.
The `_meta.validation` block on the response root reports how many candidates were validated:

```jsonc
{
  "_meta": {
    "validation": {
      "requested": 3,
      "completedCount": 2,
      "note": "Validated rows have validatedTier, ... and _validated=true"
    }
  }
}
```

### `ask` (v2.2.0)

```jsonc
{
  "ok": true,
  "raw": "best plays on Fliff today",
  "parsed": {
    "league": null,
    "book": "Fliff",
    "market": null,
    "side": null,
    "line": null,
    "player": null
  },
  "suggestedTool": {
    "tool": "quick_screen",
    "args": { "books": ["Fliff"] }
  },
  "workflow": "Parsed the natural language query. Call the suggested tool with the suggested args to get results back."
}
```

### `validate_play`

```jsonc
{
  "ok": true,
  "league": "NBA",
  "market": "Moneyline",
  "gameId": "NBA:PREMATCH:LAL:BOS:1780185600",
  "selection": "Lakers ML",
  "executionBook": "Fliff",
  "verdict": "BET", // "BET" | "CONSIDER" | "PASS"
  "tier": "TIER 1", // confidenceTier of the matching row
  "reasons": ["consensus: 5 comp books agree", "execution quality is \"best\""],
  "play": {/* full ranked row */},
  "research": {/* player_context result */}
}
```

### `get_started`

```jsonc
{
  "summary": "For casual bettors who just want top picks.",
  "steps": ["..."],
  "tools_to_use": ["quick_screen", "player_context"],
  "avoid": ["sharp_consensus", "ev_candidates"],
  "tool_descriptions": [
    {
      "name": "quick_screen",
      "one_liner": "Curated TIER 1-2 plays across leagues.",
      "when_to_call": "Your main \"what should I bet\" tool. Default to verbosity=\"minimal\" for plain English."
    }
  ],
  "honest_scope": "TIER 1-4, kaiCall (BET/CONSIDER/PASS), edge, and screenScore are quality ratings on what sharp books are doing — NOT predictions about which side will win. ..."
}
```

### `health_status`

```jsonc
{ "ok": true, "auth": { "valid": true, "expiresAt": "..." }, "backend": { "ok": true } }
```

## Error envelope

All tools may fail with:

```jsonc
{
  "ok": false,
  "error": {
    "code": "AUTH_EXPIRED", // string code, see categorizeError in lib/propprofessor-errors.js
    "category": "auth", // "auth" | "validation" | "upstream" | "rate_limit" | "internal"
    "status": 401, // suggested HTTP status if proxied
    "message": "Auth file is expired. Run: pp-query login",
    "recovery": "pp-query login"
  }
}
```

When the request is run with `debug: true`, the error envelope additionally includes `originalMessage`, `cause`, and a `stack` field (stack is redacted via `redactSecrets`).

## Compact mode

Several tools accept a `compact: true` flag. When set:

- Verbose fields stripped from each row: `lineHistory[]`, `scoreBreakdown{}`, `allBookOdds{}`, `filteredLineHistory[]`, `movementDebug{}`, `history{}`.
- Reduces response size ~70-90% depending on tool.
- **Does NOT affect history hydration** — movement data is still fetched server-side; only the response payload is trimmed.
- On `quick_screen`, only the nested `screen_ranked` payloads shrink; the outer envelope (`leagues[]`, `markets_queried`, `summary`, etc.) is unaffected.

When `compact` is paired with a `fields: [...]` list, `fields` takes precedence and is applied row-by-row.

## Verbosity levels

Tools with ranked rows accept `verbosity: "minimal" | "standard" | "full"`:

- `minimal`: plain English summary + count. No row-level data.
- `standard` (default): row-level tier + risk + rationale. Standard fields.
- `full`: all movement data, line history, debug payloads.

At `minimal` verbosity, the `ok` and `result` fields are replaced with `{ summary, count }` in the formatter pass — agents checking for `ok: true` should use `standard` or `full`.

## Tool composition map (routing)

## Composite tools internally call these primitives (current architecture)

| Tool                        | Calls                                                              |
| --------------------------- | ------------------------------------------------------------------ |
| `quick_screen` (v2.2.0)     | `screen_ranked` (per league × market, parallelized, concurrency 4) |
| `staking_plan`              | `quick_screen`                                                     |
| `validate_play`             | `get_play_details` + `player_context` (parallelized)               |
| `ev_candidates` (validated) | `ev_candidates` (raw) + `screen_ranked` (validation pass)          |
| `all_slates`                | `screen_ranked` per league, parallelized                           |

When in doubt: **prefer the leaf tool** (`screen_ranked`, `get_play_details`, `player_context`) for full control. The composite tools (`quick_screen`, `staking_plan`, `validate_play`) trade flexibility for convenience.
