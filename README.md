# PropProfessor MCP ── Sharp Money Intelligence for AI Agents

<p align="center">
  <a href="https://github.com/j17drake/propprofessor-mcp/releases">
    <img src="https://img.shields.io/github/v/release/j17drake/propprofessor-mcp?color=44cc11" alt="Release" />
  </a>
  <a href="https://github.com/j17drake/propprofessor-mcp/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/j17drake/propprofessor-mcp/ci.yml?branch=main&label=ci" alt="CI" />
  </a>
  <img src="https://img.shields.io/badge/tests-passing-44cc11" alt="Tests" />
  <img src="https://img.shields.io/badge/coverage-82%25-44cc11" alt="Coverage" />
  <img src="https://img.shields.io/badge/node-18%2B-44cc11" alt="Node" />
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
  </a>
</p>

PropProfessor MCP is a Model Context Protocol server that lets AI agents see what the sharpest sportsbooks are doing. It screens 36 books across 10 leagues, detects coordinated sharp movement, surfaces steam moves and line lags, and explains the consensus — so you can decide what to bet, not be told.

Connect it to Claude Desktop, Cursor, Cline, Hermes, or any MCP client. Requires a [PropProfessor](https://propprofessor.com) account.

> **Honest scope — no profitability claim:** PropProfessor MCP is a sharp-signal DISCOVERY and RATING tool. `tier` / `kaiCall` / `edge` / `screenScore` are signal-quality ratings, not win-probability predictions. Profitability is UNPROVEN — no settled-results backtest has been published yet. Use it to find candidate plays and validate them yourself; do not treat outputs as a guaranteed winning system. The ranking pipeline surfaces _what sharp books are doing_; the betting decision stays with you.

## 🚀 Overview

Your AI agent gets 31 tools that surface the same signal feed professional bettors use:

- **Screen & rank** — query live odds across 36 sportsbooks, ranked by consensus edge and movement
- **Detect sharp coordination** — Pinnacle, Circa, BookMaker, and BetOnline moving together? That's a signal
- **Explain the "why"** — every play comes with a human-readable rationale: _what moved, on which books, over what timeframe_
- **Natural language routing** — agents call `ask("best plays on Fliff tonight")` and get routed to the right tool automatically

The pipeline extracts odds, hydrates line history, ranks by movement quality + consensus strength, assigns a tier and risk score, and returns everything your agent needs to present an informed recommendation. The betting decision stays with the human.

## ⚡ Quickstart (30 seconds)

1. **Install:** `npm install -g propprofessor-mcp` (or clone + `npm install` for dev)
2. **Wire your MCP client** — pick your client below:

   **Claude Desktop** (`claude_desktop_config.json`):

   ```json
   {
     "mcpServers": {
       "propprofessor": {
         "command": "pp",
         "args": ["--mcp"]
       }
     }
   }
   ```

   **Cline** (`cline_mcp_settings.json`):

   ```json
   {
     "mcpServers": {
       "propprofessor": {
         "command": "pp",
         "args": ["--mcp"],
         "env": {}
       }
     }
   }
   ```

   **Cursor** — Settings → Features → MCP Servers → Add:

   ```
   Name: propprofessor
   Type: command
   Command: pp --mcp
   ```

   **Continue.dev** (`~/.continue/config.json`):

   ```json
   {
     "experimental": {
       "mcpServers": {
         "propprofessor": {
           "command": "pp",
           "args": ["--mcp"]
         }
       }
     }
   }
   ```

   **Hermes** (`~/.hermes/config.yaml`):

   ```yaml
   mcp_servers:
     propprofessor:
       command: pp
       args: [--mcp]
   ```

3. **Auth (one-time):** `node scripts/pp-login.js` — opens a browser for PropProfessor login and persists cookies for the server to use.
4. **Ask your agent:** _"What are tonight's sharpest plays on Fliff?"_

That's it — your agent now sees 31 tools.

> **Verify your install:** `npm run install:verify` runs the non-API test suite (53 tests, no credentials needed).

### CLI — `pp`

PropProfessor ships with a fast, standalone CLI that calls handlers directly — no MCP server needed.

```bash
npm install -g propprofessor-mcp
pp scan mlb tennis -M supportive -n3
```

11 commands for scanning, validation, logging, and fantasy:

| Command                 | Description                                 |
| ----------------------- | ------------------------------------------- |
| `pp scan [leagues...]`  | Find plays across leagues                   |
| `pp scan -M supportive` | Filter by movement (clean, bouncy, adverse) |
| `pp scan --fast`        | Quick scan (5 fastest leagues)              |
| `pp scan -B`            | Only BET verdict plays                      |
| `pp validate <playId>`  | Validate a specific play                    |
| `pp game <gameId>`      | Get full game details                       |
| `pp player <name>`      | Player context + injury/risk flags          |
| `pp prices <gameId>`    | Compare prices across books                 |
| `pp log <gameId>`       | Log a pick                                  |
| `pp picks`              | Recent pick history                         |
| `pp rank <league>`      | Ranked plays for a league                   |
| `pp fantasy`            | Fantasy optimizer props                     |
| `pp today`              | Today's slate + pending picks               |
| `pp health`             | Auth + backend health check                 |

**MCP mode:** `pp --mcp` runs as an MCP stdio server. Connect it to Claude Desktop,
Cursor, Cline, or any MCP client. Pass `--mode full` for the full 31-tool surface.

All commands support `-j`/`--json` for piping and `--no-color` for CI/Telegram output.

Example output (scan filtered by supportive movement):

```
MLB › Moneyline  (2)
  Houston Astros @ +127  |  TIER 1  ● BET
    1.9%  ·  clv +4¢  ·  mv supportive_bouncy  ·  5 books
    Chicago White Sox vs Houston Astros  Fri, Jul 24, 6:40 PM

Tennis › Total Games  (1)
  Under 21.5 @ -104  |  TIER 1  ● BET
    3.4%  ·  mv supportive_clean  ·  16 books
    Avanesyan vs Oliynykova  Fri, Jul 24, 7:00 AM
```

## 📊 Backtesting

PropProfessor includes a backtest runner that prints settled-pick performance across any date range.

```bash
# Show last 30 days of settled picks
node scripts/backtest-runner.js --days 30

# Show a specific date range
node scripts/backtest-runner.js --from 2026-06-01 --to 2026-07-20

# Or use the installed binary
pp-backtest --days 30
```

The runner reads from `~/.propprofessor/picks.json` — the same file used by `pp log` and `pp picks`. It shows total picks, settled records, win rate, P&L, and breakdowns by tier and league. It never fabricates ROI. If no settled picks exist in the range, it says so honestly.

## 🏛 Architecture

PropProfessor MCP follows a layered data pipeline:

### API Layer

- **PropProfessor Backend** — authenticated REST API for live odds, line history, and fantasy data
- **ESPN Integration** — live scores for tennis time correction and game verification
- **X / Google News** — player context (injury news, tweets) for bet validation

### Ranking Pipeline (Node.js)

- **Extract** — parse raw odds payloads from the screen API, expand multi-book selections
- **Hydrate** — enrich each row with 12-hour odds history via the backend API (cached cross-call with 5-min TTL)
- **Rank** — score by consensus edge (% advantage over sharp consensus), CLV proxy (opening vs current line movement), and league-specific market priorities
- **Tier** — assign TIER 1–4 based on movement grade (green/yellow/red) × risk score (1–10) × sharp book confirmation, with hysteresis to prevent thrashing
- **Format** — output at three verbosity levels: `minimal` (plain English), `standard` (tier/edge/risk/rationale), `full` (raw movement data)

### MCP Server (stdio)

- **JSON-RPC over stdio** — standard MCP transport with Content-Length framing (NDJSON optional)
- **31 tools** — organized into situational, analytical, and research tiers
- **Server-side validation** — enforces input schemas at the server, not trusting the client
- **Categorized errors** — auth, backend, transport, validation, internal — each with structured recovery hints

### Data Flow

```mermaid
flowchart LR
    subgraph BOOKS["36 Sportsbooks"]
        B1[Pinnacle]
        B2[Circa]
        B3[BookMaker]
        B4[BetOnline]
        B5[NoVigApp]
        B6[Fliff]
        BN[...30 more]
    end

    API[PropProfessor API]

    subgraph PIPE["Ranking Pipeline"]
        E[Extract odds]
        H[Hydrate with line history]
        R[Rank by movement + consensus]
        T[Tier + risk score]
    end

    subgraph OUTPUT["30 MCP Tools"];
        QS[quick_screen]
        T[today]
        SB[smart_bet]
        VP[validate_play]
        ASK[ask]
        OTH[...25 more]
    end

    CLIENT[Your AI Agent<br/>Claude / Cursor / Cline / Hermes]

    BOOKS --> API --> PIPE --> OUTPUT --> CLIENT
    CLIENT -. "you decide what to bet" .- BOOKS
```

## 🛠 Getting Started

### Quick Start

```bash
git clone https://github.com/j17drake/propprofessor-mcp.git
cd propprofessor-mcp
npm install
npm link
pp-query init          # auth + verification + config — all at once
```

`pp-query init` checks Node version, opens PropProfessor login if needed, runs `doctor`, and prints ready-to-paste MCP config for your client. Or do it step by step:

```bash
pp-query login         # browser login
pp-query doctor        # verify everything works
```

Requires a paid [PropProfessor](https://propprofessor.com) account. That's it — you're ready to connect your AI agent.

### MCP Client Setup

Add to your client's MCP config:

```json
{
  "mcpServers": {
    "propprofessor": {
      "command": "node",
      "args": ["/path/to/propprofessor-mcp/scripts/propprofessor-mcp-server.js"],
      "env": {
        "PROPPROFESSOR_MCP_NDJSON": "true",
        "AUTH_FILE": "/path/to/.propprofessor/auth.json"
      }
    }
  }
}
```

Replace `/path/to/` with your actual install path (e.g. `/Users/you/projects/propprofessor-mcp`). Supports Claude Desktop, Cursor, Cline, Zed, Continue.dev, Windsurf, and any other stdio-based MCP client. See each client's docs for where MCP config lives.

**For short-lived one-off sessions:**

```json
{ "command": "npx", "args": ["-y", "propprofessor-mcp"] }
```

Works out of the box — no git clone needed. Requires a PropProfessor account.

**For headless/CI environments (no Chrome):**

Set the `PROPPROFESSOR_COOKIES` env var with your PropProfessor cookies exported as JSON. This bypasses the CDP/Chrome auth path entirely:

```json
{
  "mcpServers": {
    "propprofessor": {
      "command": "npx",
      "args": ["-y", "propprofessor-mcp"],
      "env": {
        "PROPPROFESSOR_COOKIES": "[{\"name\":\"__Secure-next-auth.session-token\",\"value\":\"...\",\"domain\":\".propprofessor.com\"}]"
      }
    }
  }
}
```

### CLI Commands

| Command           | Purpose                                                 |
| ----------------- | ------------------------------------------------------- |
| `pp-mcp`          | MCP server (stdio) — what your AI agent connects to     |
| `pp-query init`   | One-command setup (Node check + auth + doctor + config) |
| `pp-query login`  | Browser login to PropProfessor                          |
| `pp-query doctor` | Full diagnostic check                                   |

### Hermes Agent

If you use [Hermes Agent](https://github.com/NousResearch/hermes-agent):

```bash
make install          # register MCP server + install default config
```

Or manually: add `propprofessor` to your `mcp_servers` in config.yaml. The `get_started` tool provides on-demand workflow guidance.

### Optional: Sharp-money alert cron

```bash
make install-cron
```

Runs hourly, delivers TIER 1 plays to your home Telegram channel.

### CLI commands

| Command           | Purpose                                             |
| ----------------- | --------------------------------------------------- |
| `pp-mcp`          | MCP server (stdio) — what your AI agent connects to |
| `pp-query`        | CLI for setup, debug, and quick one-off queries     |
| `pp-query login`  | Browser login to PropProfessor                      |
| `pp-query doctor` | Full diagnostic check                               |

## 🎯 The Natural Language Flow

Agents don't need to memorize tool names. Call `ask` to parse a user's query, then call the suggested tool:

```
You:  "Tell me the best plays on Fliff tonight"
Agent: ask({ query: "best plays on Fliff tonight" })
       → { parsed: { book: "Fliff" }, suggestedTool: "quick_screen", suggestedArgs: { books: ["Fliff"] } }
Agent: quick_screen({ books: ["Fliff"] })
       → [ranked plays with odds, edge, tier, risk, rationale — all on Fliff]
```

| You say                              | `ask` calls                                            | Returns                              |
| ------------------------------------ | ------------------------------------------------------ | ------------------------------------ |
| "best plays on Novig"                | `quick_screen(books=["NovigApp"])`                     | Playable bets with player context    |
| "what should I bet today"            | `quick_screen(mode="recommended")`                     | TIER 1 & TIER 2 across major leagues |
| "Tatum over 29.5 points"             | `player_context(player="Tatum", sport="NBA")`          | Injury/news risk check               |
| "show me MLB sharp plays"            | `quick_screen(leagues=["MLB"], mode="sharp")`          | Multi-sharp consensus plays          |
| "line shop Celtics ML"               | `find_best_price(league="NBA", market="Moneyline", …)` | Best price across 36 books           |
| "validate that Warriors spread play" | `validate_play(league="NBA", gameId="…", …)`           | BET/CONSIDER/PASS verdict            |

## 📊 Available Tools

### Quick Situational Checks

| Tool                  | What it does                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ask`                 | Parse natural language into the right tool + args, then execute it (one-call answer)                        |
| `today`               | One-call daily briefing: sharp slate + your pending picks + recent stats                                    |
| `get_started`         | Returns recommended workflow for casual/intermediate/sharp users                                            |
| `get_market_registry` | List available markets for a sport, with per-book market names (e.g. Soccer → Draw No Bet)                  |
| `quick_screen`        | Best plays on any book with sharp consensus + player context                                                |
| `smart_bet`           | One-call: play details + validate_play verdict + best price + staking                                       |
| `player_context`      | Injury/availability check on a specific player                                                              |
| `validate_play`       | One-call verdict: re-fetches odds, checks injury news, returns BET/CONSIDER/PASS + playId + drift detection |
| `mlb_game_context`    | Starting pitchers, park factor, hourly weather, lineup lock for an MLB game                                 |
| `find_best_price`     | Line-shop across all books for the best execution price                                                     |
| `health_status`       | Auth freshness and endpoint connectivity                                                                    |

### Deeper Signal Analysis

| Tool              | What it does                                                                         |
| ----------------- | ------------------------------------------------------------------------------------ |
| `sharp_consensus` | Multi-window (1h–48h) sharp movement — is the move sustained?                        |
| `screen_ranked`   | Full ranked data for a (league, market) pair with consensus and movement metadata    |
| `all_slates`      | Consolidated ranked list across multiple leagues in one call                         |
| `league_presets`  | Sport-specific ranking weights and sharp-book reference sets                         |
| `get_alerts`      | Line movement and steam move alerts since last check                                 |
| `ev_candidates`   | Fast +EV discovery — validate on `/screen` afterward                                 |
| `ufc_card`        | UFC card shortlist with official plays, best looks, and pass notes                   |
| `smart_money`     | Sharp action $ volume + per-side odds range per game (the signal the +EV feed hides) |

### Research & Bet Management

| Tool                                  | What it does                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `get_play_details`                    | Line history for specific game IDs                                              |
| `staking_plan`                        | Fractional Kelly sizing (TIER 1: 2%, TIER 2: 1% of bankroll)                    |
| `fantasy_optimizer`                   | DFS-style fantasy picks (PrizePicks, Underdog — requires Fantasy Optimizer sub) |
| `log_pick` / `resolve_pick`           | Track your own bet outcomes                                                     |
| `place_bet`                           | Validate + log a play in ONE call; returns a pickId for settlement              |
| `get_pick_history` / `get_pick_stats` | View logged bets and win rate / P&L                                             |
| `manage_hidden_bets`                  | Hide/unhide bets on the fantasy table                                           |
| `clear_score_timeline`                | Reset tier trajectory tracking for a fresh session                              |

### Output Tuning

Every tool accepts:

| Parameter   | Values                      | What it does                                                           |
| ----------- | --------------------------- | ---------------------------------------------------------------------- |
| `verbosity` | `minimal` `standard` `full` | Controls explanation depth and field output                            |
| `compact`   | `true` / `false`            | Strips line history and debug payloads — reduces response size by ~90% |
| `fields`    | `["game", "edge", "tier"]`  | Return only specified fields per row                                   |

`quick_screen` additionally accepts:

| Parameter         | Values                          | What it does                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cardWindow`      | `today` `next` `all`            | Date filter. `today` = today's slate plus any next-day matches merged in (flagged via `nextDayMerged` in the response). `next` = tomorrow only. `all` = every upcoming match, no date filtering. Default `today`.                                                                                                                                     |
| `maxPlaysPerGame` | `1`–`50` (default `2`)          | Max plays shown per game in `minimal` verbosity (highest `screenScore` first). Raise it (e.g. `10`) for full coverage of a game without a second call. `standard`/`full` verbosity always return every candidate regardless of this value.                                                                                                            |
| `parseable`       | `true`/`false` (default `true`) | When `true`, `minimal` verbosity includes a structured `plays` array alongside the summary — agents get both. Set `false` for summary-only.                                                                                                                                                                                                           |
| `includeResearch` | `true`/`false` (default `true`) | Run player_context research on each returned play and attach `riskFlag` / `riskSummary` / `topTweet` in the `research` array. Research is scoped to the FINAL returned plays (post tier/kaiCall filter) and de-duplicated per game, so the `research` array always matches the plays you see — no full-slate payload blowup. Pass `false` to disable. |
| `researchLimit`   | `1`–`50` (default `50`)         | Max final plays to run research on. Bounds payload size on large scans.                                                                                                                                                                                                                                                                               |

> **Player research is ON by default** in `quick_screen` (pass `includeResearch: false` to disable). It's scoped to the final returned plays and de-duplicated per game, so `research` always maps 1:1 to what you got back. On a huge unfiltered scan, lower `researchLimit` or use `lite` if the response nears the transport cap.

> **`cardWindow` honesty:** when `today` is alive and next-day rows are merged, the response reports `cardWindow: "today"` (not tomorrow's date) plus `nextDayMerged: true` and `nextDayDate`. Earlier builds mislabeled this as tomorrow — that bug is fixed.

> **Tier consistency:** as of 2.8.x, `tierCache` is cleared at the start of every MCP screen call (`quick_screen`, `screen_ranked`, `validate_play`). A given play's tier is therefore stable within a call and recomputed fresh per call — no cross-call drift from stale hysteresis state.

> **`verbosity: minimal` returns a plain-English summary string WITH a structured `plays` array** — agents get both human-readable text and machine-parseable data in one call. Each play in the array includes `league`, `market`, `game`, `selection`, `odds`, `confidenceTier`, `edge`, `startCST`, `movementDisposition`, and `screenScore`.

### Tool Surface Modes

Set `PROPPROFESSOR_MCP_MODE` at server boot to control how many tools the agent sees on `tools/list`:

| Mode   | Default | Tools exposed | Best for                                                                                                                                   |
| ------ | ------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `lite` | ✅ yes  | 14            | **Recommended for most users.** Covers the full workflow (discover → drill-down → validate → track) without overwhelming the tool catalog. |
| `full` | no      | 30            | Power users — every discovery, screen, research, and admin tool. More tools but more noise for the agent to reason about.                  |

Lite mode exposes: `ask`, `smart_bet`, `quick_screen`, `today`, `find_best_price`, `validate_play`, `get_play_details`, `player_context`, `log_pick`, `get_pick_history`, `resolve_pick`, `get_market_registry`, `place_bet`, `sharp_alerts`.

The `tools/list` response always includes a `_meta` block so agents can tell which mode is active:

```json
{
  "tools": [...],
  "_meta": { "mode": "full", "toolCount": 29, "liteToolCount": 13, "fullToolCount": 29 }
}
```

### Tool Categories

Every tool carries a `category` field that groups it by purpose — agents can use this to mentally cluster the surface rather than reading 29 individual descriptions:

| Category     | Count | Purpose                                          | Tools                                                                                               |
| ------------ | ----- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `discovery`  | 6     | Find plays (scout, multi-league, DFS, +EV)       | `all_slates`, `ask`, `ev_candidates`, `fantasy_optimizer`, `get_market_registry`, `sharp_consensus` |
| `screen`     | 5     | Score / rank plays for a target book             | `quick_screen`, `screen_ranked`, `smart_bet`, `staking_plan`, `ufc_card`                            |
| `drill_down` | 3     | Deep dive on a specific play                     | `find_best_price`, `get_play_details`, `validate_play`                                              |
| `research`   | 3     | Context data (player news, game weather, alerts) | `get_alerts`, `mlb_game_context`, `player_context`                                                  |
| `tracking`   | 4     | Personal bet log                                 | `get_pick_history`, `get_pick_stats`, `log_pick`, `resolve_pick`                                    |
| `admin`      | 2     | Bookkeeping (cache, hidden bets)                 | `clear_score_timeline`, `manage_hidden_bets`                                                        |
| `meta`       | 3     | Server info / workflow guides                    | `get_started`, `health_status`, `league_presets`                                                    |

### Canonical vs Deprecated Param Names

A handful of params accept both a clean canonical name and a legacy alias — every existing call site keeps working, and new code can use the cleaner names:

| Canonical (prefer) | Deprecated alias                                | Where                                                                                                             |
| ------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `live`             | `is_live`                                       | 13 tools — `is_live` is snake_case only on the MCP surface; the upstream backend still uses `is_live` on the wire |
| `gameIds`          | `game_ids`                                      | `get_play_details` only                                                                                           |
| `targetBooks`      | `book`, `books`, `targetBook`, `targetBooksCsv` | `quick_screen` — service layer's `resolveTargetBooks()` accepts all 5 names                                       |

Deprecated aliases are documented in each schema's `description` field and are normalized to the canonical key at dispatch time. No code change required for existing callers.

## 🧪 How the Ranking Works

The pipeline grades every play in 5 steps:

1. **Movement grade** — green (all sharp books aligned), yellow (some signals, some not), red (adverse)
2. **Risk score** (1–10) — weighted from movement quality, consensus count, CLV strength, execution quality, and freshness
3. **Tier assignment** — lookup table: green + low risk → TIER 1, green-yellow + moderate → TIER 2, yellow → TIER 3, red → TIER 4
4. **Hysteresis** — a play doesn't thrash between TIER 1 and TIER 3 on small odds changes; tier trajectory is smoothed
5. **Sharp cross-reference** — verifies target-book moves independently against non-target sharp books

**Tier system:**

| Tier       | Label       | Meaning                                                       | Stake              |
| ---------- | ----------- | ------------------------------------------------------------- | ------------------ |
| **TIER 1** | Lock        | Green movement, risk 1–3, BET call. All signals aligned.      | 2% of bankroll     |
| **TIER 2** | Value       | Yellow-green movement, risk 3–5, BET or CONSIDER. Solid play. | 1% of bankroll     |
| **TIER 3** | Speculative | Yellow movement, risk 5–7, usually CONSIDER.                  | Skip or 0.25% max  |
| **TIER 4** | Avoid       | Red movement, risk 7+, PASS call. Do not bet.                 | 0% — no exceptions |

Full methodology, weight tables, and the tier assignment lookup in [docs/METHODOLOGY.md](docs/METHODOLOGY.md). Backtesting results in [docs/BACKTESTING.md](docs/BACKTESTING.md).

## 🔌 Integrations

See [Quick Start](#quick-start) for Hermes Agent setup. The MCP is self-documenting — agents call `get_started` to discover the right workflow.

### Discord / Telegram Alerts

The [Positive EV Command Center](https://github.com/j17drake/positive-ev-command-center) is a companion project that monitors PropProfessor for high-EV slips and plays, then pushes them to Discord and Telegram in real-time. It uses the same auth session and API client.

### CLI

`pp-query` is a standalone CLI for one-off queries without an MCP client:

```bash
pp-query screen --league NBA --market Moneyline
pp-query recommended --leagues NBA,MLB
pp-query login
pp-query doctor
```

## 📈 Backtesting

**TL;DR:** The infrastructure is in place. Real outcome data hasn't accumulated yet.

Two paths to validate the signal:

**1. Synthetic engine validation** — runs generated scenarios (sharp_move,
stable_no_edge, adverse) through the full pipeline to confirm the tier system
actually differentiates quality:

```bash
node scripts/backtest-synthetic.js
```

**2. Real outcome backtest** — snapshot-based, since the PropProfessor API does
not serve historical settled results. Take a pre-game odds snapshot daily, then
resolve outcomes as games settle:

```bash
# capture today's recommended plays
node scripts/daily-snapshot.js
# after games settle, apply win/loss/push via CSV
node scripts/resolve-outcomes.js --csv results.csv
# compute P&L, ROI, Sharpe, max drawdown from resolved data
node scripts/backtest.js --metrics data/snapshots.jsonl
```

The pipeline (`daily-snapshot.js` → settle games → `resolve-outcomes.js` →
`backtest.js --metrics`) is built and tested (8 pipeline tests, 0 fail). What's
missing: **real settled-results data**. The synthetic tier-validation run shows
a TIER 1 hit rate of **51.4% over N=296 simulated samples** — these validate
the ranking engine, they do NOT prove profitability.

> **Honesty:** tier/kaiCall/edge/screenScore are signal-quality ratings, not
> win-probability predictions. Profitability is UNPROVEN — no settled-results
> backtest has been published yet. The system surfaces what sharp books are
> doing; it doesn't come with a bundled historical results feed. Don't trust a
> win rate you can't trace to settled bets. See [docs/BACKTESTING.md](docs/BACKTESTING.md).

## ❓ FAQ

**Does this tell me what to bet?** No. It surfaces what sharp books are doing. The betting decision is yours.

**Do I need a PropProfessor account?** Yes. Live data requires a paid subscription at [propprofessor.com](https://propprofessor.com).

**What books does it cover?** 36 sportsbooks across 10 leagues. Sharp cross-reference: Pinnacle, Circa, BookMaker, BetOnline.

**Is it free?** Code is MIT-licensed. Data requires a paid PropProfessor subscription. No paid tier of the MCP itself.

**Can I run it without an MCP client?** Yes — `pp doctor` is a standalone CLI.

**What if I find a bug?** Run `pp doctor` first, then [open an issue](https://github.com/j17drake/propprofessor-mcp/issues).

## ⭐ Support

This is free, MIT-licensed software. If it saves you time or makes you money:

- ⭐ Star the repo — helps others find it
- 🐛 [Open an issue](https://github.com/j17drake/propprofessor-mcp/issues) when you find a bug
- 💸 [Sponsor on GitHub](https://github.com/sponsors/j17drake) — funds ongoing development

No paid tier. No upsell. The whole codebase is open and the priority is making it better for the people who use it.

## 🔧 For Maintainers

```bash
npm test              # 1396 tests, 0 failures
npm run test:coverage # ~82% statements
npm run lint          # clean
npm run format:check  # clean (npm run format to fix)
npm run check:version # verifies package.json ↔ CHANGELOG
npm run smoke:live    # end-to-end live smoke (requires auth.json)
```

Release: push a `v*` tag → CI runs lint + tests on Node 20 + 22 → auto-creates the GitHub release.

### Docs index

- [Quick Start](README.md#quick-start) — install, auth, MCP client configs, troubleshooting
- [Auth & Session Management](README.md#mcp-client-setup) — auth flow, session management
- [CLI Reference](README.md#cli--pp) — `pp` command reference
- [CONFIG.md](CONFIG.md) — env vars, book config
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to add a tool
- [MAINTAINERS.md](MAINTAINERS.md) — release process
- [docs/METHODOLOGY.md](docs/METHODOLOGY.md) — full ranking methodology
- [docs/BACKTESTING.md](docs/BACKTESTING.md) — tier validation
- [docs/agent-guide.md](docs/agent-guide.md) — the 5 patterns every AI agent needs
- [docs/MARKET-BOOK-AVAILABILITY.md](docs/MARKET-BOOK-AVAILABILITY.md) — book/market matrix
- [docs/AGENT_PROMPT.md](docs/AGENT_PROMPT.md) — system prompt for agents
- [docs/RELEASES.md](docs/RELEASES.md) — full release history

## 📝 License

[MIT](LICENSE). PropProfessor is a paid service; this MCP is an unofficial client built by [j17drake](https://github.com/j17drake), not affiliated with PropProfessor.
