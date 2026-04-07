# Multi-Repo Setup

For teams with multiple repositories, withctx uses a dedicated context repo that aggregates knowledge across all repos, Jira projects, Confluence spaces, and Teams channels.

## When to Use This

- Multiple repositories that form one product or platform
- Multiple teams contributing to a shared system
- You want a single source of truth for project context
- You want GitHub Actions to keep the wiki auto-synced

## Architecture

```
GitHub:
  acme-context/          # Dedicated context repo
    .ctx/context/        # Compiled wiki (all repos, all sources)
    ctx.yaml             # Configuration pointing to all sources
    .github/workflows/
      sync.yml           # Auto-sync on schedule or trigger

  acme-api/              # Service repo
  acme-auth/             # Service repo
  acme-web/              # Frontend repo
```

Engineers browse `acme-context` on GitHub to read the wiki. Agents pull context from it before writing code in any service repo.

## Step 1: Create the Context Repo

```bash
mkdir acme-context && cd acme-context
git init
ctx init
```

## Step 2: Configure ctx.yaml

```yaml
# ctx.yaml
project: acme-platform
description: >
  E-commerce platform comprising API service, auth service,
  and web application.

repos:
  - name: api-service
    url: https://github.com/acme-corp/acme-api
    paths:
      - README.md
      - docs/
      - src/routes/
      - src/models/
    exclude:
      - "**/*.test.ts"

  - name: auth-service
    url: https://github.com/acme-corp/acme-auth
    paths:
      - README.md
      - docs/
      - src/

  - name: web-app
    url: https://github.com/acme-corp/acme-web
    paths:
      - README.md
      - docs/
      - src/pages/
      - src/components/

sources:
  jira:
    host: https://acme-corp.atlassian.net
    projects:
      - key: ACME
        components: [api, auth, web]
      - key: INFRA
    jql: "status != Cancelled AND updated >= -90d"

  confluence:
    host: https://acme-corp.atlassian.net/wiki
    spaces:
      - key: ENG
      - key: ARCH

  teams:
    channels:
      - team: Engineering
        channel: general
      - team: Engineering
        channel: architecture-decisions

  local:
    paths:
      - ./overrides/     # Manual overrides and corrections
```

## Step 3: Set Up Authentication

Create a `.env` file (gitignored) with tokens for each source:

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...
JIRA_EMAIL=you@acme-corp.com
JIRA_TOKEN=ATATT...
CONFLUENCE_EMAIL=you@acme-corp.com
CONFLUENCE_TOKEN=ATATT...
TEAMS_TENANT_ID=...
TEAMS_CLIENT_ID=...
TEAMS_CLIENT_SECRET=...
```

## Step 4: Run Initial Ingest

```bash
ctx ingest
```

```
 Reading sources...
  Repos: 3 repositories cloned
    api-service: 24 files
    auth-service: 16 files
    web-app: 31 files
  Jira: 2 projects, 187 issues fetched
  Confluence: 2 spaces, 43 pages fetched
  Teams: 2 channels, 312 messages fetched
  Local: 3 files found
 Compiling wiki pages...
  Created: index.md
  Created: architecture/overview.md
  Created: architecture/auth.md
  Created: architecture/data-model.md
  Created: architecture/infrastructure.md
  Created: repos/api-service.md
  Created: repos/auth-service.md
  Created: repos/web-app.md
  Created: decisions/adr-007-oauth.md
  Created: decisions/adr-012-graphql-bff.md
  Created: api/routes.md
  Created: api/error-handling.md
  Created: onboarding/getting-started.md
  Created: onboarding/local-development.md
 Wiki compiled: 14 pages from 616 sources
 Tokens used: ~145,000 input, ~28,000 output
 Cost: ~$0.85
```

## Step 5: Push to GitHub

```bash
git add .ctx/context/ ctx.yaml .github/
git commit -m "feat: initial context wiki compiled from all sources"
git push origin main
```

## Step 6: Set Up Auto-Sync with GitHub Actions

Create `.github/workflows/sync.yml`:

```yaml
name: Sync Context Wiki

on:
  schedule:
    - cron: "0 6 * * 1-5"   # Weekdays at 6 AM UTC
  workflow_dispatch:          # Manual trigger

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install withctx
        run: npm install -g withctx

      - name: Sync wiki
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}
          JIRA_TOKEN: ${{ secrets.JIRA_TOKEN }}
          CONFLUENCE_EMAIL: ${{ secrets.CONFLUENCE_EMAIL }}
          CONFLUENCE_TOKEN: ${{ secrets.CONFLUENCE_TOKEN }}
        run: ctx sync

      - name: Commit changes
        run: |
          git config user.name "withctx-bot"
          git config user.email "withctx-bot@users.noreply.github.com"
          git add .ctx/context/
          git diff --cached --quiet || git commit -m "chore: sync context wiki"
          git push
```

Add your secrets in **GitHub > Settings > Secrets and variables > Actions**.

## How Engineers Use It

### Browse on GitHub

Navigate to `acme-context` on GitHub and read the wiki pages directly. The `index.md` page serves as the entry point with links to all topics.

### Query from any repo

From any service repo, point ctx at the context repo:

```bash
# In acme-api/
ctx query --context https://github.com/acme-corp/acme-context "How does auth work?"
```

Or clone the context repo locally and reference it:

```bash
ctx query --context ../acme-context "What are the API conventions?"
```

### Pull context for agents

```bash
# From the context repo, generate a scoped context file
cd acme-context
ctx pack --scope repos/api-service --output ../acme-api/CLAUDE.md

# Or generate context for the whole platform
ctx pack --output CLAUDE.md
```

## How Agents Use It

An AI agent working in `acme-api` reads the compiled context before generating code:

```bash
# In the agent's workflow
ctx pack --context ../acme-context --scope repos/api-service --budget 8000
# Output piped to agent's system prompt or CLAUDE.md
```

The agent now knows the API conventions, auth flow, data model, and recent decisions — not just what is in the current repo.

## Keeping Multiple Repos in Sync

When the GitHub Action runs, it:

1. Clones all configured repos (shallow clone, latest commit)
2. Fetches recent Jira, Confluence, and Teams updates
3. Runs `ctx sync` which only recompiles pages affected by changes
4. Commits and pushes updated wiki pages

The wiki stays fresh without any manual effort.
