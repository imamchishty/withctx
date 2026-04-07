# Lint

`ctx lint` checks the compiled wiki for quality issues. It uses Claude to analyze the wiki and report problems that a human reviewer would catch: contradictions between pages, stale content, orphan pages with no cross-references, and gaps where pages should exist but do not.

## Running Lint

```bash
ctx lint
```

```
 Linting wiki: 14 pages...

 Issues found: 5

  CONTRADICTION  architecture/auth.md says "15-minute JWT expiry"
                 but repos/auth-service.md says "30-minute JWT expiry"
                 Recommendation: Check auth-service/src/config.ts for the actual value

  STALE          decisions/adr-007-oauth.md references "planned migration to OAuth"
                 but architecture/auth.md confirms migration is complete
                 Recommendation: Update ADR to reflect completed status

  ORPHAN         conventions/git-workflow.md is not linked from any other page
                 Recommendation: Add link from index.md and onboarding/getting-started.md

  MISSING        No page covers deployment/CI-CD pipeline
                 Referenced in: architecture/infrastructure.md, onboarding/getting-started.md
                 Recommendation: Create architecture/deployment.md from infrastructure sources

  GAP            api/routes.md documents /v1/ endpoints but no /v2/ routes
                 Found /v2/ references in: ACME-195, ACME-201 (Jira)
                 Recommendation: Run ctx sync to pick up recent Jira tickets

 Summary: 1 contradiction, 1 stale, 1 orphan, 1 missing, 1 gap
```

## What Lint Checks

### Contradictions

Two or more wiki pages state conflicting facts. Lint identifies the specific claims and where they appear.

Common causes:
- One page was updated during sync but another was not
- Manual context conflicts with compiled content
- Source data itself is contradictory

### Stale Content

Content that references something as planned, upcoming, or in-progress when other evidence suggests it is already done (or abandoned).

Common causes:
- Decision records not updated after implementation
- Confluence pages describing a future state that has since been built
- Jira tickets closed but wiki not yet synced

### Orphan Pages

Pages that exist but are not linked from any other page. These are hard to discover and may indicate the page is no longer relevant, or that cross-references are missing.

### Missing Pages

Topics referenced in multiple pages but without their own dedicated page. If three pages mention "deployment pipeline" but no `architecture/deployment.md` exists, lint flags it.

### Gaps

Sections within pages that are incomplete or reference topics not covered. For example, a routes page that documents v1 endpoints but not v2 even though v2 exists in the source data.

## Auto-Fix

Lint can attempt to fix some issues automatically:

```bash
ctx lint --fix
```

```
 Linting wiki: 14 pages...
 Issues found: 5
 Auto-fixing...

   Fixed: ORPHAN — Added link to conventions/git-workflow.md from index.md
   Fixed: GAP — Updated api/routes.md with /v2/ routes from Jira sources
   Skipped: CONTRADICTION — Requires manual review (auth.md vs auth-service.md)
   Skipped: STALE — Requires manual review (adr-007-oauth.md)
   Skipped: MISSING — Would create new page (run ctx sync first)

 Fixed: 2, Skipped: 3 (require manual review or sync)
```

Auto-fix handles:
- Adding missing cross-reference links (orphan pages)
- Filling gaps when the source data is available
- Updating index.md to reflect current wiki structure

Auto-fix does NOT handle:
- Contradictions (requires human judgment on which is correct)
- Stale content (requires verifying the current state)
- Creating new pages (use `ctx sync` or `ctx ingest` instead)

## JSON Output

For CI or programmatic use:

```bash
ctx lint --json
```

```json
{
  "pages": 14,
  "issues": [
    {
      "type": "contradiction",
      "severity": "high",
      "pages": ["architecture/auth.md", "repos/auth-service.md"],
      "description": "JWT expiry: 15 minutes vs 30 minutes",
      "recommendation": "Check auth-service/src/config.ts"
    },
    {
      "type": "stale",
      "severity": "medium",
      "pages": ["decisions/adr-007-oauth.md"],
      "description": "References planned migration that is already complete",
      "recommendation": "Update ADR status to completed"
    }
  ],
  "summary": {
    "contradictions": 1,
    "stale": 1,
    "orphans": 1,
    "missing": 1,
    "gaps": 1,
    "total": 5
  }
}
```

## Running Lint in CI

Add lint to your GitHub Action alongside sync:

```yaml
- name: Lint wiki
  run: |
    ctx lint --json > lint-results.json
    ISSUES=$(jq '.summary.total' lint-results.json)
    if [ "$ISSUES" -gt 0 ]; then
      echo "::warning::Wiki has $ISSUES quality issues"
    fi
```

To fail the pipeline on high-severity issues:

```yaml
- name: Lint wiki (strict)
  run: |
    CONTRADICTIONS=$(ctx lint --json | jq '.summary.contradictions')
    if [ "$CONTRADICTIONS" -gt 0 ]; then
      echo "::error::Wiki has contradictions that need resolution"
      exit 1
    fi
```

## When to Run Lint

- **After ingest** — catch issues in the initial compilation
- **After sync** — verify updates did not introduce contradictions
- **In CI** — run on every sync to catch issues early
- **Periodically** — weekly lint catches drift that accumulates between syncs

## Cost

Lint calls Claude to analyze the wiki. For a 14-page wiki, a lint run typically uses around 15,000-25,000 input tokens and 2,000-4,000 output tokens. Cost is roughly $0.10-0.15 per run.
