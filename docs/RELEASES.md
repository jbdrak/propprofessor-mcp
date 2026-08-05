# Release History

Curated "what's new" highlights for PropProfessor MCP releases. The authoritative version-by-version release history lives in [CHANGELOG.md](../CHANGELOG.md).

---

## What's new (v2.2.0)

- **`ask` tool** — natural language query parser exposed as an MCP tool. Agents parse user queries ("best plays on Fliff") into structured `{ league, book, market }` + suggested tool/args. No data is fetched by `ask` itself — it's a pure parser + router.
- **`quick_screen` tool** — generalised `novig_screen` that accepts any `books` param. Runs `sharp_plays` + `player_context` for any target book (not just NoVigApp). Defaults to NoVigApp for backward compatibility. `novig_screen` now delegates to `quick_screen`.
- **`book` field on `recommended_bets`** — each play now includes the execution book (from the user's `books` param). Agents can now answer "what's available on Fliff" directly from `recommended_bets` output.
- **`focusBook` on `recommended_bets` top-level response** — the response now surfaces which book was targeted, making it discoverable without parsing individual plays.
- 27 total tools (was 25, +`ask` + `quick_screen`)
- Tests: TBD

---

## What's new (v2.1.8)

- **Player-context research as a first-class pre-flight** — `includeResearch: true` is now an opt-in flag on `screen_ranked` and `recommended_bets`. When set, the system runs `player_context` on the top N ranked rows (default 10, configurable via `researchLimit`, max 50) and attaches a `research` array with `riskFlag` (low/medium/high), `riskSummary`, and `topTweet` per row. Use this to surface injury/availability concerns alongside the ranked plays.
- **`riskDowngrade: true`** (pairs with `includeResearch`) — drops plays with `riskFlag='high'` from the result entirely. Without this, the risk flags are just attached metadata; with it, high-risk plays are filtered out as a hard gate. Default false.
- **New `validate_play` tool** — given a `gameId` + `selection` from a prior `screen_ranked` result, runs `get_play_details` + `player_context` + execution-quality check in one call and returns a single `BET` / `CONSIDER` / `PASS` verdict with all supporting evidence. Saves the agent from chaining 3 separate tool calls to validate a single play. Pass `skipResearch: true` for ultra-fast validation when you only need the odds/execution check.
- 25 total tools (was 24; +`validate_play`)
- All 924 tests passing (was 866)

> **Example workflow** (post-v2.1.8): `screen_ranked({ books: ['Fliff'], playableOnly: true, includeResearch: true, riskDowngrade: true, researchLimit: 10 })` returns the top 10 Fliff plays at executable prices, with player-context research attached, and any high-risk play already filtered out. The agent just needs to look at the verdict and riskFlag for each play.

> **Tennis-specific news (atptour.com / wtatennis.com) deferred to v2.1.9.** The current `player_context` uses X/Google News/ESPN, which is thin for tennis players specifically. Adding tour-website scraping is the next quality-of-life improvement.

---

## What's new (v2.1.7)

- **`screen_ranked` augments the backend query with the league's sharp-book set** — `scripts/server/handlers.js:793`. The `runLeagueScreen` helper (used by `sharp_plays`) already did this, but the standalone `screen_ranked` handler shipped with its own copy of the same logic that didn't. Symptom: every `screen_ranked` call on a non-sharp book (e.g. `books: ['Fliff']`) returned `consensusBookCount: 0` on every row, making the ranker effectively useless. After the fix, the sharp books are queried alongside the user's book, consensus data populates, and the ranker produces real tier calls.
- **`requirePreferredBook` ranker gate** — `lib/screen-ranker.js`. New option that drops rows where the user-requested book doesn't have a price in the row's `oddsMap`. Previously, when you asked for `books: ['Fliff']` and a match had only Pinnacle / Polymarket / Kalshi odds (no Fliff), the ranker fell through to the row's source book and reported Pinnacle's line as if it were Fliff's. Now those rows are dropped. A user asking "what should I bet on Fliff" gets plays that Fliff actually prices. Set automatically by `screen_ranked` and `runLeagueScreen` whenever the user passes an explicit `books` list; legacy behavior preserved when the user doesn't pass a book (uses preset default with the standard fallback).
- **First direct unit tests for the ranker** — `test/screen-ranker.test.js` (6 new tests). The ranker was the most complex file in the project (916 LOC) without a direct test before this release; the only coverage was via handler-integration tests, which catch output regressions but not ranker-internal logic. Tests cover the happy path, the `requirePreferredBook` drop, the legacy fallback, and the v2.1.6 `allBookOdds` reconstruction.
- 24 total tools (unchanged)
- All 924 tests passing (was 866)

> **New `playableOnly` flag** (added 2026-06-15 patch): pass `playableOnly: true` to `screen_ranked` to get rows where the user-requested book is within the normal market range (`executionQuality != "bad"`) even when `consensusEdge` is negative or zero. Default behavior still requires positive consensus edge for TIER 1-3 plays. Use this when you want signals on a specific book (e.g. Fliff) at executable prices, not just positive-EV opportunities. See the "playable, not best" note in the v2.1.7 release notes for the full rationale.

---

## What's new (v2.1.6)

- **Consensus-preservation fix** — `extractScreenRows` in `lib/screen-parser.js` was clobbering the full per-book odds map on expanded rows, causing every main-line screen row to cascade to `consensusBookCount: 0 / TIER 4 / PASS`. Live screen, `get_play_details`, `recommended_bets`, and `sharp_plays` calls all came back with `consensusEdge: null`, `executionQuality: "unknown"`, `screenScore: 0`, `gatePassed: false`. With this fix, `consensusBookCount` returns 5–19, `consensusStrength` reads "strong", and rows can now reach TIER 1–3.
- **3 new regression tests** in `test/propprofessor-analysis.test.js` — live-shape fixture mirroring the actual `/screen` payload, v2.1.2 fallback preservation, and per-book `odds` contract preservation. Prevents recurrence of the consensus cascade.
- 24 total tools (unchanged)
- All 924 tests passing (was 843)

---

## What's new (v2.1.5)

- **Vercel 429 self-heal** — `fetchAccessToken()` in `lib/propprofessor-auth.js` now automatically falls back to a Chrome DevTools Protocol fetch from a logged-in browser tab when the server-to-server `got-scraping` path is 429'd by Vercel's TLS-fingerprint challenge. No cron, no external schedule — the MCP heals itself on the next request. Failure mode shrinks from "anyone betting during Vercel gating" to "Chrome not running AND Vercel gating" (i.e. "I'm not at my Mac").
- **CDP fallback gated by `PP_NO_CDP_FALLBACK=1`** for headless / CI environments.
- **Watchdog cron is no longer required.** `scripts/pp-token-watchdog.js` stays in the repo as a manual escape hatch for diagnostics; you can remove any `*/5 18-23 * * *` cron driving it.
- 24 total tools (unchanged)
- Test count: 843 at v2.1.5 release (was 826 at v2.1.4)

---

## What's new (v2.1.1)

- **Fantasy Optimizer tool** — new `fantasy_optimizer` MCP tool for DFS-style fantasy picks. Requires a paid PropProfessor subscription with Fantasy Optimizer access. Query by league, fantasy app, market, min/max odds/value, and more.
- **Spread-alias regression fix** — `MARKET_ALIASES.spread` and `.handicap` for NBA/WNBA/NCAAB/NCAAF/NFL/Soccer now correctly resolve to `"Point Spread"` (the live `/screen` canonical name). Previously these markets returned empty payloads.
- **Auth file permissions tightened** — `pp-query login`, `installAuthFile`, and the token cache now write `0o600` (owner-only) and `chmod` to enforce it on existing files. June 8 SEC-003 fix.
- 24 total tools now exposed via MCP
- All tests passing (see [CHANGELOG.md](../CHANGELOG.md) for the count at the time of release)
