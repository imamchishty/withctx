# Changelog

All notable changes to withctx are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/).

## [1.4.0] — 2026-04-11

The "on-prem release" — withctx now runs unmodified inside a corporate
network with self-hosted Jira, Confluence, and GitHub Enterprise
Server sitting behind a TLS-intercepting proxy, and unmodified inside
a GitHub Actions workflow on either github.com or GHES.

### Fixed — release blocker

- **External connectors were silently dropped from `ctx ingest` and
  `ctx sync`.** Both pipelines had their own `buildConnectors` helper
  and both only registered `LocalFilesConnector`, so a perfectly
  valid `jira:`, `confluence:`, `github:`, or `teams:` section in
  `ctx.yaml` produced zero documents and no error. Fixed by
  extracting a shared `src/connectors/build.ts` that both pipelines
  use; every declared source now actually runs. This is the most
  important fix in the release — everything on-prem below would
  have been dead on arrival without it.
- `tests/build-connectors.test.ts` pins the registration behaviour of
  every source type so the regression can't come back silently.

### Added — on-prem + enterprise

- **TLS + proxy bootstrap.** `src/connectors/network-bootstrap.ts` is
  called once at CLI startup. It validates `NODE_EXTRA_CA_CERTS`,
  installs undici's `EnvHttpProxyAgent` as the global dispatcher when
  `HTTPS_PROXY`/`HTTP_PROXY` are set, and loudly warns when
  `NODE_TLS_REJECT_UNAUTHORIZED=0` is used as a debug escape hatch.
  Every connector that goes through `resilientFetch`, Octokit, or
  raw `fetch` inherits the settings for free.
- **GitHub Enterprise Server + Actions parity.** `src/connectors/github-url.ts`
  resolves the API base URL and token from `config` → `GITHUB_API_URL`
  env → `GITHUB_TOKEN`/`GH_TOKEN` env, auto-appends `/api/v3` when a
  GHES host is given without it, and anchors the "is this github.com?"
  check to an exact host match so `github.com.evil.com` can't
  bypass it. The same ctx.yaml works on a laptop, inside CI, and in a
  GitHub Actions workflow on either deployment — no environment-
  specific edits.
- **CI/CD connector** picks up the same resolver, so workflow runs on
  GHES work with zero config when run inside Actions.
- **`ctx doctor` "Network" section** shows the CA bundle status,
  HTTPS_PROXY routing, and flags disabled TLS verification — the
  on-prem troubleshooting path starts here.
- **`scripts/smoke-onprem.mjs`** — standalone real-network smoke test
  for Jira, Confluence, and GitHub, each runnable independently or
  as `all`. Walks `error.cause` chains to report the *real* failure
  (corporate CA missing vs DNS vs proxy vs auth) in plain English.
  Invoked via `npm run smoke:onprem jira` etc. Deliberately not
  wired into vitest — makes real HTTP calls, not safe for CI.
- **SharePoint connector is now reachable from `ctx.yaml`.** The
  connector code existed since 1.2 but its schema was never
  registered, so `sources.sharepoint:` entries were silently dropped
  by zod parsing. `SharePointSourceSchema` now supports an array of
  site configs, so a single ctx.yaml can pull from many SharePoint
  sites in one `ctx sync` run; each site is a separate connector
  registration so the progress UI shows per-site counts and
  `ctx sync --source <name>` can target an individual site.
- **`explainNetworkError`** helper inside `resilient-fetch.ts` walks
  undici's nested `error.cause` chain and matches TLS, DNS,
  ECONNREFUSED, ECONNRESET, ETIMEDOUT signals, rewriting the thrown
  error with a plain-English fix block that mentions
  `NODE_EXTRA_CA_CERTS` / `HTTPS_PROXY` directly.
- **`ctx ask` help + error UX.** `ctx ask --help`, `ctx ask -h`, and
  bare `ctx ask` now print a dedicated ask-specific usage block and
  exit 0 instead of either dumping the 12-verb core help grid (the
  `formatHelp` override used to cascade into subcommands) or leaking
  the internal `query` verb via Commander's "missing required
  argument 'question'" error. Thirteen new tests in
  `ask-dispatcher.test.ts` pin this behaviour, including a guard
  that the help text does **not** contain `ctx query`.
- **`undici`** is now a direct dependency (was transitive) so the
  proxy agent is always available.

### Changed

- `GitHubSourceSchema.token` is now optional — the resolver picks it
  up from `GITHUB_TOKEN` / `GH_TOKEN` when not in config, which is
  the expected flow for Actions and most corporate setups.
- `GitHubConnector` and `CicdConnector` now expose a read-only
  `effectiveBaseUrl` property for diagnostics and throw a precise
  error when no token can be resolved anywhere (vs. failing the
  first API call with an opaque 401).
- `src/cli/commands/doctor.ts` gains `checkNetworkDiagnostics()` and
  a Claude CLI reachability check that only fires when
  `provider=anthropic` and no API key is discoverable.

### Tests

- `tests/github-connector.test.ts` — 17 new tests covering base URL
  normalisation, token resolution order, GHES integration via
  mock server, and the Actions env-fallback path.
- `tests/cicd-connector.test.ts` — 3 new tests for the same on the
  CI/CD connector.
- `tests/ask-dispatcher.test.ts` — 13 new tests (30 total in file)
  covering `isAskHelpRequest`, `formatAskHelp`, and the
  `applyAskRewrite` help-path short circuit.
- `tests/build-connectors.test.ts` — 10 new tests locking down every
  connector type's registration, including the
  "misconfigured GitHub source shouldn't take down the whole
  pipeline" case.
- Total: 35 → 36 test files, 562 → 572 tests passing.
