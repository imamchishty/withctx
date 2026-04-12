# 2. Sources

Every supported source. For each: env vars, the `ctx.yaml` snippet, what shows up in the wiki.

The fastest way to add a source is interactively:

```bash
ctx add jira          # walks you through env vars + writes ctx.yaml
ctx add confluence
ctx add github
ctx add slack
ctx add notion
ctx add sharepoint
ctx add teams
```

Below are the manual snippets if you'd rather edit `ctx.yaml` directly.

---

## Local files (default — no setup)

```yaml
sources:
  - type: local
    paths: ["."]
    exclude: ["node_modules", "dist", ".git"]
```

Picks up `*.md`, `README*`, `ARCHITECTURE*`, source code. Markdown files are run through doc-type detection (architecture, api, onboarding, etc.) so the wiki gets accurate categories.

---

## Jira

```bash
export JIRA_BASE_URL=https://yourco.atlassian.net
export JIRA_EMAIL=you@yourco.com
export JIRA_TOKEN=...    # https://id.atlassian.com/manage-profile/security/api-tokens
```

```yaml
sources:
  - type: jira
    project: ENG          # required
    jql: "updated >= -90d"  # optional, default: last 90 days
    max_results: 500
```

Wiki gets: ticket summaries, decisions, blockers, ownership signals. Big differentiator — most knowledge is in tickets, not docs.

> **On-prem / self-hosted (Jira Server & Data Center):**
> Drop the `JIRA_EMAIL` env var — withctx switches from Cloud Basic auth to Bearer PAT auth automatically. Set `JIRA_TOKEN` to a Jira Personal Access Token and `JIRA_BASE_URL` to your server URL. Everything else in the yaml stays the same.

---

## Confluence

```bash
export CONFLUENCE_BASE_URL=https://yourco.atlassian.net/wiki
export CONFLUENCE_EMAIL=you@yourco.com
export CONFLUENCE_TOKEN=...
```

```yaml
sources:
  - type: confluence
    space: ENG                  # single space
    # or:  space: [ENG, OPS, ARCH]   # multiple
    cql: "lastModified > now('-90d')"
```

Pages are split into sections, doc-type-detected, cross-references resolved.

> **On-prem / self-hosted (Confluence Server & Data Center):**
> Cloud `CONFLUENCE_BASE_URL` includes `/wiki` (e.g. `https://yourco.atlassian.net/wiki`). For Server/DC, use the host root directly (e.g. `https://confluence.internal.yourco.com`) — withctx does not auto-append `/wiki`.

---

## GitHub

```bash
export GITHUB_TOKEN=ghp_...     # repo + read:org
```

```yaml
sources:
  - type: github
    repos:
      - owner/repo-1
      - owner/repo-2
    include: ["README.md", "docs/**/*.md", "ARCHITECTURE.md"]
```

For multi-repo setups (monorepo, sibling repos, remote-only, or CI-driven shared wiki) see the **Multi-repo / monorepo / microservices** recipe in [04-recipes.md](04-recipes.md).

> **On-prem / self-hosted (GitHub Enterprise Server):**
> Set `GITHUB_BASE_URL` to your GHES host (e.g. `https://github.internal.yourco.com`). withctx auto-appends `/api/v3`. When running inside **GitHub Actions**, you can omit both `GITHUB_TOKEN` and `GITHUB_BASE_URL` — the runner injects them automatically via the `GITHUB_TOKEN` secret and `GITHUB_API_URL` env var.

---

## Slack

```bash
export SLACK_BOT_TOKEN=xoxb-...    # needs channels:history, channels:read
```

```yaml
sources:
  - type: slack
    channels: ["eng-decisions", "incidents", "architecture"]
    days: 90
```

Best used for *decision* channels — `#eng-decisions`, `#incidents`, `#architecture`. Don't point it at `#general`.

---

## Notion

```bash
export NOTION_API_KEY=secret_...
```

```yaml
sources:
  - type: notion
    database_id: 1234abcd...
```

Share the database with the integration first (Notion → Settings → Connections).

---

## SharePoint

```bash
export TEAMS_TENANT_ID=...       # Azure AD tenant
export TEAMS_CLIENT_ID=...       # App registration client ID
export TEAMS_CLIENT_SECRET=...   # App registration client secret
```

Uses Microsoft Graph API with the same Azure AD app registration as Teams (see below). The app needs `Sites.Read.All` permission.

