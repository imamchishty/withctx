# 2. Sources

Every supported source. For each: env vars, the `ctx.yaml` snippet, what shows up in the wiki.

The fastest way to add a source is interactively:

```bash
ctx add jira          # walks you through env vars + writes ctx.yaml
ctx add confluence
ctx add github
ctx add slack
ctx add notion
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

## Pattern: per-environment overrides

```yaml
sources:
  - type: jira
    project: ENG
    jql: "${JQL_FILTER:-updated >= -90d}"
```

Use shell vars to switch JQL/CQL between dev and CI without forking config.

---

## What withctx does NOT need

- A vector DB (SQLite chunks live in `.ctx/`)
- A separate worker process
- Anything other than the env vars above

If you're hitting auth errors, run `ctx doctor` — it tests every configured source's credentials and tells you exactly which env var is missing.
