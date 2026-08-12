# Installation

PropProfessor MCP is a Model Context Protocol server plus a setup CLI. The npm package is not currently published, so the supported install path is from the GitHub repository.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- A PropProfessor account with valid credentials (see the auth section in [README.md](README.md))

## Install from source

```bash
git clone https://github.com/jbdrak/propprofessor-mcp.git
cd propprofessor-mcp
npm ci
npm link
```

This exposes the `pp`, `pp-mcp`, `pp-query`, and `pp-backtest` binaries.

## First-run setup

```bash
pp-query login
```

This stores your PropProfessor credentials locally under `~/.propprofessor/` (auth files are written with owner-only permissions). Logging in is a one-time, manual action — there is no automated login or scheduled polling.

## Verify the install

```bash
pp-mcp --help
pp-query doctor
```

`pp-query doctor` checks that your local auth state is valid without making a live PropProfessor request.

## MCP client configuration

Point your MCP client at the `pp-mcp` binary (stdio transport). For example, a Claude-style client config entry:

```json
{
  "mcpServers": {
    "propprofessor": {
      "command": "pp-mcp",
      "args": []
    }
  }
}
```

## Manual-only guarantee

PropProfessor endpoints are manual-only. The package contains no cron jobs, scheduled workflows, or unattended pollers. Snapshot/backtest capture and all live queries require an explicit user-triggered command; see [BACKTESTING.md](docs/BACKTESTING.md) for the `--live` acknowledgment requirement.

## Uninstall

```bash
npm uninstall -g propprofessor-mcp
```

Local data under `~/.propprofessor/` is left in place.

## Troubleshooting

- `pp-query doctor` reports an auth problem → re-run `pp-query login`.
- `pp-mcp` fails to start → confirm the binary is on your PATH after `npm install -g`.
- Any other issue → open a GitHub issue on the repository.

See [README.md](README.md) for the full user guide and [CHANGELOG.md](CHANGELOG.md) for release history.
