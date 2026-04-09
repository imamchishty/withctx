# Microservices Guide

A dedicated guide for teams running multiple services across multiple repositories.

---

## Why Multi-Repo Is the Default Assumption

Most teams building microservices have one repository per service. withctx is designed for this. It creates a single unified wiki that spans all your repos, so engineers and AI agents understand the whole system, not just one slice of it.

```
acme/
  api-service/          # Repo 1
  auth-service/         # Repo 2
  web-app/              # Repo 3
  payments-worker/      # Repo 4
  notification-service/ # Repo 5
  context/              # Dedicated context repo — the wiki lives here
```

The dedicated `context/` repo is where withctx stores the compiled wiki. It references all the other repos plus external sources like Jira, Confluence, and Slack.

---

## Quick Start with ctx setup

The interactive wizard walks you through connecting all your repos and sources.

```bash
mkdir acme-context && cd acme-context
ctx setup
```

```
Welcome to withctx setup!

? Project name: acme-platform
? Description: E-commerce platform — 5 services, 3 teams
? Organization name (for multi-repo): acme

Detecting repositories...
? Add GitHub repo? (Y/n) Y
  ? Repository URL: https://github.com/acme/api-service
  ? Paths to include: README.md, docs/, src/routes/, src/models/
  Added: api-service

? Add another repo? (Y/n) Y
  ? Repository URL: https://github.com/acme/auth-service
  ...

? Connect Jira? (y/N) y
  ? Host: https://acme.atlassian.net
  ? Projects: ACME, INFRA

? Run initial ingest now? (Y/n) Y

Ingesting 5 repos + 2 Jira projects...
Wiki compiled: 24 pages from 616 sources.
```

---

## Quick Start with ctx go

If you prefer speed over guidance:

```bash
mkdir acme-context && cd acme-context
ctx go --org acme
```

This creates a `ctx.yaml` pre-configured for a multi-repo org and starts ingestion immediately. You can edit `ctx.yaml` afterward to fine-tune sources.

---

## How the Context Repo Works

The context repo is a regular git repository. It contains your wiki and configuration, but none of your source code.

```
acme-context/
├── ctx.yaml                    # All repos + sources configured here
├── .ctx/
│   ├── context/                # The compiled wiki
│   │   ├── index.md            # Page catalog
│   │   ├── overview.md         # Platform summary
│   │   ├── architecture.md     # Services, dependencies, infrastructure
│   │   ├── conventions.md      # Shared coding standards
│   │   ├── decisions.md        # Architecture decision records
│   │   ├── repos/
│   │   │   ├── api-service/
│   │   │   │   ├── overview.md
│   │   │   │   ├── patterns.md
│   │   │   │   └── ci.md
│   │   │   ├── auth-service/
│   │   │   └── web-app/
│   │   ├── cross-repo/
│   │   │   ├── dependencies.md     # Which service calls which
│   │   │   ├── data-flow.md        # How data moves through the system
│   │   │   └── deployment-order.md # Safe deploy sequence
│   │   ├── services/
│   │   │   ├── payments.md
│   │   │   └── auth.md
│   │   └── manual/             # Manually added context
│   ├── sources/                # Cached raw data (gitignored)
│   └── costs.json              # Usage tracking (gitignored)
├── .github/
│   └── workflows/
│       └── sync.yml            # Auto-sync workflow
└── .gitignore
```

Commit the wiki to git. This makes it:
- **Browsable on GitHub** — anyone can read `architecture.md` without installing anything
- **Versioned** — see how the wiki evolved over time
- **Shareable** — new engineers clone the context repo to get full project knowledge

---

## Cross-Repo Features

The most valuable part of a multi-repo wiki is the cross-repo intelligence. withctx automatically generates these pages:

### dependencies.md

Maps which service depends on which. Generated from code analysis (imports, API calls, config references) and Jira/Confluence data.

```markdown
## Service Dependencies

api-service
  → auth-service (JWT validation, user lookup)
  → payments-worker (async payment processing via SQS)
  → PostgreSQL (primary data store)
  → Redis (session cache, rate limiting)

auth-service
  → PostgreSQL (user accounts, refresh tokens)
  → api-service (webhook callbacks)

web-app
  → api-service (all data via REST API)
  → auth-service (login, token refresh)
```

