# Sync and Freshness

The wiki is only useful if it stays current. withctx provides commands to incrementally update the wiki, check what has changed, and monitor freshness.

## ctx sync

Incremental update. Checks all configured sources for changes since the last sync and updates only the affected wiki pages.

```bash
ctx sync
```

```
 Checking for changes since 2025-01-18...
  Jira: 3 issues updated (ACME-198, ACME-201, ACME-203)
  GitHub: api-service 5 commits, auth-service PR #47 merged
  Confluence: ENG/Auth Design modified
  Teams: 12 new messages in architecture-decisions
  Local: 1 file modified (docs/api-reference.md)

 Updating wiki pages...
  Updated: architecture/auth.md (3 sections refreshed)
  Updated: api/routes.md (new endpoint added)
  Updated: repos/auth-service.md (PR #47 changes)
  Unchanged: 11 pages (no relevant changes)

 Sync complete: 3 pages updated, 11 unchanged
 Tokens used: ~18,000 input, ~4,200 output
 Cost: ~$0.11
```

### How Sync Works

1. **Change detection** — Each connector checks for updates since the last sync timestamp
   - Jira: issues updated after last sync
   - Confluence: pages modified after last sync
   - GitHub: commits and PRs after last sync
   - Teams: messages after last sync
   - Local files: modified time comparison
2. **Dependency mapping** — Determines which wiki pages are affected by the changed sources
3. **Selective recompilation** — Only affected pages are sent to Claude for update
4. **Log entry** — Changes recorded in `log.md`

### Sync Options

```bash
# Sync only Jira changes
ctx sync --source jira

# Preview what would change without actually updating
ctx sync --dry-run

# Verbose output showing each source check
ctx sync --verbose
```

### Dry Run

```bash
ctx sync --dry-run
```

```
 Dry run — no changes will be made

 Changes detected since 2025-01-18:
  Jira: ACME-198 (closed), ACME-201 (created), ACME-203 (updated)
  GitHub: api-service — 5 commits on main

 Pages that would be updated:
  architecture/auth.md
  api/routes.md

 Estimated cost: ~$0.08
```

## ctx diff

Show what has changed in sources without making any updates. Lighter than `ctx sync --dry-run` because it does not compute which wiki pages would be affected.

```bash
ctx diff
```

```
Changes since last sync (2025-01-18):

 Jira:
   ACME-198  status: In Progress → Done
   ACME-201  created: "Add rate limiting to auth endpoints"
   ACME-203  updated: description revised

 GitHub:
   api-service:
     abc1234  feat: add /v2/payments/refund endpoint
     def5678  fix: handle null amount in refund
     ghi9012  chore: update Fastify to 4.25
   auth-service:
     PR #47   merged: "Add refresh token rotation"

 Confluence:
   ENG/Auth Design — last modified: 2025-01-19 14:30

 Teams:
   architecture-decisions: 12 messages since last sync

 Local:
   docs/api-reference.md — modified 2025-01-19
```

`ctx diff` is free — it does not call Claude. It only checks source APIs and file timestamps.

## ctx status

Show the current state of the wiki with a freshness report.

```bash
ctx status
```

```
Project: acme-platform
Wiki:    .ctx/context/
Pages:   14

Sources:
  Local files     18 files
  Jira            2 projects, 187 issues
  Confluence      2 spaces, 43 pages
  GitHub          3 repos
  Teams           2 channels

Timing:
  Last ingest:    2025-01-15 10:32:00
  Last sync:      2025-01-18 06:00:00

Freshness:
   12 pages current
    2 pages may be stale

Stale pages:
  architecture/auth.md
    Sources changed: ACME-198 (Jira), ENG/Auth Design (Confluence),
                     auth-service PR #47 (GitHub)
    Last updated: 2025-01-18

  api/routes.md
    Sources changed: api-service 3 commits (GitHub)
    Last updated: 2025-01-18
```

`ctx status` is free — no Claude calls. It compares source timestamps against wiki page timestamps.

### JSON Output

```bash
ctx status --json
```

Useful for monitoring dashboards or CI checks.

## Pruning Stale Content

When sources are removed or topics become irrelevant, the wiki may contain pages that no longer have backing sources. Sync detects this:

```bash
ctx sync
```

```
 Checking for changes...
 Stale page detected: decisions/adr-003-redis.md
   All sources for this page have been removed or archived
   Action: Page will be marked as archived

 Updated: decisions/adr-003-redis.md
   Added archive notice: "This decision has been superseded. Sources
   no longer available."
```

Sync does not delete pages. It marks them as archived with a notice. To remove archived pages:

```bash
ctx sync --prune
```

```
 Pruning archived pages...
  Removed: decisions/adr-003-redis.md (archived, no sources)
  Removed: conventions/old-testing-guide.md (archived, no sources)
 Pruned: 2 pages
```

## Auto-Sync with GitHub Actions

The recommended setup runs sync automatically on weekdays:

```yaml
# .github/workflows/sync.yml
name: Sync Context Wiki

on:
  schedule:
    - cron: "0 6 * * 1-5"    # Weekdays at 6 AM UTC
  workflow_dispatch:           # Manual trigger button

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

      - name: Lint wiki
        run: ctx lint --json > lint-results.json
        continue-on-error: true

      - name: Commit changes
        run: |
          git config user.name "withctx-bot"
          git config user.email "withctx-bot@users.noreply.github.com"
          git add .ctx/context/
          git diff --cached --quiet || git commit -m "chore: sync context wiki"
          git push
```

### Sync Frequency Guidelines

| Team size | Repo activity | Recommended frequency |
|-----------|--------------|----------------------|
| 1-5 engineers | Low | Weekly (Monday morning) |
| 5-15 engineers | Medium | Daily (weekday mornings) |
| 15+ engineers | High | Twice daily or on-demand |

For high-activity teams, consider triggering sync from CI when PRs merge:

```yaml
on:
  push:
    branches: [main]
    paths:
      - "src/**"
      - "docs/**"
```

## Freshness Monitoring

For teams that want visibility into wiki freshness, add a status check:

```bash
# In CI, fail if wiki is more than 7 days stale
STALE=$(ctx status --json | jq '[.pages[] | select(.stale == true)] | length')
if [ "$STALE" -gt 0 ]; then
  echo "::warning::$STALE wiki pages are stale — run ctx sync"
fi
```
