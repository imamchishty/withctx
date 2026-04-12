# 7. `ctx.yaml` — full configuration reference

Every field the v1.4+ schema accepts, with its default, what it does, and
whether committing it to git is safe. The authoritative source is
[`src/types/config.ts`](../../src/types/config.ts) — this file is a
human-readable mirror.

> **Legend**
>
> - **✅ safe to commit** — no secrets, no machine-specific paths
> - **⚠️  careful** — often contains a secret or a per-machine value; use
>   `${VAR}` interpolation instead of a literal
> - **🔒 never commit literal** — treat the literal value as a secret

---

## Top-level shape

```yaml
project: my-project          # REQUIRED — display name used across the wiki
refreshed_by: ci             # optional: "local" (default) | "ci"
repos: [...]                 # git repos this wiki covers (metadata only)
sources: {...}               # where to pull knowledge from
costs: {...}                 # budget + default model (legacy)
access: {...}                # redaction rules for sensitive content
ai: {...}                    # LLM provider, model, base URL, per-op overrides
```

### `refreshed_by`

Controls who is allowed to refresh the wiki.

- `"local"` (default) — anyone can run `ctx sync` / `ctx ingest`. The
  ergonomic mode for a single developer or a repo where refresh is
  cheap.
- `"ci"` — local refresh is blocked. Only a CI job (typically the
  GitHub Action dropped by `ctx publish`) should call `ctx sync`. A
  developer who really needs to rebuild locally can pass
  `--allow-local-refresh` — they'll see a cost warning showing the last
  refresh time / cost and be asked to confirm.

`ctx publish` sets `refreshed_by: ci` automatically. Setting it by hand
in a non-published repo is fine too.

Only `project` is required. Everything else is optional — `ctx setup`
writes the minimal useful file and you add sections as you need them.

---

## Complete example — every field shown at once

