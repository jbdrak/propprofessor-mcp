# Frontend Contract Audit

`scripts/live-frontend-contract-audit.js` is a **manual-only, read-only**
diagnostic that checks a frontend bundle's league/market map against the repo
registry (`lib/propprofessor-market-registry.js` — the single source of truth
for what leagues and markets the PropProfessor backend supports) and runs a
fixture-driven deep-link hydration check.

It exists to catch contract drift before it reaches users — the classic case
being a backend league added to the registry (e.g. MLS) that the deployed
frontend has not shipped yet, so deep links to that league fail or hydrate a
blank market selector.

## Safety guarantees

- **Manual only.** This script is never invoked by cron, a watcher, or a
  scheduler. It performs no polling and installs no recurring timers. Run it
  on demand: `node scripts/live-frontend-contract-audit.js ...`
- **Read-only.** With `--bundle` it reads a local JSON file. With `--url` it
  makes exactly one anonymous GET (`credentials: 'omit'`, no cookies, no auth
  headers, no redirect to login flows). It never writes to the repo and never
  logs in.
- **Secrets-safe.** It never reads `auth.json`, `token-cache.json`, session
  files, or any credential store, and it never prints cookies, tokens,
  headers, or response bodies. URLs are redacted (query strings and fragments
  stripped) before they appear in the report. The report carries **safe fields
  only**: league, market, book, HTTP status, and row counts.
- **Auth-aware.** If the deployed bundle responds `401`/`403`, or with an HTML
  login page instead of a JSON bundle, the audit reports "requires
  authentication" and points at a local `--bundle` export. It never attempts
  to authenticate and never fails with secrets.

## Usage

```bash
# Offline: audit a local bundle snapshot (no network at all)
node scripts/live-frontend-contract-audit.js --bundle path/to/bundle.json

# Offline + deep-link hydration check
node scripts/live-frontend-contract-audit.js --bundle path/to/bundle.json --deep-links path/to/deep-links.json

# Online: audit the deployed bundle with one anonymous GET
node scripts/live-frontend-contract-audit.js --url https://app.example.com/static/bundle.json --deep-links path/to/deep-links.json

node scripts/live-frontend-contract-audit.js --help
```

### Exit codes

| Code | Meaning                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| `0`  | Audit ran; no findings.                                                                                        |
| `1`  | Audit ran; findings (league/market drift, deep-link hydration issues, or an auth wall on the deployed bundle). |
| `2`  | Usage or I/O error (bad flags, missing/invalid bundle or deep-links file, network failure).                    |

## Bundle schema (`--bundle` / `--url` response)

The bundle is a JSON object describing the frontend's league/market map:

```json
{
  "source": "https://app.example.com/_next/static/chunks/app.js",
  "fetchedAt": "2026-08-01T12:00:00.000Z",
  "leagues": [
    {
      "league": "MLS",
      "markets": ["Draw No Bet", "Match Handicap", "Total Goals"],
      "books": ["NoVigApp", "Fliff"]
    },
    {
      "league": "tennis",
      "markets": ["moneyline", "game handicap", "total games"]
    }
  ]
}
```

- `leagues[].league` — league name. Matching is case-insensitive; the report
  keeps the bundle's original spelling.
- `leagues[].markets` — market names the frontend exposes for that league.
  Matching is case-insensitive.
- `leagues[].books` — optional; books the frontend exposes for that league.
  When omitted the audit compares against the registry's `default` book set.

### Comparison semantics (against the registry)

| Row status          | Meaning                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `matched`           | League (and each market per book) matches the registry.                                           |
| `missing-league`    | Registry league absent from the frontend bundle (e.g. MLS added to the registry but not shipped). |
| `unknown-league`    | Frontend league the registry does not define.                                                     |
| `missing` / `extra` | Per-book market-level drift.                                                                      |

## Deep-link fixture schema (`--deep-links`)

```json
{
  "deepLinks": [
    { "path": "/leagues/mls", "expectedLeague": "MLS", "selectorPresent": true, "selectorOptions": 3 },
    {
      "path": "/leagues/mls?market=total-goals",
      "expectedLeague": "MLS",
      "selectorPresent": true,
      "selectorOptions": 0
    },
    { "path": "/leagues/ufc", "expectedLeague": "UFC", "selectorPresent": false, "selectorOptions": 0 }
  ]
}
```

The check is a pure fixture-driven abstraction (`checkDeepLinkHydration` in the
script): no network, no browser. It combines each deep link with the bundle's
league map and reports one row per link:

| Row status        | Meaning                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| `ok`              | League present and selector hydrated with options.                       |
| `missing-league`  | The deep link expects a league the bundle does not expose (missing MLS). |
| `blank-selector`  | The market selector rendered but hydrated with **0 options**.            |
| `absent-selector` | The market selector never rendered.                                      |

## Report shape

The audit prints a single JSON object to stdout. Safe fields only:

```json
{
  "tool": "live-frontend-contract-audit",
  "mode": "manual",
  "readOnly": true,
  "authRequired": false,
  "httpStatus": 200,
  "source": "file:path/to/bundle.json",
  "checks": {
    "leagueMarket": { "rows": [], "counts": {}, "issues": [] },
    "deepLinkHydration": { "rows": [], "counts": {}, "issues": [] }
  },
  "summary": { "issues": [], "issueCount": 0, "rowCount": 0, "findingRowCount": 0, "ok": true }
}
```

`checks.*.counts` holds row counts (`total`, per-status counts, `clean`,
`findings`). A skipped check (e.g. auth wall, or no `--deep-links` fixture) is
reported as `{ "skipped": true, "reason": "..." }`.

## Tests

Fixture-driven coverage lives in `test/live-frontend-contract-audit.test.js`
with fixtures under `test/fixtures/frontend-contract/`:

```bash
node --test test/live-frontend-contract-audit.test.js
```

- `bundle.json` — a bundle satisfying the full registry contract (including
  MLS), with deliberate casing drift to prove case-insensitive matching.
- `bundle-mls-missing.json` — a deployed-style bundle that has not shipped
  MLS, plus an unknown league and a frontend-only market.
- `deep-links.json` — hydrated, blank-selector, and absent-selector deep links.

Network is optional and fully mockable: tests inject a `fetcher`
(`{ ok, status, text }`) into `auditFrontendContract({ url, fetcher })`, so
the whole suite runs offline and deterministically.
