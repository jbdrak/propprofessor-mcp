#!/usr/bin/env python3
"""PropProfessor hermes install script.

Subcommands:
  skill     Symlink skills/propprofessor-coach into hermes skills/external/.
  mcp       Register the propprofessor MCP server with hermes.
  uninstall Reverse all of the above.
  all       Run skill + mcp (the default).
"""
from __future__ import annotations

import argparse
import os
import subprocess
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

    # Install default config first. The `pp-query setup` command is idempotent
    # — it only writes the default config if `~/.propprofessor/config.json`
    # doesn't exist. We parse the JSON output so the user sees "created" vs
    # "exists" rather than a raw JSON blob.
    import json
    setup_result = subprocess.run(
        ["node", str(REPO_ROOT / "scripts" / "query-propprofessor.js"), "setup"],
        capture_output=True, text=True
    )
    if setup_result.returncode == 0:
        try:
            payload = json.loads(setup_result.stdout.strip())
            status = payload.get("status", "unknown")
            config_path = payload.get("path", "")
            if status == "created":
                print(f"  ✓ config: created at {config_path}")
            elif status == "exists":
                print(f"  ✓ config: kept existing at {config_path}")
            else:
                print(f"  ✓ config: {status} at {config_path}")
        except (json.JSONDecodeError, KeyError, TypeError):
            # Fall back to raw output if the JSON shape changes in a future
            # release — install should still complete even if we can't pretty-print.
            print(f"  ✓ config: {setup_result.stdout.strip()}")
    else:
        print(f"  ⚠ config setup failed: {setup_result.stderr}", file=sys.stderr)

    hermes_home = resolve_hermes_home()
    # Honor AUTH_FILE env var if set — the doctor/install-auth commands respect
    # it, and the install shouldn't silently override a user's existing path.
    # Falls back to the standard ~/.propprofessor/auth.json default.
    auth_file = Path(os.environ.get("AUTH_FILE", "").strip()).expanduser() \
        if os.environ.get("AUTH_FILE", "").strip() \
        else AUTH_FILE_DEFAULT
    auth_file.parent.mkdir(parents=True, exist_ok=True)
    if not auth_file.exists():
        print(f"  ⚠ auth file not found at {auth_file}. Run 'pp-query login' after install.")
    # `hermes mcp add` is idempotent — re-running updates in place. Only pass
    # AUTH_FILE if it's not already inherited from the environment (the user's
    # shell may have set it; we just want to make sure the registered config
    # points at the same file either way).
    hermes_env_args = ["--env", "PROPPROFESSOR_MCP_NDJSON=true"]
    if not os.environ.get("AUTH_FILE"):
        hermes_env_args = ["--env", f"AUTH_FILE={auth_file}"] + hermes_env_args
    run_hermes([
        "mcp", "add", MCP_NAME,
        "--command", "node",
        "--args", str(MCP_SERVER_PATH),
        *hermes_env_args
    ])
    print(f"  ✓ registered MCP server '{MCP_NAME}' with hermes")


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

    for name in ("skill", "mcp", "uninstall", "all"):
        sub.add_parser(name)

    args = parser.parse_args()
    handlers = {
        "skill": install_skill,
        "mcp": install_mcp,
        "uninstall": uninstall,
        "all": lambda: (install_skill(), install_mcp()),
    }
    handlers[args.cmd]()
    return 0


if __name__ == "__main__":
    sys.exit(main())