```yaml
# ---------------------------------------------------------------------------
# Project — REQUIRED
# ---------------------------------------------------------------------------
project: acme-platform                                 # ✅ safe to commit

# ---------------------------------------------------------------------------
# Repos — purely metadata, shown in `ctx status` and linked in wiki pages
# ---------------------------------------------------------------------------
repos:                                                 # ✅ safe to commit
  - name: api
    github: acme/api                                   # owner/repo
    branch: main                                       # optional
  - name: web
    github: acme/web
  - name: worker
    github: acme/worker

# ---------------------------------------------------------------------------
# AI provider — which LLM answers your queries and compiles the wiki
# ---------------------------------------------------------------------------
ai:
  # One of: anthropic | openai | google | ollama   (default: anthropic)
  provider: anthropic                                  # ✅ safe to commit

  # Default model for this provider. Omit to use the provider's default.
  # Anthropic default: claude-sonnet-4-20250514
  # OpenAI default:    gpt-4o
  # Google default:    gemini-2.0-flash
  # Ollama default:    llama3
  model: claude-sonnet-4-20250514                      # ✅ safe to commit

  # Override the API endpoint. Use-cases:
  #   - LLM gateways (LiteLLM, Portkey, Cloudflare AI Gateway)
  #   - Corporate egress proxies / Core42 / self-hosted endpoints
  #   - Mock servers in tests
  # Omit to use each provider's default URL.
  base_url: https://api.anthropic.com                  # ✅ safe to commit

  # API key. RESOLUTION ORDER AT RUNTIME:
  #   1. The provider's env var (ANTHROPIC_API_KEY / OPENAI_API_KEY /
  #      GOOGLE_API_KEY) — always wins if set.
  #   2. This field — used as fallback.
  #   3. Nothing — requests fail with "unauthorized".
  #
  # Best practice: leave this field out and use env vars. It exists as an
  # escape hatch for solo/local workflows where a single committed
  # ctx.yaml is simpler. If you DO use this field, prefer `${VAR}`
  # interpolation so the literal secret never lands in the file:
  api_key: ${ANTHROPIC_API_KEY}                        # ⚠️  careful

  # Per-operation model overrides. Model names auto-detect their provider
  # by prefix (claude-* → anthropic, gpt-*/o1-* → openai, gemini-* →
  # google, llama*/mistral*/qwen* → ollama), so an override on a *different*
  # provider will transparently route just that operation there.
  models:                                              # ✅ safe to commit
    ingest: gpt-4o-mini                                # use OpenAI for bulk
    lint: claude-haiku-3.5-20241022                    # cheap Anthropic for lint
    query: claude-sonnet-4-20250514                    # default for interactive
    chat: claude-sonnet-4-20250514
    review: claude-sonnet-4-20250514

  # Custom HTTP headers attached to every provider request. The escape
  # hatch for corporate / Azure-style endpoints that authenticate with a
  # header other than `Authorization: Bearer`, or that need tenant /
  # region routing headers. Supports `${VAR}` interpolation so secrets
  # stay in the environment.
  headers:                                             # ⚠️  careful — may contain secrets
    api-key: ${CORE42_API_KEY}                         # 🔒 never literal
    x-tenant-id: acme-eu
    x-ms-region: eu-west

  # Custom pricing in USD per 1M tokens, keyed by model name. Overrides
  # the built-in table so corporate / self-hosted / private models get
  # (rough) cost tracking without touching source code. All fields
  # optional; missing `cacheRead` / `cacheWrite` = not supported / zero.
  #
  # Don't sweat precision — these numbers power `ctx history` and cost
  # warnings, not billing. Declaring something is better than leaving
  # the resolver fall back to Sonnet pricing.
  pricing:                                             # ✅ safe to commit
    our-private-llama-3:
      input: 0.10
      output: 0.40
    claude-sonnet-4:                                   # negotiated rate override
      input: 2.50
      output: 12.00
      cacheRead: 0.25
      cacheWrite: 3.00

# ---------------------------------------------------------------------------
# Sources — every connector the 1.x line supports
# ---------------------------------------------------------------------------
sources:

  # --- Local filesystem (sibling repos, monorepos, any folder on disk) ---
  local:                                               # ✅ safe to commit
    - name: api-repo
      path: ./api                                      # relative to ctx.yaml
    - name: web-repo
      path: ./web
    - name: docs
      path: ./docs

  # --- Jira ---
  jira:
    - name: jira                                       # free-form identifier
      base_url: https://acme.atlassian.net             # ✅ safe
      email: ${JIRA_EMAIL}                             # ⚠️  use env
      token: ${JIRA_TOKEN}                             # 🔒 never literal
      project: PROJ                                    # optional — project key
      jql: "status != Done AND updated >= -30d"        # optional — custom JQL
      epic: PROJ-123                                   # optional — epic filter
      component: backend                               # optional
      exclude:                                         # optional filters
        type: [Sub-task, Epic]
        status: [Closed, "Won't Fix"]
        label: [wontfix, noise]

  # --- Confluence ---
  confluence:
    - name: wiki
      base_url: https://acme.atlassian.net/wiki
      email: ${CONF_EMAIL}
      token: ${CONF_TOKEN}                             # 🔒 never literal
      space: ENG                                       # string OR array
      # space: [ENG, OPS, ARCH]                        # multi-space supported
      pages:                                           # optional — pin specific pages
        - id: "123456"
        - url: https://acme.atlassian.net/wiki/spaces/ENG/pages/789
      label: published                                 # optional
      parent: root-page-id                             # optional
      exclude:
        label: [draft, archive]
        title: [Scratchpad, "Meeting Notes"]

  # --- GitHub (issues, PRs, code across repos) ---
  github:
    - name: gh
      token: ${GITHUB_TOKEN}                           # 🔒 never literal
      owner: acme
      repo: api                                        # optional — omit for all repos

  # --- Microsoft Teams ---
  teams:
    - name: teams
      tenant_id: ${MS_TENANT_ID}
      client_id: ${MS_CLIENT_ID}
      client_secret: ${MS_CLIENT_SECRET}               # 🔒 never literal
      channels:
        - team: Engineering
          channel: general
        - team: Engineering
          channel: incidents

  # --- SharePoint / OneDrive (multiple sites supported) ---
  sharepoint:
    - name: eng-drive                                    # each site is its own connector
      site: acme.sharepoint.com/sites/engineering        # ✅ safe to commit
      paths:                                             # folders to crawl recursively
        - /Shared Documents/Handbook
        - /Shared Documents/ADRs
      filetypes: [.docx, .pdf, .xlsx]                    # default: [.docx, .xlsx, .pptx, .pdf, .md]
    - name: finance-drive
      site: acme.sharepoint.com/sites/finance
      files:                                             # specific files instead of folders
        - /Shared Documents/FY24/budget.xlsx

  # --- CI/CD ---
  cicd:
    - name: ci
      provider: github-actions                         # github-actions | jenkins | gitlab-ci
      repo: acme/api
      token: ${GITHUB_TOKEN}                           # optional for public repos
      limit: 50                                        # how many recent runs

  # --- Coverage reports ---
  coverage:
    - name: cov
      path: ./coverage/lcov.info
      format: lcov                                     # lcov | cobertura | istanbul-json

  # --- Pull requests (richer than the `github` connector for PR flow) ---
  pull-requests:
    - name: prs
      repo: acme/api
      token: ${GITHUB_TOKEN}
      include: merged                                  # merged | open | all
      since: "2026-01-01"
      labels: [feature, bug]

  # --- OpenAPI spec (local file or URL) ---
  openapi:
    - name: api-spec
      path: ./openapi.yaml
    - name: public-api
      url: https://api.example.com/openapi.json

  # --- Notion ---
  notion:
    - name: notion
      token: ${NOTION_TOKEN}                           # 🔒 never literal
      database_ids: ["abc123", "def456"]
      page_ids: ["xyz789"]
      base_url: https://api.notion.com                 # optional override

  # --- Slack ---
  slack:
    - name: slack
      token: ${SLACK_TOKEN}                            # 🔒 never literal
      channels: ["#engineering", "#product", "#incidents"]
      since: "2026-01-01"
      base_url: https://slack.com/api                  # optional override

# ---------------------------------------------------------------------------
# Costs — budget tracking + (legacy) default model
# ---------------------------------------------------------------------------
costs:                                                 # ✅ safe to commit
  budget: 50                                           # USD/month (optional)
  alert_at: 80                                         # warn at % of budget (default 80)

  # LEGACY: this was the original model setting before `ai.model` existed.
  # The factory still reads it as a fallback if `ai.model` is absent, so
  # old configs keep working. New configs should prefer `ai.model`.
  model: claude-sonnet-4-20250514

  # LEGACY per-operation overrides — superseded by `ai.models`.
  model_override:
    query: claude-haiku-3.5-20241022

# ---------------------------------------------------------------------------
# Access — redaction rules applied to ingested content
# ---------------------------------------------------------------------------
access:                                                # ✅ safe to commit
  sensitive:
    - pattern: "(?i)password|secret|api[_-]?key"       # regex
    - pattern: "sk-[a-zA-Z0-9]{32,}"
    - tag: confidential                                # match by tag instead
    - tag: pii
```

