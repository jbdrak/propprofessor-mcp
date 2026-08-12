# Hermes Plugin Conversion (Option B) — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make PropProfessor MCP installable as a single-command Hermes "plugin" — keep the Node MCP server (don't break Claude Desktop/Cursor compatibility), add a `make install` flow that wires up the MCP server, the coach skill, the default config, and the `pp` CLI binary in one shot. Apollo-style polish without the language switch.

**Architecture:** Stay MCP (Option B from prior discussion). Add an `install.py` + `Makefile` that wire `hermes mcp add` + skill symlinks + default config in one command. Ship a `propprofessor-coach` skill inside the repo so it lives next to the code (the existing `propprofessor-mcp` skill is in `~/.hermes/skills/` and shouldn't be the coach skill — it's a developer reference, not an operator coach). Extend `pp-query` with a `pp` binary for common operations. Document the new flow as the README's lead.

**Tech Stack:** Node.js 18+ (existing MCP server, no language change), Python 3.11+ (install.py — Apollo borrowed this for cross-Hermes-profile compatibility), Make (Makefile — also Apollo pattern), shell (cron helper). Hermes 0.14+ MCP config + skills.external_dirs support.

**Non-Goals (YAGNI):**

- Do NOT convert to a Python `pip install`-able plugin with entry_points. Apollo's pattern is Python-specific and would require maintaining two repos.
- Do NOT add a `~/.hermes/propprofessor.db` local store. Auth already lives at `~/.propprofessor/auth.json`; if we add storage later, it goes there.
- Do NOT change the MCP tool surface (23 tools, 784 tests passing). Pure packaging work.

---

## Phase 0: Verify current state (5 min)

> Verify the repo actually looks the way the plan assumes. If anything has drifted, surface it before writing tasks that depend on stale assumptions.

### Task 0.1: Confirm repo state

**Files:** none (read-only)

**Step 1:** Run from repo root

```bash
cd ~/Documents/workspace/propprofessor-mcp
git status --short
git log --oneline -1
node -e "console.log(require('./package.json').version)"
```

**Expected:** Clean tree (or only known dirty files), HEAD on a v2.0.x commit, version prints `2.0.1`.

**Step 2:** Confirm MCP server boots

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}' \
  | node scripts/propprofessor-mcp-server.js | head -1
```

**Expected:** JSON-RPC success response with `serverInfo.name === "propprofessor"`.

**Step 3:** Confirm hermes config has propprofessor wired

```bash
grep -A 8 "propprofessor:" ~/.hermes/config.yaml
```

**Expected:** Block with `command: node` and `args: ["/Users/jamesdrake/.../propprofessor-mcp-server.js"]` and env vars `AUTH_FILE` + `PROPPROFESSOR_MCP_NDJSON`.

**Step 4:** If any check fails, STOP. Surface the discrepancy to the user before continuing.

**Step 5:** Commit (no changes — this is verification only).

### Task 0.2: Survey existing skills

**Files:** none (read-only)

**Step 1:** List existing propprofessor skills

```bash
ls -la ~/.hermes/skills/software-development/propprofessor-*/
```

**Expected:** Three skills — `propprofessor-mcp` (78KB, the developer reference), `propprofessor-mcp-release-format`, `propprofessor-backtest-runner`.

**Step 2:** Confirm `propprofessor-mcp` is the developer skill (not a coach)

```bash
head -20 ~/.hermes/skills/software-development/propprofessor-mcp/SKILL.md
```

**Expected:** Description starts with "Work with the PropProfessor MCP server" — this is the dev reference, not a coach. The coach skill we'll build is separate.

**Step 3:** Note for plan: the existing dev skill stays in `~/.hermes/skills/` (unchanged). The new coach skill ships in the repo and gets symlinked via `make install`.

---

## Phase 1: Coach skill (the big unlock)

> This is the highest-leverage piece. Apollo's `health-coach` skill is what makes normal questions auto-route correctly. Without it, the model has to guess which tool to call. With it, "what should I bet today?" reliably triggers `recommended_bets` + `player_context` + tier formatting.

### Task 1.1: Create skill directory structure

**Files:**

- Create: `skills/propprofessor-coach/SKILL.md`

**Step 1:** Make the directory

```bash
mkdir -p skills/propprofessor-coach
```

**Step 2:** Verify

```bash
ls -la skills/
```

**Expected:** `propprofessor-coach/` exists.

### Task 1.2: Write the coach skill frontmatter

**Files:**

- Modify: `skills/propprofessor-coach/SKILL.md` (create with content below)

**Step 1:** Write the file. Full content (no placeholders):

```markdown
---
name: propprofessor-coach
description: "Operator-facing PropProfessor coach. For any question about today's bets, sharp money, line shopping, player props, or bet tracking — load this skill FIRST to pick the right MCP tools and tier formatting. Pairs with the dev reference skill `propprofessor-mcp` for tool internals."
version: 1.0.0
author: James Drake (Kai)
tags: [sports-betting, mcp, propprofessor, coach, sharp-money, line-shopping, audited-2026-06]
---

# PropProfessor Coach

You are the PropProfessor operator coach. Users ask you questions about sports betting and you answer them by calling the right MCP tools in the right order, then formatting the results in the standard tier format.

## When this skill loads

This skill auto-loads when a user's question contains any of:

- "what should I bet today" / "best plays today" / "today's picks"
- "sharp money" / "steam move" / "line movement"
- "best price" / "line shop" / "where to bet"
- "player prop" / "prop bet"
- "tier 1" / "tier 2" / "tier 3" / "tier 4"
- "log this bet" / "track this pick" / "my record"
- Any question referencing a specific book (Fliff, NoVigApp, FanDuel, DraftKings, etc.)

**Do NOT load** for: tool-internals questions, code changes to the MCP server, release workflow. Those go to `propprofessor-mcp`.

## Tool routing table

