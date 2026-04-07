# FAQ

## Privacy and Security

### Is my data sent to the cloud?

Your source data (Jira tickets, Confluence pages, code, etc.) is sent to the Anthropic API through the Claude CLI for compilation. It is not sent anywhere else. Anthropic's API does not use your data for model training (per their data retention policy). The compiled wiki stays on your filesystem or in your private GitHub repo.

If you are subject to data residency requirements, check Anthropic's current data processing terms for where API data is processed.

### Is my code sent to Claude?

Only the files and paths you configure in `ctx.yaml` are sent. If you point withctx at `src/routes/`, those files are sent to Claude for analysis. If you only point it at `docs/` and `README.md`, your source code is never sent.

Control exactly what is sent:

```yaml
sources:
  local:
    paths:
      - ./docs/            # Only docs
      - ./README.md        # Only README
    exclude:
      - "**/.env*"         # Never send env files
      - "**/secrets/**"    # Never send secrets
```

### How do I handle sensitive content?

1. **Exclude sensitive files** using `exclude` patterns in `ctx.yaml`
2. **Exclude sensitive Jira projects** by only listing the projects you want
3. **Exclude Confluence spaces** that contain sensitive information
4. **Filter Teams channels** to only include engineering channels, not HR or finance

The `.ctx/sources/` directory (cached raw data) is gitignored by default and stays on your local machine. Only the compiled wiki in `.ctx/context/` is committed.

### Can I run withctx without any cloud calls?

No. The compilation step requires Claude (via the Anthropic API). The `ctx pack`, `ctx export`, `ctx diff`, and `ctx status` commands are local-only and do not make API calls. But the core value — compiling sources into a wiki — requires Claude.

---

## Editing and Accuracy

### Can I edit wiki pages manually?

Yes. You can edit any file in `.ctx/context/` directly. However:

- **Compiled sections** may be overwritten on the next `ctx sync` unless you pin them
- **Pinned sections** are preserved across syncs

To pin a section:

```markdown
<!-- ctx:pinned -->
## My Custom Section
This content will survive syncs.
<!-- /ctx:pinned -->
```

For adding new information, prefer `ctx add` over manual edits. Added context is stored separately and compiled correctly on every sync.

### What if Claude gets something wrong?

It happens. When you spot an error:

1. **Add a correction:**
   ```bash
   ctx add --type correction "Wiki says JWT expiry is 30 minutes — it is actually 15 minutes (see auth-service/src/config.ts)"
   ```

2. **Run sync** to recompile affected pages:
   ```bash
   ctx sync
   ```

3. **Fix the upstream source** if the error originated there (update the Confluence page, fix the README, etc.)

Corrections take priority over other sources during compilation.

### How does Claude handle conflicting sources?

When two sources disagree (e.g., a Confluence page says one thing and the code says another), Claude:

1. Notes the conflict in the wiki page
2. Prioritizes based on recency — the most recently updated source is treated as more likely to be correct
3. Flags the conflict so you can review it

`ctx lint` specifically checks for contradictions and reports them.

---

## Sources and Connectors

### Can I use withctx with just local files?

Yes. The simplest setup uses only local markdown and code files:

```yaml
sources:
  local:
    paths:
      - ./docs/
      - ./README.md
```

No Jira, Confluence, Teams, or GitHub tokens needed.

### What if I do not use Jira/Confluence/Teams?

Only configure the sources you have. All connectors are optional. A valid `ctx.yaml` can have just local files, or just GitHub repos, or any combination.

### Can I add a custom source?

Not yet in the current version. The nine built-in connectors cover the most common tools. If you have data in another tool, export it as markdown or JSON files and use the local file source.

### How much Jira history should I ingest?

A 90-day window (`updated >= -90d`) captures active work without pulling in years of old tickets. For architecture decisions and epics, consider a longer window:

```yaml
sources:
  jira:
    projects:
      - key: ACME
    jql: "updated >= -90d"
    custom_jql:
      - name: architecture-decisions
        query: "project = ACME AND type = Epic AND labels = architecture AND updated >= -365d"
```

---

## Cost and Models

### How much does it cost?

For a typical team (5-15 engineers, 3 repos, daily sync), expect $5-10/month. See [Cost Management](14-cost-management.md) for detailed breakdowns.

### Can I use GPT instead of Claude?

Not currently. withctx uses the Claude CLI and Anthropic API for all compilation and query operations. The CLI handles authentication, model selection, and streaming. Supporting other LLM providers is a potential future feature.

### Can I use a local/self-hosted model?

Not in the current version. The compilation quality depends on Claude's ability to synthesize across many documents, which requires a capable model. Local models may not produce the same quality of wiki pages.

### Why does ingest cost more than sync?

Ingest reads all sources and compiles the wiki from scratch — it sends everything to Claude. Sync only sends changed sources and affected pages, so it uses far fewer tokens.

---

## Workflow

### How often should I sync?

- **Low activity (< 5 PRs/week):** Weekly
- **Medium activity (5-20 PRs/week):** Daily
- **High activity (20+ PRs/week):** Twice daily or on PR merge

Use `ctx diff` (free) to check if there are meaningful changes before running sync.

### Can multiple people run ctx commands at the same time?

The wiki is just files, so concurrent writes could cause conflicts. In practice:

- **Auto-sync via GitHub Actions** is the recommended approach — one runner, no conflicts
- **Manual runs** should be coordinated — one person runs `ctx sync` at a time
- **Queries and chat** are safe to run concurrently (they only read)
- **ctx add** is safe to run concurrently (each entry is a separate file)

### How do I handle monorepos?

Treat the monorepo as a single-repo setup with multiple scoped paths:

```yaml
project: acme-monorepo

sources:
  local:
    paths:
      - ./packages/api/README.md
      - ./packages/api/docs/
      - ./packages/api/src/routes/
      - ./packages/auth/README.md
      - ./packages/auth/docs/
      - ./packages/auth/src/
      - ./packages/web/README.md
      - ./packages/web/docs/
      - ./docs/                          # Root-level docs
```

The wiki will create separate pages for each package.

### Can I use withctx for non-engineering projects?

Yes. The tool compiles any knowledge into a wiki. If your project has Jira tickets, Confluence docs, and Teams discussions, withctx can compile them regardless of whether the project involves code. The repo and code-specific features are optional.

---

## Troubleshooting

### ctx sources shows "401 Unauthorized" for Jira

Check that:
1. `JIRA_EMAIL` is your Atlassian account email (not username)
2. `JIRA_TOKEN` is a valid API token from id.atlassian.com > Security > API tokens
3. The token has not expired
4. Your account has access to the configured projects

### Sync takes a long time

Check what is being synced:

```bash
ctx sync --verbose
```

Common causes:
- Too many Jira issues (tighten the JQL filter with date ranges)
- Too many Confluence pages (use labels or exclude_labels to filter)
- Large code directories (use more specific paths and exclude patterns)

### Wiki pages are too generic

The wiki quality depends on the quality of source data. If pages are vague:

1. Add manual context with `ctx add` for specifics Claude cannot infer
2. Add more targeted sources (specific Jira epics, specific Confluence pages)
3. Reduce noise by excluding large directories and old content
4. Run `ctx ingest --force` to recompile with the improved sources

### The wiki contradicts itself

Run `ctx lint` to find contradictions. Then:

1. Fix the upstream source (update the Confluence page, close the outdated Jira ticket)
2. Add a correction: `ctx add --type correction "..."`
3. Run `ctx sync` to recompile

### I want to start over

Delete the wiki and recompile:

```bash
rm -rf .ctx/context/*
ctx ingest
```

This does a fresh compilation from all current sources. Manual context in `.ctx/context/_manual/` is preserved.