---

## Minimal working example

For a solo developer starting fresh:

```yaml
project: my-app
ai:
  provider: anthropic
sources:
  local:
    - name: code
      path: .
```

That's it. Combined with `export ANTHROPIC_API_KEY=sk-ant-...` you can
run `ctx setup` and get a working wiki.

---

## Env var interpolation

Any string value in the file supports `${VAR_NAME}`, resolved at load
time by [`src/config/loader.ts`](../../src/config/loader.ts). Missing
vars become empty strings — they don't error. That means:

```yaml
token: ${JIRA_TOKEN}
```

resolves to an empty string if `JIRA_TOKEN` isn't exported, and the
Jira connector will fail with a clear 401 at call time rather than
blowing up at config-load time. `ctx doctor` catches this early by
explicitly checking each source's required env vars.

---

## Three workflows, three ways to place your keys

### Workflow A — team / CI (recommended)
All secrets in env vars or CI secret store. `ctx.yaml` references
them via `${VAR}` and is fully committed. Nothing sensitive ever
touches git.

```yaml
ai:
  provider: anthropic
  # api_key omitted — picked up from ANTHROPIC_API_KEY
sources:
  github:
    - name: gh
      token: ${GITHUB_TOKEN}
      owner: acme
```

### Workflow B — solo developer, single machine
You can put `ai.api_key` literally in `ctx.yaml` **if** the file is in
`.gitignore` or in a private repo you fully trust. Env var still
overrides it, so you can temporarily swap keys without editing the file.

```yaml
# .gitignore should contain: ctx.yaml
ai:
  provider: anthropic
  api_key: sk-ant-xxxxxxxxxxxxxxxxx        # literal — DO NOT commit
```

### Workflow C — "one file, no env vars"
The middle ground: env var interpolation inside the yaml. The file is
committed, but references a named variable rather than the literal secret.

```yaml
ai:
  provider: anthropic
  api_key: ${ANTHROPIC_API_KEY}            # named but not literal
```

Functionally identical to Workflow A (env still resolves first), but
makes the dependency explicit in the file — useful as documentation of
"which keys does this project need?".

---

## On-prem / corporate network

If you're behind a corporate TLS-intercepting proxy or using self-hosted
Jira/Confluence/GitHub Enterprise Server, two environment variables
configure the whole tool:

```bash
# Trust the corporate CA bundle
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corp-ca.pem

# Route through the corporate proxy
export HTTPS_PROXY=http://proxy.corp.example.com:8080
export NO_PROXY=.corp.example.com,localhost
```

**On-prem Jira / Confluence** — drop `email:` and the connector switches
from Cloud Basic auth to Server/DC Bearer PAT auth automatically:

```yaml
sources:
  jira:
    - name: corp-jira
      base_url: https://jira.corp.example.com   # no email → Bearer PAT
      token: ${JIRA_TOKEN}
      project: ENG
  confluence:
    - name: corp-wiki
      base_url: https://confluence.corp.example.com
      token: ${CONFLUENCE_TOKEN}
      space: ENG
```

**GitHub Enterprise Server** — set `base_url` to your GHES host. The
connector auto-appends `/api/v3` if you forget it. Inside a GitHub
Actions workflow on GHES, you can omit both `token` and `base_url` —
the runner injects `GITHUB_TOKEN` and `GITHUB_API_URL` for you:

```yaml
sources:
  github:
    - name: corp-github
      base_url: https://github.corp.example.com   # /api/v3 auto-appended
      owner: platform
      token: ${GH_PAT}
```

Verify the setup:

```bash
ctx doctor              # shows Network section + source validation
ctx llm                 # confirms LLM is reachable
```

---

## Cross-references

- **[02-sources](02-sources.md)** — deep dive on each connector
- **[03-commands](03-commands.md)** — what each `ctx` subcommand does
- **[04-recipes](04-recipes.md)** — multi-repo, CI sync, monorepo patterns
- **[06-troubleshooting](06-troubleshooting.md)** — debugging config load errors
