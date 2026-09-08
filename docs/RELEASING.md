# Releasing PropProfessor MCP

Releases are tag-driven. A tag matching `v*` runs `.github/workflows/release.yml`, verifies the package on supported Node versions, publishes to npm, then creates the GitHub release only after npm succeeds.

## One-time npm trusted-publisher setup

The release workflow uses npm trusted publishing (GitHub Actions OIDC) instead of a long-lived `NPM_TOKEN`.

Requirements:

- The `propprofessor-mcp` package already exists on npm.
- Your npm account has publish access to the package and account-level 2FA enabled.
- Use Node 22.14+ and npm 11.15+ for the `npm trust` setup command.

Authenticate to npm, then create the exact trust relationship used by this repository:

```bash
npm login
npm trust github propprofessor-mcp \
  --repo jbdrak/propprofessor-mcp \
  --file release.yml \
  --allow-publish \
  -y
```

Verify it:

```bash
npm trust list propprofessor-mcp
```

The repository name and workflow filename are case-sensitive trust inputs. The workflow must keep `id-token: write` on the publish job. Do not add a broad or long-lived npm publish token as a fallback.

## Prepare a release

1. Choose the next SemVer version.
2. Update `package.json` and `package-lock.json` to that version.
3. Move the release notes out of `Unreleased` and make the first version heading in `CHANGELOG.md` match `package.json`.
4. Run the local release checks:

```bash
npm ci --include=dev
npm run check:version
npm run check:claims:quick
npm run check:secrets
npm run lint
npm run check:types
npx tsc -p tsconfig.strict-critical.json
npm run check:circular
npm run format:check
npm run check:package
npm audit --audit-level=moderate --omit=dev
npm run check:publish-tree
npm test
```

5. Merge the release-prep change to `main` only after CI is green.
6. Tag the exact release commit and push the tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

`release.yml` checks that the tag version matches `package.json`, publishes with short-lived OIDC credentials, and creates the GitHub release only after npm publishing succeeds.

## Action dependency policy

GitHub Actions are pinned to immutable full commit SHAs. Dependabot tracks GitHub Actions weekly and groups minor/patch updates; major updates stay separate for explicit review.