| User intent                                | First tool to call                                                                          | Then                                  | Notes                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| "best plays today" / "what should I bet"   | `mcp_propprofessor_recommended_bets` (default TIER 1+2, markets=[Moneyline, Spread, Total]) | format with tier table                | If empty slate → call `mcp_propprofessor_sharp_plays` with `strict: false` for the next-best set |
| "sharp money on [team/player]"             | `mcp_propprofessor_sharp_consensus` filtered to that entity                                 | format movement + consensus           | Multi-window sharp signal                                                                        |
| "steam move"                               | `mcp_propprofessor_steam_move` (or `mcp_propprofessor_get_alerts`)                          | format steam details                  | Multi-book agreement                                                                             |
| "best price for [team] [line]"             | `mcp_propprofessor_find_best_price`                                                         | format price table                    | Cross-book comparison                                                                            |
| "line shop [game]"                         | `mcp_propprofessor_find_best_price` for each market                                         | format side-by-side                   | Markets: Moneyline, Spread, Total                                                                |
| "player prop for [player] [market] [line]" | `mcp_propprofessor_player_context` first (injury/news check)                                | then `mcp_propprofessor_opinion`      | NEVER bet without context check                                                                  |
| "log this bet"                             | `mcp_propprofessor_log_pick`                                                                | confirm with pick ID                  | Returns UUID for later resolve                                                                   |
| "my record" / "how am I doing"             | `mcp_propprofessor_get_pick_stats`                                                          | format win rate + P&L                 | Optional: `days` filter                                                                          |
| "hide this bet from fantasy"               | `mcp_propprofessor_hide_bet`                                                                | confirm hidden                        | Use betId from prior response                                                                    |
| "show hidden bets"                         | `mcp_propprofessor_get_hidden_bets`                                                         | list                                  |                                                                                                  |
| "is [book] sharp on this?"                 | `mcp_propprofessor_screen` filtered to that book                                            | cross-reference with sharp books list | Sharp books: Pinnacle, BetOnline, Circa, BookMaker, 4cx, OnyxOdds, Kalshi, Polymarket, NoVigApp  |

## Tier format (MANDATORY for any bet recommendation)

When presenting plays, ALWAYS use this format. The user expects this layout — deviations break their workflow.
```

## TIER 1 (Best — sharp consensus + edge)

| #   | Game | Selection | Odds | Edge | Book | Rationale |
| --- | ---- | --------- | ---- | ---- | ---- | --------- |

## TIER 2 (Strong — supportive movement)

| #   | Game | Selection | Odds | Edge | Book | Rationale |
| --- | ---- | --------- | ---- | ---- | ---- | --------- |

## TIER 3 (Speculative — single-book signal, lower trust)

| ... |

## TIER 4 (Avoid — failed screening, included for transparency)

| ... |

```

- `Edge` from `recommended_bets[].edge` (decimal). Display as percentage: `* 100`, round to 1 decimal.
- `Rationale` from the tool's `rationale` field — DO NOT invent your own.
- If a tier has 0 plays, omit the section entirely. Don't show empty tables.
- Always include `TIE`r 4 only if `markets_queried` returned anything in that bucket (rare, mostly for transparency).

## Risk flag escalation

Before recommending ANY player prop:
1. Call `mcp_propprofessor_player_context` with the player name.
2. If `riskFlag === "high"`, downgrade the tier by 1 (TIER 2 → TIER 3) and add `⚠️ high risk` to the rationale.
3. If `riskFlag === "high"` AND the original tier was TIER 3 or 4, SKIP the play entirely. Note the skip in the response.

## Staking

For bankroll-based stake allocation, call `mcp_propprofessor_staking_plan` with `bankroll` (user's stated bankroll, default 1000). Uses fractional Kelly: TIER 1 = 2%, TIER 2 = 1%. Surface the per-play stake.

## Common failure modes (avoid these)

- **Empty slate panic.** A quiet slate with 0 TIER 1/2 plays is NORMAL. Don't pivot to "no bet today" — try `sharp_plays(strict: false)` first, or pivot to a different sport.
- **Moneyline bias.** `recommended_bets` already scans Moneyline + Spread + Total. If Spread/Total return fewer plays, it's because the upstream API has fewer books posting those markets (see `MARKET-BOOK-AVAILABILITY.md`). The `marketsBreakdown` field makes this transparent — surface it.
- **NoVigApp consensus gap.** `sharp_plays(targetBooks=["NoVigApp"])` may return 0 rows because NoVigApp's no-vig lines never match other books exactly. Add a fallback to `consensusEdge` if `consensusBookCount` is 0.
- **Tiafoe-style "no bet" wrong answer.** The user has explicit warnings about agents that declare "no bet today" on slates that have 20+ plays. If `recommended_bets` returns 0, your next call is `sharp_plays(strict: false)`, not "no bet today."

## Related skills

- `propprofessor-mcp` — developer reference (tool internals, code patterns). Load for code questions, NOT for user questions.
- `pp-sports` — operator workflow (this skill's sibling, used by James's daily picks flow).
- `propprofessor-backtest-runner` — backtest-specific workflow.

## Coverage / privacy guardrails

- The MCP server needs an active PropProfessor auth file at `~/.propprofessor/auth.json`. If you see auth errors, tell the user to run `pp-query login` (or `pp doctor` to diagnose).
- Don't share pick UUIDs externally — they're tied to the user's local bet log.
```

**Step 2:** Verify the file is valid

```bash
head -10 skills/propprofessor-coach/SKILL.md
wc -l skills/propprofessor-coach/SKILL.md
```

**Expected:** Frontmatter is YAML, total ~110-130 lines.

**Step 3:** Commit

```bash
git add skills/propprofessor-coach/SKILL.md
git commit -m "feat(skill): add propprofessor-coach operator skill"
```

### Task 1.3: Add skill to package.json `files`

**Files:**

- Modify: `package.json` (add `skills/` to the `files` array)

**Step 1:** Read current `files` array

```bash
node -e "console.log(JSON.stringify(require('./package.json').files, null, 2))"
```

**Step 2:** Patch package.json

```json
"files": [
  "lib/",
  "scripts/",
  "skills/",
  "README.md",
  "SETUP.md",
  "AUTH.md",
  "CONFIG.md",
  "MAINTAINERS.md",
  "CHANGELOG.md",
  "LICENSE"
]
```

**Step 3:** Verify

```bash
node -e "console.log(JSON.stringify(require('./package.json').files, null, 2))"
```

**Expected:** `"skills/"` is in the array.

**Step 4:** Commit

```bash
git add package.json
git commit -m "chore(package): ship skills/ directory in npm tarball"
```

### Task 1.4: Add skill-installation logic to a helper script

> We're going to need this logic in three places: install.py, Makefile, and the test suite. Put it in a small Python helper that all three call.

**Files:**

- Create: `scripts/install_helpers.py`
- Create: `scripts/test_install_helpers.py`

**Step 1:** Write failing test

```python
# scripts/test_install_helpers.py
import os
import tempfile
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parent))
from install_helpers import resolve_hermes_home, resolve_active_profile, skill_target_path

