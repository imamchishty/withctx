# GitHub Setup

This guide covers setting up a dedicated context repo on GitHub (or GitHub Enterprise), configuring GitHub Actions for auto-sync, and managing secrets.

## Creating the Context Repo

### Option A: New Repo on GitHub.com

```bash
# Create locally
mkdir acme-context && cd acme-context
git init
ctx init --name acme-platform

# Configure sources in ctx.yaml (see docs/guide/05-sources.md)

# Run initial ingest
ctx ingest

# Push to GitHub
gh repo create acme-corp/acme-context --private --source=. --push
```

### Option B: GitHub Enterprise (Self-Hosted)

```bash
mkdir acme-context && cd acme-context
git init
ctx init --name acme-platform

# Configure ctx.yaml with GHE URLs
```

In `ctx.yaml`, use your GHE host:

```yaml
repos:
  - name: api-service
    url: https://github.acme-corp.com/platform/acme-api
    paths:
      - README.md
      - docs/
      - src/routes/

sources:
  github:
    host: https://github.acme-corp.com/api/v3
    repos:
      - owner: platform
        repo: acme-api
        issues:
          state: open
          since: 90d
```

```bash
ctx ingest
git remote add origin https://github.acme-corp.com/platform/acme-context.git
git push -u origin main
```

## Configuring Secrets

The GitHub Action needs API tokens for each source. Add them in **GitHub > Settings > Secrets and variables > Actions**.

### Required Secrets

| Secret | Description | Where to get it |
|--------|-------------|-----------------|
| `ANTHROPIC_API_KEY` | Claude API key | console.anthropic.com |
| `GITHUB_TOKEN` | Auto-provided by Actions | Built-in (no setup needed) |

### Optional Secrets (per source)

| Secret | Description | Where to get it |
|--------|-------------|-----------------|
| `JIRA_EMAIL` | Atlassian account email | Your login email |
| `JIRA_TOKEN` | Jira API token | id.atlassian.com > Security > API tokens |
| `CONFLUENCE_EMAIL` | Same as JIRA_EMAIL | Same as above |
| `CONFLUENCE_TOKEN` | Same as JIRA_TOKEN | Same as above (shared for Cloud) |
| `TEAMS_TENANT_ID` | Azure AD tenant ID | portal.azure.com > Azure AD |
| `TEAMS_CLIENT_ID` | Azure app client ID | portal.azure.com > App registrations |
| `TEAMS_CLIENT_SECRET` | Azure app secret | portal.azure.com > App registrations |

### Setting Secrets via CLI

```bash
gh secret set ANTHROPIC_API_KEY --body "sk-ant-..."
gh secret set JIRA_EMAIL --body "you@acme-corp.com"
gh secret set JIRA_TOKEN --body "ATATT3x..."
gh secret set CONFLUENCE_EMAIL --body "you@acme-corp.com"
gh secret set CONFLUENCE_TOKEN --body "ATATT3x..."
```

## GitHub Action Workflow

### Basic Sync Workflow

Create `.github/workflows/sync.yml`:

```yaml
name: Sync Context Wiki

on:
  schedule:
    - cron: "0 6 * * 1-5"     # Weekdays at 6 AM UTC
  workflow_dispatch:            # Manual trigger

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 15

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
        run: ctx sync --verbose

      - name: Commit and push
        run: |
          git config user.name "withctx-bot"
          git config user.email "withctx-bot@users.noreply.github.com"
          git add .ctx/context/
          git diff --cached --quiet || git commit -m "chore: sync context wiki [$(date +%Y-%m-%d)]"
          git push
```

### Sync with Lint and Notifications

```yaml
name: Sync Context Wiki

on:
  schedule:
    - cron: "0 6 * * 1-5"
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install withctx
        run: npm install -g withctx

      - name: Sync wiki
        id: sync
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}
          JIRA_TOKEN: ${{ secrets.JIRA_TOKEN }}
        run: |
          ctx sync --verbose 2>&1 | tee sync-output.txt
          echo "pages_updated=$(grep -c 'Updated:' sync-output.txt || echo 0)" >> $GITHUB_OUTPUT

      - name: Lint wiki
        if: steps.sync.outputs.pages_updated != '0'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: ctx lint --json > lint-results.json
        continue-on-error: true

      - name: Commit and push
        run: |
          git config user.name "withctx-bot"
          git config user.email "withctx-bot@users.noreply.github.com"
          git add .ctx/context/
          git diff --cached --quiet || git commit -m "chore: sync context wiki"
          git push

      - name: Report issues
        if: always()
        run: |
          if [ -f lint-results.json ]; then
            ISSUES=$(jq '.summary.total' lint-results.json)
            if [ "$ISSUES" -gt 0 ]; then
              echo "::warning::Wiki has $ISSUES quality issues. Run ctx lint locally for details."
            fi
          fi
```

### Trigger on PR Merge

For high-activity teams, sync when code merges to main:

```yaml
name: Sync on Merge

on:
  repository_dispatch:
    types: [ctx-sync]
  push:
    branches: [main]
    paths:
      - "src/**"
      - "docs/**"

# ... same job as above
```

In each service repo, add a dispatch trigger:

```yaml
# In acme-api/.github/workflows/notify-context.yml
name: Notify Context Repo

on:
  push:
    branches: [main]

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger context sync
        run: |
          gh api repos/acme-corp/acme-context/dispatches \
            --method POST \
            --field event_type=ctx-sync
        env:
          GITHUB_TOKEN: ${{ secrets.CONTEXT_REPO_TOKEN }}
```

## Self-Hosted Runners

For GitHub Enterprise or when you need access to internal network resources (self-hosted Jira, Confluence behind VPN):

```yaml
jobs:
  sync:
    runs-on: self-hosted    # Uses your self-hosted runner
    timeout-minutes: 15
    # ... rest of steps
```

Ensure your self-hosted runner has:
- Node.js 20+ installed
- Network access to Jira, Confluence, Teams APIs
- withctx installed globally or available in PATH

## Browsing the Wiki on GitHub

Once pushed, the wiki is browsable at:

```
https://github.com/acme-corp/acme-context/tree/main/.ctx/context
```

The `index.md` serves as the entry point. GitHub renders markdown natively, so cross-references between pages work as links.

### Tips for GitHub Browsing

- Bookmark `.ctx/context/index.md` for quick access
- Use GitHub search to search within the wiki: `path:.ctx/context "payment"`
- Pin the context repo in your GitHub organization for discoverability
- Add a link to the context repo in each service repo's README:

```markdown
## Project Context

Full project context wiki: [acme-context](https://github.com/acme-corp/acme-context/tree/main/.ctx/context)
```

## Repository Settings

### Recommended Settings

- **Visibility:** Private (unless your project is open source)
- **Branch protection:** Enable on main — require PR for manual changes
- **CODEOWNERS:** Add team leads as owners of `ctx.yaml`

```
# CODEOWNERS
ctx.yaml @acme-corp/platform-leads
.ctx/context/ @acme-corp/platform-leads
```

- **Auto-delete branches:** Enable to keep the repo clean
- **Default branch:** main