### data-flow.md

Shows how data moves through the system — which service produces data, which consumes it, and through what mechanism (API, queue, database, etc.).

### deployment-order.md

Determines the safe order to deploy services based on their dependencies. Critical for avoiding downtime during releases.

---

## GitHub Actions Auto-Sync

Set up automatic wiki updates whenever code changes. Create `.github/workflows/sync.yml` in your context repo:

```yaml
name: Sync Wiki

on:
  schedule:
    - cron: '0 */6 * * *'        # Every 6 hours
  workflow_dispatch:               # Manual trigger

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install withctx
        run: npm install -g withctx

      - name: Sync wiki
        run: ctx sync --verbose
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}
          JIRA_TOKEN: ${{ secrets.JIRA_TOKEN }}

      - name: Commit changes
        run: |
          git config user.name "withctx-bot"
          git config user.email "withctx@users.noreply.github.com"
          git add .ctx/context/
          git diff --staged --quiet || git commit -m "chore: sync wiki"
          git push
```

Add your secrets in the repository settings (Settings > Secrets and variables > Actions).

---

## Example ctx.yaml for a 5-Service Platform

```yaml
project: acme-platform
description: >
  E-commerce platform with API gateway, authentication, payments,
  notifications, and web frontend. 5 services, 3 teams.

# Multi-repo: reference each service repository
repos:
  - name: api-service
    url: https://github.com/acme/api-service
    branch: main
    paths:
      - README.md
      - docs/
      - src/routes/
      - src/models/
      - src/middleware/
    exclude:
      - "**/*.test.ts"
      - "**/fixtures/**"

  - name: auth-service
    url: https://github.com/acme/auth-service
    branch: main
    paths:
      - README.md
      - docs/
      - src/

  - name: web-app
    url: https://github.com/acme/web-app
    branch: main
    paths:
      - README.md
      - docs/
      - src/pages/
      - src/components/
      - src/api/

  - name: payments-worker
    url: https://github.com/acme/payments-worker
    branch: main
    paths:
      - README.md
      - src/

  - name: notification-service
    url: https://github.com/acme/notification-service
    branch: main
    paths:
      - README.md
      - src/

# External sources
sources:
  jira:
    host: https://acme.atlassian.net
    projects:
      - key: ACME
        components: [api, auth, payments, web, notifications]
      - key: INFRA
    jql: "status != Cancelled AND updated >= -90d"
    include_comments: true
    max_issues: 500

  confluence:
    host: https://acme.atlassian.net/wiki
    spaces:
      - key: ENG
        labels: [architecture, runbook, onboarding]
      - key: ARCH

  slack:
    - name: engineering
      channels:
        - engineering-general
        - architecture-decisions
        - incidents
      since: 90d

  cicd:
    - name: api-builds
      provider: github-actions
      repo: acme/api-service
    - name: auth-builds
      provider: github-actions
      repo: acme/auth-service

  pull-requests:
    - name: api-prs
      repo: acme/api-service
      include: merged
      since: 30d
    - name: auth-prs
      repo: acme/auth-service
      include: merged
      since: 30d

# Wiki settings
wiki:
  cross_repo: true               # Generate cross-repo analysis pages
  index: true                    # Generate index.md catalog

# Cost controls
costs:
  budget: 50                     # Monthly budget in dollars
  model: claude-sonnet-4         # Recommended for production
```

---

## Tips for Large Teams

1. **Start small, then expand.** Begin with 2-3 core repos and add more as you verify the wiki quality.

2. **Use labels in Jira/Confluence.** Filter by labels like `architecture` or `runbook` rather than ingesting everything. Less noise means a better wiki.

3. **Schedule syncs, not full ingests.** Use `ctx sync` in CI (incremental, cheap) rather than `ctx ingest` (full recompile, expensive). Reserve `ctx ingest` for major changes.

4. **Set a cost budget.** The `costs.budget` setting prevents runaway costs. A 5-service team typically costs $10-40/month.

5. **Commit the wiki to git.** This makes the wiki browsable on GitHub and searchable with standard tools. New engineers can read it without installing withctx.

6. **Use `ctx review` in CI.** Add context-aware PR reviews to your pull request workflow for all repos. The review uses cross-repo knowledge to catch issues that per-repo linters miss.