def test_resolve_hermes_home_uses_env(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert resolve_hermes_home() == tmp_path

def test_resolve_hermes_home_falls_back_to_default(monkeypatch, tmp_path):
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    assert resolve_hermes_home() == tmp_path / ".hermes"

def test_resolve_active_profile_default(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert resolve_active_profile(str(tmp_path)) == "default"

def test_resolve_active_profile_from_config(monkeypatch, tmp_path):
    (tmp_path / "config.yaml").write_text("agent:\n  active_profile: work\n")
    assert resolve_active_profile(str(tmp_path)) == "work"

def test_skill_target_path(tmp_path):
    target = skill_target_path(str(tmp_path), "default", "propprofessor-coach")
    assert target == tmp_path / "profiles" / "default" / "skills" / "external" / "propprofessor-coach"
```

**Step 2:** Run test, verify it fails

```bash
cd ~/Documents/workspace/propprofessor-mcp
python3 -m pytest scripts/test_install_helpers.py -v 2>&1 | head -20
```

**Expected:** `ModuleNotFoundError: No module named 'install_helpers'`.

**Step 3:** Implement the helper

```python
# scripts/install_helpers.py
"""Shared helpers for hermes install flows. No external deps — stdlib only."""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path


def resolve_hermes_home() -> Path:
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env).expanduser().resolve()
    return (Path.home() / ".hermes").resolve()


def resolve_active_profile(hermes_home: str | Path) -> str:
    """Read the active profile from config.yaml. Falls back to 'default'.

    Note: hermes currently loads skills from <HERMES_HOME>/skills/ regardless
    of profile (see hermes_constants.get_skills_dir). Profile-aware skill dirs
    are a planned future — this helper reads the configured profile for
    completeness but install_skill does NOT currently use it for pathing.
    Track: https://github.com/NousResearch/hermes-agent — search 'external_dirs'
    and 'profile' to confirm the contract before wiring profile-aware paths.
    """
    config_path = Path(hermes_home) / "config.yaml"
    if not config_path.exists():
        return "default"
    text = config_path.read_text()
    # Simple regex — avoids requiring PyYAML in the installer.
    match = re.search(r"active_profile:\s*['\"]?([A-Za-z0-9_-]+)", text)
    return match.group(1) if match else "default"


def skill_target_path(hermes_home: str | Path, profile: str, skill_name: str) -> Path:
    # Hermes loads skills from <HERMES_HOME>/skills/<name>/ (NOT
    # <HERMES_HOME>/profiles/<profile>/skills/...) — see hermes_constants.get_skills_dir
    # and config.yaml schema 'skills.external_dirs'. The profile arg is kept for
    # signature stability but unused; hermes has a single global skills dir.
    del profile  # intentionally unused — see docstring above
    return Path(hermes_home) / "skills" / skill_name


def hermes_bin() -> str:
    """Locate the hermes binary. The venv at ~/.hermes/hermes-agent/venv/bin/hermes
    is the real binary; ~/.local/bin/hermes is a thin wrapper that's not always on
    PATH for cron / sub-spawned shells. Prefer the venv path."""
    candidates = [
        Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "hermes",
        Path("/opt/homebrew/bin/hermes"),
        Path("/usr/local/bin/hermes"),
    ]
    for c in candidates:
        if c.exists() and os.access(c, os.X_OK):
            return str(c)
    return "hermes"  # last resort — hope it's on PATH


def run_hermes(args: list[str], check: bool = True) -> int:
    import subprocess
    cmd = [hermes_bin(), *args]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if check and result.returncode != 0:
        print(result.stdout, file=sys.stdout)
        print(result.stderr, file=sys.stderr)
        raise SystemExit(f"hermes {' '.join(args)} failed (exit {result.returncode})")
    return result.returncode


if __name__ == "__main__":
    # CLI: python3 scripts/install_helpers.py skill-path <profile> <name>
    if len(sys.argv) >= 4 and sys.argv[1] == "skill-path":
        print(skill_target_path(resolve_hermes_home(), sys.argv[2], sys.argv[3]))
```

**Step 4:** Run test, verify it passes

```bash
python3 -m pytest scripts/test_install_helpers.py -v
```

**Expected:** 5 passed.

**Step 5:** Commit

```bash
git add scripts/install_helpers.py scripts/test_install_helpers.py
git commit -m "feat(install): add shared hermes install helpers (stdlib only)"
```

### Task 1.5: Wire skill symlink into a `make install-skill` target

**Files:**

- Create: `Makefile`

**Step 1:** Write the Makefile

```makefile
.PHONY: install install-skill install-mcp install-cron install-all doctor uninstall clean test lint format

# Resolve the absolute path to the repo root.
REPO_ROOT := $(shell pwd)
PYTHON ?= python3

# Default: full one-command install.
install: install-skill install-mcp
	@echo ""
	@echo "✓ PropProfessor installed. Try: pp-query doctor"

install-skill:
	@echo "→ Linking propprofessor-coach skill into hermes..."
	@$(PYTHON) scripts/install.py skill

install-mcp:
	@echo "→ Registering propprofessor MCP server with hermes..."
	@$(PYTHON) scripts/install.py mcp

install-cron:
	@echo "→ Registering sharp-money alert cron job..."
	@$(PYTHON) scripts/install.py cron

install-all: install install-cron

doctor:
	@pp-query doctor

uninstall:
	@echo "→ Removing propprofessor from hermes..."
	@$(PYTHON) scripts/install.py uninstall

clean:
	@rm -rf node_modules coverage

test:
	@npm test

lint:
	@npm run lint

format:
	@npm run format
```

**Step 2:** Commit

```bash
git add Makefile
git commit -m "feat(install): add Makefile with install/uninstall targets"
```

> Note: `install-skill` and `install-mcp` both call `scripts/install.py` with subcommands. The actual installer is built in Phase 3. For now, this target will fail with a "no such file" error — that's fine, Phase 3 fills it in. We ship the Makefile target shape first so the user's mental model is right.

---

## Phase 2: `pp` wrapper binary

> Hermes auto-discovers anything in `$PATH` as a tool. Today we ship `pp-mcp` and `pp-query`. The `pp` binary is a thin dispatcher that exposes common operations (hide bet, list hidden, sync, doctor) in a way that's ergonomic from any shell or cron job.

### Task 2.1: Design the `pp` subcommand surface

**Files:** none (decision document)

**Step 1:** Decide which subcommands `pp` should expose. List:

- `pp hide <bet-id>` — hide a bet from the fantasy table
- `pp unhide <id>` — restore visibility
- `pp hidden` — list currently hidden bets
- `pp sync` — run a full sync (calls `pp-query health` + a re-fetch of recommended_bets; caches to `~/.propprofessor/sync-cache.json`)
- `pp doctor` — alias for `pp-query doctor` (already exists)
- `pp today` — alias for `pp-query sport nba` with the default user's league preference (reads from `~/.propprofessor/config.json`)

**Step 2:** All of these are sub-3-second shellouts to existing `pp-query` commands. No new logic in the MCP server.

### Task 2.2: Implement `bin/pp`

**Files:**

- Create: `bin/pp`
- Modify: `package.json` (add `pp` to `bin`)

**Step 1:** Write the wrapper

```javascript
#!/usr/bin/env node
'use strict';

/**
 * pp — ergonomic CLI dispatcher for PropProfessor.
 *
 * Thin shellout to pp-query for common operations. Designed to be on $PATH
 * after `npm link` so cron jobs, shell scripts, and the user can call it
 * without thinking about pp-query's argument grammar.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const PP_QUERY = path.join(REPO_ROOT, 'scripts', 'query-propprofessor.js');

const COMMANDS = {
  hide: { ppArgs: () => ['hide-bet', '--json'] }, // hidden: wire in 2.4
  unhide: { ppArgs: () => ['unhide-bet', '--json'] },
  hidden: { ppArgs: () => ['get-hidden-bets', '--json'] },
  sync: { ppArgs: () => ['health', '--json'] },
  doctor: { ppArgs: () => ['doctor'] },
  today: { ppArgs: () => ['sport', 'nba', '--limit', '5'] }
};

function printHelp() {
  console.log(`pp — PropProfessor quick commands

Usage: pp <command> [args]

Commands:
  hide <bet-id>     Hide a bet from the fantasy table
  unhide <id>       Restore visibility to a hidden bet
  hidden            List currently hidden bets
  sync              Run a health check + data refresh
  doctor            Run first-time setup checks
  today             Show today's top NBA plays (default league)

All other commands are passed through to pp-query:
  pp <anything-else>  →  pp-query <anything-else>

Run 'pp-query list' for the full pp-query command inventory.
`);
}

function main() {
  const [, , sub, ...rest] = process.argv;

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }

  let args;
  if (COMMANDS[sub]) {
    args = [...COMMANDS[sub].ppArgs(...rest), ...rest];
  } else {
    // Pass-through to pp-query.
    args = [sub, ...rest];
  }

  const child = spawn(process.execPath, [PP_QUERY, ...args], {
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code) => process.exit(code ?? 1));
  child.on('error', (err) => {
    console.error(`pp: failed to spawn pp-query: ${err.message}`);
    process.exit(1);
  });
}

main();
```

**Step 2:** Make it executable

```bash
chmod +x bin/pp
```

**Step 3:** Verify it runs

```bash
./bin/pp help
```

**Expected:** Prints the help text.

**Step 4:** Add to `package.json` bin

```json
"bin": {
  "pp-mcp": "scripts/propprofessor-mcp-server.js",
  "pp-query": "scripts/query-propprofessor.js",
  "pp": "bin/pp"
}
```

**Step 5:** Test the pass-through

```bash
./bin/pp list
```

**Expected:** Prints the `pp-query` command inventory.

**Step 6:** Commit

```bash
git add bin/pp package.json
git commit -m "feat(cli): add `pp` wrapper binary for common operations"
```

### Task 2.3: Add a test for the `pp` wrapper

**Files:**

- Create: `test/test-pp-wrapper.js`

**Step 1:** Write the test

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const PP_BIN = path.resolve(__dirname, '..', 'bin', 'pp');

test('pp help prints usage', () => {
  const result = spawnSync(process.execPath, [PP_BIN, 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /pp — PropProfessor quick commands/);
  assert.match(result.stdout, /hide <bet-id>/);
  assert.match(result.stdout, /today/);
});

test('pp with no args prints help', () => {
  const result = spawnSync(process.execPath, [PP_BIN], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: pp <command>/);
});

test('pp unknown command passes through to pp-query', () => {
  // 'list' is a real pp-query command — should work via pass-through.
  const result = spawnSync(process.execPath, [PP_BIN, 'list'], { encoding: 'utf8' });
  // Don't assert exit code (list is a real command, exits 0; the point is no crash)
  assert.ok(result.stdout.length > 0, 'pp list should produce output');
});
```

**Step 2:** Run

```bash
node --test test/test-pp-wrapper.js
```

**Expected:** 3 passing.

**Step 3:** Add to the `test` script in `package.json` if not already covered

```bash
grep '"test"' package.json
```

If the test script doesn't pick up `test/test-pp-wrapper.js`, add a glob. (Likely it already runs `node --test test/`.)

**Step 4:** Commit

```bash
git add test/test-pp-wrapper.js
git commit -m "test(cli): cover pp wrapper help + pass-through"
```

---

## Phase 3: install.py + Makefile integration

> The actual installer. Idempotent — re-running `make install` should be a no-op, not an error.

### Task 3.1: Write `scripts/install.py` (skeleton)

**Files:**

- Create: `scripts/install.py`

**Step 1:** Write the skeleton with subcommand dispatch

```python
#!/usr/bin/env python3
"""PropProfessor hermes install script.

Subcommands:
  skill     Symlink skills/propprofessor-coach into hermes skills/external/.
  mcp       Register the propprofessor MCP server with hermes.
  cron      Register the sharp-money alert cron job.
  uninstall Reverse all of the above.
  all       Run skill + mcp (the default).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow `python3 scripts/install.py` to import install_helpers.py from the same dir.
sys.path.insert(0, str(Path(__file__).parent))
from install_helpers import (  # noqa: E402
    resolve_hermes_home,
    resolve_active_profile,
    skill_target_path,
    run_hermes
)


REPO_ROOT = Path(__file__).resolve().parent.parent
SKILL_NAME = "propprofessor-coach"
SKILL_SOURCE = REPO_ROOT / "skills" / SKILL_NAME
MCP_NAME = "propprofessor"
MCP_SERVER_PATH = REPO_ROOT / "scripts" / "propprofessor-mcp-server.js"
AUTH_FILE_DEFAULT = Path.home() / ".propprofessor" / "auth.json"


def install_skill() -> None:
    hermes_home = resolve_hermes_home()
    profile = resolve_active_profile(hermes_home)
    target = skill_target_path(hermes_home, profile, SKILL_NAME)

    if not SKILL_SOURCE.exists():
        raise SystemExit(f"Skill source not found: {SKILL_SOURCE}")

    target.parent.mkdir(parents=True, exist_ok=True)

    if target.is_symlink() or target.exists():
        if target.is_symlink() and target.resolve() == SKILL_SOURCE.resolve():
            print(f"  skill already linked: {target}")
            return
        # Real directory or wrong symlink — back it up.
        backup = target.with_suffix(target.suffix + ".bak")
        backup.mkdir(exist_ok=False)
        for child in target.iterdir():
            child.rename(backup / child.name)
        target.rmdir()
        print(f"  backed up existing skill to {backup}")

    target.symlink_to(SKILL_SOURCE)
    print(f"  ✓ linked {SKILL_SOURCE} → {target}")


def install_mcp() -> None:
    if not MCP_SERVER_PATH.exists():
        raise SystemExit(f"MCP server not found: {MCP_SERVER_PATH}")

    hermes_home = resolve_hermes_home()
    auth_file = AUTH_FILE_DEFAULT
    auth_file.parent.mkdir(parents=True, exist_ok=True)
    if not auth_file.exists():
        print(f"  ⚠ auth file not found at {auth_file}. Run 'pp-query login' after install.")

    # `hermes mcp add` is idempotent — re-running updates in place.
    run_hermes([
        "mcp", "add", MCP_NAME,
        "--command", "node",
        "--args", str(MCP_SERVER_PATH),
        "--env", f"AUTH_FILE={auth_file}",
        "--env", "PROPPROFESSOR_MCP_NDJSON=true"
    ])
    print(f"  ✓ registered MCP server '{MCP_NAME}' with hermes")


def install_cron() -> None:
    """Register a no-agent sharp-money alert cron (optional)."""
    from install_helpers import hermes_bin
    import subprocess
    prompt = (
        "Run `pp sync` hourly and alert via telegram if any TIER 1 play appears. "
        "Use `mcp_propprofessor_recommended_bets` to check, format with the coach skill, "
        "and deliver to the user's home telegram channel. Skip silently if no plays."
    )
    cmd = [hermes_bin(), "cron", "create", "every 1h", "--prompt", prompt, "--name", "propprofessor-alerts", "--no-agent"]
    # Use --no-agent via the no_agent flag — but that's only on the cronjob tool, not the CLI.
    # For the CLI: skip --no-agent here; the agent loop will handle delivery.
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ⚠ cron registration failed: {result.stderr}", file=sys.stderr)
    else:
        print("  ✓ registered sharp-money alert cron")


def uninstall() -> None:
    hermes_home = resolve_hermes_home()
    profile = resolve_active_profile(hermes_home)
    target = skill_target_path(hermes_home, profile, SKILL_NAME)

    if target.is_symlink() or target.exists():
        target.unlink()
        print(f"  ✓ removed skill link: {target}")

    run_hermes(["mcp", "remove", MCP_NAME], check=False)
    print(f"  ✓ removed MCP server '{MCP_NAME}'")


def main() -> int:
    parser = argparse.ArgumentParser(description="Install PropProfessor into hermes.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    for name in ("skill", "mcp", "cron", "uninstall", "all"):
        sub.add_parser(name)

    args = parser.parse_args()
    handlers = {
        "skill": install_skill,
        "mcp": install_mcp,
        "cron": install_cron,
        "uninstall": uninstall,
        "all": lambda: (install_skill(), install_mcp()),
    }
    handlers[args.cmd]()
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

**Step 2:** Make it executable

```bash
chmod +x scripts/install.py
```

**Step 3:** Smoke test

```bash
./scripts/install.py --help
./scripts/install.py skill --help 2>&1 | head -3 || true
```

**Expected:** Help text prints. (No skill subcommand help since we used `add_subparsers` without explicit help — that's fine for v1.)

**Step 4:** Commit

```bash
git add scripts/install.py
git commit -m "feat(install): add install.py with skill/mcp/cron/uninstall subcommands"
```

### Task 3.2: Test `install.py` end-to-end against a hermes fixture

**Files:**

- Create: `scripts/test_install.py`

**Step 1:** Write the test

```python
"""End-to-end test for install.py. Uses a temporary HERMES_HOME to avoid
touching the user's real config."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL = REPO_ROOT / "scripts" / "install.py"


@pytest.fixture
def fake_hermes_home(tmp_path, monkeypatch):
    """Create a minimal hermes home with config.yaml and bin/hermes stub."""
    home = tmp_path / "fake_hermes"
    (home / "config.yaml").write_text("agent:\n  active_profile: default\n")
    (home / "profiles" / "default" / "skills" / "external").mkdir(parents=True)
    bin_dir = home / "bin"
    bin_dir.mkdir()
    hermes_stub = bin_dir / "hermes"
    hermes_stub.write_text("#!/bin/sh\necho \"fake hermes $*\"\nexit 0\n")
    hermes_stub.chmod(0o755)
    monkeypatch.setenv("HERMES_HOME", str(home))
    # Prepend fake hermes to PATH so install_helpers.hermes_bin() finds it first.
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ.get('PATH', '')}")
    return home


def test_install_skill_creates_symlink(fake_hermes_home):
    result = subprocess.run(
        [sys.executable, str(INSTALL), "skill"],
        capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    target = fake_hermes_home / "profiles" / "default" / "skills" / "external" / "propprofessor-coach"
    assert target.is_symlink()
    assert target.resolve() == (REPO_ROOT / "skills" / "propprofessor-coach").resolve()


def test_install_skill_idempotent(fake_hermes_home):
    """Running twice doesn't error and doesn't create a nested symlink."""
    subprocess.run([sys.executable, str(INSTALL), "skill"], check=True)
    result = subprocess.run(
        [sys.executable, str(INSTALL), "skill"],
        capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    target = fake_hermes_home / "profiles" / "default" / "skills" / "external" / "propprofessor-coach"
    assert target.is_symlink()
    # Resolve once — should still be the source, not a nested link.
    assert target.resolve() == (REPO_ROOT / "skills" / "propprofessor-coach").resolve()


def test_install_mcp_calls_hermes(fake_hermes_home, capsys):
    result = subprocess.run(
        [sys.executable, str(INSTALL), "mcp"],
        capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    captured = capsys.readouterr()
    # The fake hermes stub echoes its args; verify it was called with mcp add propprofessor.
    assert "fake hermes mcp add propprofessor" in (result.stdout + result.stderr + captured.out)
```

**Step 2:** Run

```bash
python3 -m pytest scripts/test_install.py -v
```

**Expected:** 3 passed.

**Step 3:** Commit

```bash
git add scripts/test_install.py
git commit -m "test(install): cover install.py skill + mcp + idempotency"
```

### Task 3.3: Wire `make install` to call install.py

**Files:**

- Modify: `Makefile` (replace the placeholders from Task 1.5)

**Step 1:** The Makefile from Task 1.5 already targets `scripts/install.py skill` and `scripts/install.py mcp`. Re-verify they work.

```bash
make install-skill
make install-mcp
```

**Expected:** Both succeed and report success. (Use a real hermes home for the smoke — your own machine is fine; the script is idempotent.)

**Step 2:** Re-run

```bash
make install
```

**Expected:** Both targets run, then the "✓ PropProfessor installed" echo prints.

**Step 3:** Commit (if no Makefile changes needed beyond Task 1.5, skip)

```bash
git status
# If clean, no commit needed.
```

### Task 3.4: Verify against the live hermes install

**Files:** none (manual smoke)

**Step 1:** From the repo root

```bash
cd ~/Documents/workspace/propprofessor-mcp
make install
```

**Step 2:** Verify the skill loaded

```bash
ls -la ~/.hermes/skills/external/propprofessor-coach 2>/dev/null \
  || ls -la ~/.hermes/profiles/default/skills/external/propprofessor-coach
```

**Expected:** Symlink pointing back to the repo's `skills/propprofessor-coach/`.

**Step 3:** Verify the MCP server is registered

```bash
~/.hermes/hermes-agent/venv/bin/hermes mcp list
```

**Expected:** `propprofessor` appears in the list.

**Step 4:** Run hermes and load the skill

```bash
~/.hermes/hermes-agent/venv/bin/hermes chat -q "test load propprofessor-coach skill" 2>&1 | head -20
```

**Expected:** Skill loads (look for the skill content in the system prompt or tool routing).

**Step 5:** If anything fails, STOP. Diagnose before continuing.

---

## Phase 4: Default config + first-run experience

> The `~/.propprofessor/config.json` file gives users a place to set their default league, bankroll, and target book. Today there's no such file — settings are per-call.

### Task 4.1: Design the config schema

**Files:**

- Create: `config.default.json` (shipped, copied to `~/.propprofessor/config.json` on first install)

**Step 1:** Write the default

```json
{
  "$schema": "https://propprofessor-mcp.j17drake.com/schemas/config.schema.json",
  "version": 1,
  "auth": {
    "file": "~/.propprofessor/auth.json"
  },
  "defaults": {
    "league": "NBA",
    "market": "Moneyline",
    "bankroll": 1000,
    "targetBook": "NoVigApp",
    "lookbackHours": 6,
    "limit": 10
  },
  "alerts": {
    "telegram": false,
    "minTier": "TIER 1"
  },
  "output": {
    "verbosity": "standard",
    "includeNullFields": false,
    "maxTableWidth": 120
  }
}
```

**Step 2:** Add to `package.json` `files`

```json
"files": [
  "lib/",
  "scripts/",
  "skills/",
  "config.default.json",
  "README.md",
  ...
]
```

**Step 3:** Commit

```bash
git add config.default.json package.json
git commit -m "feat(config): add config.default.json with sensible defaults"
```

### Task 4.2: `pp-query setup` (or `pp setup`) writes the config

**Files:**

- Modify: `scripts/query-propprofessor.js` (add `setup` subcommand)

**Step 1:** Read the current main() function to see where to insert

```bash
grep -n "if (command === '" scripts/query-propprofessor.js | head -20
```

**Step 2:** Add the `setup` command handler. Insert before the `list` command:

```javascript
if (command === 'setup') {
  const CONFIG_DIR = path.join(os.homedir(), '.propprofessor');
  const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
  const DEFAULT_PATH = path.join(__dirname, '..', 'config.default.json');

  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (fs.existsSync(CONFIG_PATH)) {
    emitJson(logger, { command: 'setup', status: 'exists', path: CONFIG_PATH });
    return;
  }

  const defaults = fs.readFileSync(DEFAULT_PATH, 'utf8');
  fs.writeFileSync(CONFIG_PATH, defaults, { mode: 0o600 });
  emitJson(logger, { command: 'setup', status: 'created', path: CONFIG_PATH });
  return;
}
```

(Add `const fs = require('node:fs');` and `const path = require('node:path');` at the top of the file if not already there.)

**Step 3:** Add to `getCommandInventory()`

```javascript
{ command: 'setup', description: 'Install default config to ~/.propprofessor/config.json (idempotent)' },
```

**Step 4:** Test

```bash
node scripts/query-propprofessor.js setup
```

**Expected:** `{ "command": "setup", "status": "created", "path": "/Users/jamesdrake/.propprofessor/config.json" }`.

**Step 5:** Re-run, verify idempotency

```bash
node scripts/query-propprofessor.js setup
```

**Expected:** `{ "command": "setup", "status": "exists", "path": "..." }`.

**Step 6:** Commit

```bash
git add scripts/query-propprofessor.js
git commit -m "feat(query): add setup subcommand for default config install"
```

### Task 4.3: Wire `pp-query setup` into `make install`

**Files:**

- Modify: `scripts/install.py` (call `setup` from `install_mcp`)

**Step 1:** In `install_mcp()`, before registering the MCP server, run setup

```python
def install_mcp() -> None:
    if not MCP_SERVER_PATH.exists():
        raise SystemExit(f"MCP server not found: {MCP_SERVER_PATH}")

    # Install default config first.
    import subprocess
    setup_result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "query-propprofessor.js"), "setup"],
        capture_output=True, text=True
    )
    if setup_result.returncode == 0:
        print(f"  ✓ config: {setup_result.stdout.strip()}")
    else:
        print(f"  ⚠ config setup failed: {setup_result.stderr}", file=sys.stderr)

    # ... rest of existing install_mcp body
```

**Step 2:** Add test

```python
def test_install_mcp_creates_config(fake_hermes_home, monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))  # redirect ~/.propprofessor
    subprocess.run([sys.executable, str(INSTALL), "mcp"], check=True)
    assert (tmp_path / ".propprofessor" / "config.json").exists()
```

**Step 3:** Run the new test

```bash
python3 -m pytest scripts/test_install.py::test_install_mcp_creates_config -v
```

**Expected:** 1 passed.

**Step 4:** Commit

```bash
git add scripts/install.py scripts/test_install.py
git commit -m "feat(install): install default config as part of mcp install"
```

---

## Phase 5: Cron template + sharp money alerts

> Optional but high-leverage. Apollo's health-data-sync cron auto-fires every 6h. We can ship a similar pattern for PropProfessor — a one-shot sharp-money alert that the user opts into.

### Task 5.1: Write the cron prompt template

**Files:**

- Create: `docs/cron-prompts/sharp-money-alert.md`

**Step 1:** Write the prompt

````markdown
# Sharp-Money Alert — PropProfessor Cron Prompt

> Self-contained prompt for `hermes cron create`. Drop into a cron job that
> fires every 1-2 hours during the sports window. The agent loop loads
> `propprofessor-coach` automatically and delivers TIER 1 plays to telegram.

## Prompt

You are the sharp-money alert agent. Run a single MCP tool call:

```python
mcp_propprofessor_recommended_bets(targetTiers=["TIER 1"])
```
````

If the response is empty OR `result.plays` is an empty array:

- Stay silent. Do not post anything. The user is drowning in empty alerts.

If there are TIER 1 plays:

1. Load the `propprofessor-coach` skill for the tier-format layout.
2. For each play, call `mcp_propprofessor_player_context` to check the risk flag.
3. Format the top 3 plays as a tier table.
4. Deliver to the user's home telegram channel.
5. Include the bankroll-stake for each play via `mcp_propprofessor_staking_plan` if a bankroll is set in `~/.propprofessor/config.json`.

## Schedule

```bash
hermes cron create "every 1h" \
  --prompt "$(cat docs/cron-prompts/sharp-money-alert.md | sed -n '/^## Prompt/,/^## Schedule/p' | head -n -2)" \
  --name "propprofessor-alerts" \
  --skills propprofessor-coach
```

(Read the file content into the `--prompt` argument; the snippet above is a sketch.)

````

**Step 2:** Commit
```bash
git add docs/cron-prompts/sharp-money-alert.md
git commit -m "docs(cron): add sharp-money alert cron prompt template"
````

### Task 5.2: Wire `make install-cron` to register the job

**Files:**

- Modify: `scripts/install.py` (replace the stub `install_cron` from Task 3.1)

**Step 1:** Replace the stub

```python
def install_cron() -> None:
    """Register the sharp-money alert cron job. Loads the prompt template,
    passes it to `hermes cron create`. Idempotent — re-running with the same
    name updates the job."""
    from install_helpers import hermes_bin
    import subprocess

    prompt_path = REPO_ROOT / "docs" / "cron-prompts" / "sharp-money-alert.md"
    if not prompt_path.exists():
        raise SystemExit(f"Cron prompt template not found: {prompt_path}")

    # Extract the prompt body (between ## Prompt and ## Schedule headers).
    text = prompt_path.read_text()
    match = re.search(r"## Prompt\n(.+?)\n## Schedule", text, re.DOTALL)
    if not match:
        raise SystemExit("Could not extract prompt body from template")
    prompt_body = match.group(1).strip()

    cmd = [
        hermes_bin(), "cron", "create", "every 1h",
        "--prompt", prompt_body,
        "--name", "propprofessor-alerts",
        "--skills", "propprofessor-coach"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ⚠ cron registration failed: {result.stderr}", file=sys.stderr)
    else:
        print("  ✓ registered sharp-money alert cron (every 1h)")
```

**Step 2:** Add the `re` import if not present

```python
import re
```

**Step 3:** Test

```bash
make install-cron
```

**Expected:** `✓ registered sharp-money alert cron (every 1h)` or similar.

**Step 4:** Verify the cron exists

```bash
~/.hermes/hermes-agent/venv/bin/hermes cron list
```

**Expected:** `propprofessor-alerts` appears.

**Step 5:** Commit

```bash
git add scripts/install.py
git commit -m "feat(install): wire sharp-money alert cron to make install-cron"
```

---

## Phase 6: Uninstall story

> Already partially built in Task 3.1 (`uninstall` subcommand). Add tests + docs.

### Task 6.1: Test the uninstall flow

**Files:**

- Modify: `scripts/test_install.py` (add `test_uninstall_*`)

**Step 1:** Add tests

```python
def test_uninstall_removes_skill_link(fake_hermes_home):
    subprocess.run([sys.executable, str(INSTALL), "skill"], check=True)
    target = fake_hermes_home / "profiles" / "default" / "skills" / "external" / "propprofessor-coach"
    assert target.is_symlink()
    subprocess.run([sys.executable, str(INSTALL), "uninstall"], check=True)
    assert not target.exists()


def test_uninstall_is_idempotent(fake_hermes_home):
    """Running uninstall twice doesn't error."""
    result = subprocess.run(
        [sys.executable, str(INSTALL), "uninstall"],
        capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    result2 = subprocess.run(
        [sys.executable, str(INSTALL), "uninstall"],
        capture_output=True, text=True
    )
    assert result2.returncode == 0
```

**Step 2:** Run

```bash
python3 -m pytest scripts/test_install.py -v
```

**Expected:** All 5 tests pass.

**Step 3:** Commit

```bash
git add scripts/test_install.py
git commit -m "test(install): cover uninstall flow + idempotency"
```

---

## Phase 7: Final docs + CHANGELOG

### Task 7.1: Rewrite README's "Install" section

**Files:**

- Modify: `README.md` (replace the "Install" section with the new flow)

**Step 1:** Read the current section

```bash
grep -n "^## " README.md | head -10
```

**Step 2:** Replace the install section (use `patch` from the repo root)

````markdown
## Install

**One command. No config editing required.**

```bash
git clone https://github.com/jbdrak/propprofessor-mcp.git
cd propprofessor-mcp
npm install
npm link
make install
```
````

`make install` does three things:

1. Links the `propprofessor-coach` skill into `~/.hermes/skills/external/`
2. Registers the MCP server with hermes (`hermes mcp add propprofessor ...`)
3. Installs the default config to `~/.propprofessor/config.json`

Then authenticate:

```bash
pp-query login   # or `pp doctor` to diagnose
```

**Optional:** install the sharp-money alert cron:

```bash
make install-cron
```

**To remove:**

```bash
make uninstall
```

### Manual install (advanced)

If `make install` doesn't fit your workflow, see [SETUP.md](SETUP.md) for the manual `hermes mcp add` command and skill-symlink instructions.

````

**Step 3:** Commit
```bash
git add README.md
git commit -m "docs(readme): lead with 'make install' one-command flow"
````

### Task 7.2: Add INSTALL.md

**Files:**

- Create: `INSTALL.md`

**Step 1:** Write a focused quick-start (50-80 lines)

````markdown
# Install

> For full documentation, see [README.md](README.md) and [SETUP.md](SETUP.md). This file is the 60-second version.

## Prerequisites

- Node.js 18+
- A hermes install at `~/.hermes/` (any profile)
- A paid PropProfessor account

## Steps

```bash
# 1. Clone + install Node deps
git clone https://github.com/jbdrak/propprofessor-mcp.git
cd propprofessor-mcp
npm install
npm link

# 2. Wire into hermes (idempotent)
make install

# 3. Authenticate with PropProfessor
pp-query login
# or: export AUTH_FILE=/path/to/your/auth.json

# 4. Verify
pp-query doctor
```
````

## What `make install` does

| Step                                                        | Command                            | Reversible?        |
| ----------------------------------------------------------- | ---------------------------------- | ------------------ |
| 1. Symlink `propprofessor-coach` skill                      | `python3 scripts/install.py skill` | ✓ `make uninstall` |
| 2. Register MCP server with hermes                          | `python3 scripts/install.py mcp`   | ✓ `make uninstall` |
| 3. Install default config to `~/.propprofessor/config.json` | runs as part of step 2             | ✓ delete the file  |

## What `make install-cron` adds

Registers a `propprofessor-alerts` cron job that runs every 1h, queries TIER 1 plays, and delivers to your home telegram channel. See [docs/cron-prompts/sharp-money-alert.md](docs/cron-prompts/sharp-money-alert.md) for the prompt.

## Troubleshooting

- **`hermes: command not found`** — install hermes first: `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash`
- **Skill doesn't load** — check the symlink: `ls -la ~/.hermes/skills/external/propprofessor-coach`. Should point back to this repo's `skills/propprofessor-coach/`.
- **Auth errors at runtime** — run `pp-query login` or `pp-query doctor`.

````

**Step 2:** Add to `package.json` `files`
```json
"files": [
  ...,
  "INSTALL.md",
  ...
]
````

**Step 3:** Commit

```bash
git add INSTALL.md package.json
git commit -m "docs: add INSTALL.md quick-start"
```

### Task 7.3: Update CHANGELOG

**Files:**

- Modify: `CHANGELOG.md` (add a v2.1.0 entry — Apollo-style install is a new minor)

**Step 1:** Read the top of the changelog

```bash
head -40 CHANGELOG.md
```

**Step 2:** Add a new entry at the top

```markdown
## 2.1.0 — Hermes Plugin Conversion (Apollo-Style Install)

**This release adds the Apollo-style one-command install flow. No behavior change to the 23 MCP tools.**

### Added

- `make install` — one-command install: links the `propprofessor-coach` skill into hermes, registers the MCP server, installs the default config
- `make install-cron` — registers the optional `propprofessor-alerts` sharp-money cron
- `make uninstall` — reverses both
- `scripts/install.py` — idempotent Python installer (stdlib only, no pip deps)
- `scripts/install_helpers.py` + `scripts/test_install_helpers.py` — hermes path/profile resolution helpers with tests
- `bin/pp` — thin CLI wrapper for `pp hide / unhide / hidden / sync / doctor / today`
- `config.default.json` — ships sane defaults (league=NBA, bankroll=1000, targetBook=NoVigApp)
- `pp-query setup` — copies the default config to `~/.propprofessor/config.json`
- `skills/propprofessor-coach/SKILL.md` — operator-facing coach skill (auto-routes "what should I bet today" to the right tools)
- `docs/cron-prompts/sharp-money-alert.md` — cron prompt template
- `INSTALL.md` — 60-second quick-start

### Behavior

- The 23 MCP tools and 784-test suite are unchanged. Pure packaging work.
- `hermes mcp add propprofessor` is unchanged in shape — the installer just automates the config edit that users previously did manually.

### Migration

- Existing users: re-running `make install` is a no-op. New install gets the skill symlink + config.
- The 3 hermes-side `propprofessor-*` skills in `~/.hermes/skills/` are unchanged. The new coach skill ships in the repo and gets linked separately.
```

**Step 3:** Bump `package.json` version

```bash
node -e "const fs=require('fs'); const p=require('./package.json'); p.version='2.1.0'; fs.writeFileSync('./package.json', JSON.stringify(p, null, 2)+'\n');"
```

**Step 4:** Bump `README.md` test count badge (if present) and body test count (3 locations per the existing skill's release workflow pitfalls)

**Step 5:** Run the version consistency check

```bash
npm run check:version
```

**Expected:** PASS.

**Step 6:** Commit

```bash
git add CHANGELOG.md package.json README.md
git commit -m "chore(release): v2.1.0 — hermes plugin conversion"
```

### Task 7.4: Update SETUP.md

**Files:**

- Modify: `SETUP.md` (point the existing manual install section to `make install`)

**Step 1:** Read the current structure

```bash
grep -n "^## " SETUP.md
```

**Step 2:** Add a "Recommended: `make install`" callout at the top of the install section, just before the existing "Clone and install" code block. Keep the manual instructions below for users who can't use the Makefile.

**Step 3:** Commit

```bash
git add SETUP.md
git commit -m "docs(setup): lead with 'make install' one-command flow"
```

---

## Phase 8: Final verification

### Task 8.1: Full smoke test from a clean state

**Files:** none

**Step 1:** From a fresh shell, in the repo:

```bash
cd ~/Documents/workspace/propprofessor-mcp
make install
pp-query doctor
~/.hermes/hermes-agent/venv/bin/hermes mcp list
~/.hermes/hermes-agent/venv/bin/hermes skills list | grep propprofessor
pp today
pp hidden
```

**Step 2:** Confirm all five commands succeed without errors.

**Step 3:** Run the full test suite

```bash
npm test
python3 -m pytest scripts/
```

**Expected:** 784+ JS tests pass, all Python tests pass.

**Step 4:** Commit (no changes — verification only).

### Task 8.2: Tag the release

**Files:** none (git tag)

**Step 1:** Verify version consistency

```bash
npm run check:version
npm run lint
npm run format:check
```

**Step 2:** Push and tag

```bash
git push origin main
git tag v2.1.0
git push origin v2.1.0
```

**Step 3:** Verify the release workflow fires

```bash
# Watch the GitHub Actions run
gh run watch
```

**Step 4:** If CI fails (e.g. prettier issue), follow the existing skill's release-workflow-pitfalls (remove tag, fix, re-tag):

```bash
git tag -d v2.1.0
git push origin :refs/tags/v2.1.0
# fix
git tag v2.1.0
git push origin v2.1.0
```

---

## Summary

| Phase | What ships             | Files touched   | Risk                                     |
| ----- | ---------------------- | --------------- | ---------------------------------------- |
| 0     | Verify state           | (read-only)     | None                                     |
| 1     | Coach skill + Makefile | 2 new, 1 modify | Low — pure additive                      |
| 2     | `pp` wrapper           | 1 new, 1 modify | Low — pass-through only                  |
| 3     | `install.py`           | 1 new, 1 modify | Med — touches hermes config (idempotent) |
| 4     | Default config         | 2 new, 2 modify | Low — additive to `~/.propprofessor/`    |
| 5     | Cron template          | 1 new, 1 modify | Low — opt-in                             |
| 6     | Uninstall tests        | 1 modify        | Low                                      |
| 7     | Docs + CHANGELOG       | 4 modify, 1 new | Low                                      |
| 8     | Tag v2.1.0             | (git)           | Med — release workflow                   |

**Total new files:** 11
**Total modified files:** 9
**Test count delta:** +8 Python tests, +3 JS tests = 795 total (784 + 11)

**Out of scope (later):**

- Real Python `pip install hermes-propprofessor-data` plugin (Option A from prior discussion)
- Local SQLite store at `~/.hermes/propprofessor.db`
- Self-managed hide/unhide persistence (currently lives in MCP server's tierCache; could move to disk)
- Per-profile skill loading profiles (e.g. `propprofessor-coach-nba` vs `propprofessor-coach-tennis`)
