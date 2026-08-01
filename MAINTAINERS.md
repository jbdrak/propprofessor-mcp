# Maintainer Notes

This file is for release and maintenance workflow details that should not clutter the beginner setup flow in `README.md`.

## Manual PropProfessor Usage

PropProfessor is manual-only. There are no automated schedules, cron jobs, or
CI-driven live smoke tests. To run a live smoke check:

1. Ensure you have a valid `auth.json` in `~/.propprofessor/`
2. Run from the CLI: `pp-query doctor`
3. Or invoke individual MCP tools via Hermes: `recommended_bets`, `sharp_plays`, etc.

## Release Checklist

Before creating a new GitHub release:

1. Update the version in `package.json`
2. Add the matching heading in `CHANGELOG.md`
3. Run `npm test`
4. Run `npm run check:version`
5. Create and push the git tag
6. Publish the GitHub release from that tag

## Packaging Notes

- `main` points at the MCP server entrypoint
- `pp-mcp` and `pp-query` are exposed as binaries
- `npm test` runs the `node:test` suite
