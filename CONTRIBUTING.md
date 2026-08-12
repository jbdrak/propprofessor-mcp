# Contributing to PropProfessor MCP

PRs welcome! This is a community-driven project — fixes, features, docs, and test improvements all help.

## Getting Started

1. Fork the repo
2. `git clone` + `npm install`
3. `cp config.default.json config.json` and add your auth
4. `npm run install:verify` should pass (53 offline tests, no auth needed)

## Development Workflow

1. **Make changes** in `lib/`, `scripts/`, or `bin/`
2. **Run offline tests:** `npm run install:verify` — must pass before committing
3. **Lint:** `npm run lint` — ESLint must be clean
4. **Full suite:** `npm test` (slower, needs auth)
5. **Check README consistency:** `npm run check:claims` — verifies tool counts match

### CLI development

The `pp` CLI lives in `bin/pp-cli.js`. Changes are:

- Add a new command function (`cmdXxx`)
- Add a switch case in `main()`
- Add help text to `printHelp()`
- Test with `node bin/pp <command> --no-color`

### MCP handler development

- Tool definitions: `lib/tool-definitions/`
- Handlers: `scripts/server/handlers/` (extracted modules) and `scripts/server/handlers.js` (inline)
- Adding a tool requires updating tool-count assertions in 3 test files (see `scripts/server/handlers.js` header doc)

## Testing

- `lib/` uses Node's built-in `node:test` framework
- `scripts/server/handlers/` use `node:test` with API mocks
- New handlers need at least a syntax-check test
- Smoke tests: use `pp-query doctor` or individual MCP tools manually (requires auth)

## Pull Request Guidelines

- One feature/fix per PR
- Include test coverage for new logic
- Update README if adding/changing a CLI command
- Run `npm run install:verify` before opening
- Mention if the change affects the MCP protocol, CLI output, or both

## Code of Conduct

Be decent. This is a small project about sports betting data — there's no room for drama.

## Questions?

Open a [Discussion](https://github.com/jbdrak/propprofessor-mcp/discussions) or an [Issue](https://github.com/jbdrak/propprofessor-mcp/issues).
