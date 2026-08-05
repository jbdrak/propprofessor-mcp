# Maintainer Notes

This file is for release and maintenance workflow details that should not clutter the beginner setup flow in `README.md`.

## Manual PropProfessor Usage

PropProfessor is manual-only. There are no automated schedules, cron jobs, or
CI-driven live smoke tests. To run a live smoke check:

1. Ensure you have a valid `auth.json` in `~/.propprofessor/`
2. Run from the CLI: `pp-query doctor`
3. Or invoke individual MCP tools via Hermes: `recommended_bets`, `sharp_plays`, etc.

## Release Checklist

Before creating a new release:

1. Update the version in `package.json` (and `package-lock.json` via `npm install`)
2. Add the matching heading in `CHANGELOG.md` (the authoritative release history)
3. Run `npm test`
4. Run `npm run check:version`, `npm run check:package`, and `npm run check:publish-tree`
5. Commit everything — `check:publish-tree` refuses to publish a dirty tree
6. Create and push the git tag (e.g. `git tag vX.Y.Z && git push origin vX.Y.Z`)

Pushing a `v*` tag triggers `.github/workflows/release.yml`: the `verify` job
runs the full suite on Node 20 and 22, then the Node 20 `publish` job installs
dev dependencies, re-checks version/package content, runs `npm publish`, and
creates the GitHub release only after the publish succeeds.

## Packaging Notes

- `main` points at the MCP server entrypoint
- `pp`, `pp-mcp`, `pp-query`, and `pp-backtest` are exposed as binaries
- The npm tarball is `package.json`'s `files` whitelist (`lib/`, `bin/`,
  `scripts/`, `docs/`, README/INSTALL/CONFIG/MAINTAINERS/CHANGELOG/LICENSE);
  `.npmignore` filters scratch scripts, tests, and local data out of it
- `npm run check:package` verifies tarball contents; `npm run
check:publish-tree` blocks publishing a dirty tree (both run via
  `prepublishOnly` before `npm publish`)
- `npm test` runs the `node:test` suite