```yaml
sources:
  sharepoint:
    - name: eng-drive
      site: acme.sharepoint.com/sites/engineering
      paths: [/Shared Documents/Handbook]
      filetypes: [.docx, .pdf, .xlsx]
    - name: finance-drive
      site: acme.sharepoint.com/sites/finance
      files: [/Shared Documents/FY24/budget.xlsx]
```

Multi-site is first-class — each entry targets a different SharePoint site. Use `paths` for entire folder trees or `files` for specific documents. `filetypes` filters by extension (default: all supported types).

Wiki gets: document content, folder structure, metadata. Spreadsheets are extracted as structured tables, Word docs and PDFs as sectioned text.

---

## Teams

```bash
export TEAMS_TENANT_ID=...       # Azure AD tenant
export TEAMS_CLIENT_ID=...       # App registration client ID
export TEAMS_CLIENT_SECRET=...   # App registration client secret
```

Same Azure AD app registration as SharePoint. The app needs `ChannelMessage.Read.All` permission.

```yaml
sources:
  - type: teams
    teams: ["Engineering", "Platform"]
    channels: ["General", "Architecture Decisions", "Incidents"]
    days: 90
```

Like Slack, best pointed at decision and incident channels rather than general chat. Messages are threaded, so replies stay grouped with their parent.

Wiki gets: channel messages, threaded discussions, decision records. Cross-references Teams messages with SharePoint links when both sources are configured.

---

## Pattern: per-environment overrides

```yaml
sources:
  - type: jira
    project: ENG
    jql: "${JQL_FILTER:-updated >= -90d}"
```

Use shell vars to switch JQL/CQL between dev and CI without forking config.

---

## AI provider — swap out Anthropic

withctx supports four LLM providers out of the box. Set `ai.provider` in `ctx.yaml` and withctx uses that provider's SDK — different wire protocol, different env var, different pricing.

| Provider | `ai.provider` | Env var | Default model |
|---|---|---|---|
| Anthropic (default) | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| Google Gemini | `google` | `GOOGLE_API_KEY` | `gemini-2.0-flash` |
| Ollama (local) | `ollama` | — | `llama3` |

### Examples

**Anthropic through a gateway** (LiteLLM, Portkey, Cloudflare AI Gateway — anything Anthropic-compatible):

```yaml
ai:
  provider: anthropic
  base_url: https://my-gateway.example.com
```

**OpenAI-compatible endpoint** (OpenAI itself, Azure OpenAI via proxy, vLLM, LM Studio, any `/v1/chat/completions` server):

```yaml
ai:
  provider: openai
  model: gpt-4o-mini
  base_url: https://my-openai-gateway.example.com/v1   # optional — defaults to api.openai.com/v1
```

**Local Ollama** — zero API keys, runs on your laptop:

```yaml
ai:
  provider: ollama
  model: llama3:70b
  base_url: http://localhost:11434   # optional
```

**Google Gemini**:

```yaml
ai:
  provider: google
  model: gemini-2.0-flash
```

### Per-operation model overrides

Mix providers inside a single project — cheap model for ingest, smart model for chat:

```yaml
ai:
  provider: anthropic
  model: claude-sonnet-4-20250514    # default for everything
  models:
    ingest: gpt-4o-mini              # auto-switches to OpenAI
    query:  claude-sonnet-4-20250514
    review: gemini-2.0-flash         # auto-switches to Google
```

withctx detects the provider from the model prefix (`claude-*` → anthropic, `gpt-*`/`o1-*`/`o3-*` → openai, `gemini-*` → google, `llama*`/`mistral*`/`qwen*` → ollama) so you just name the model.

### Env-var fallbacks

If `ai.base_url` is not set, withctx honours the SDK-native env var (`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`). The `ctx.yaml` value wins when both are set.

### Verify the wiring

Run `ctx doctor` after changing provider. It shows the resolved provider, the model, and the URL being hit:

```
✓ [anthropic] API connection: Connected (claude-sonnet-4-20250514)
✓ [openai]    API connection: Connected (gpt-4o) via https://my-gateway.example.com/v1
✓ [ollama]    API connection: Connected (llama3) via http://localhost:11434
```

If you swap providers and forget the matching env var, `ctx doctor` tells you exactly which one to export.

---

## What withctx does NOT need

- A vector DB (SQLite chunks live in `.ctx/`)
- A separate worker process
- Anything other than the env vars above

If you're hitting auth errors, run `ctx doctor` — it tests every configured source's credentials and tells you exactly which env var is missing.
