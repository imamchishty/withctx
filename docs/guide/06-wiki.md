# The Wiki

The compiled wiki is a directory of markdown files in `.ctx/context/`. Claude reads all your sources and produces organized, cross-referenced pages that explain your project.

## Directory Structure

```
.ctx/context/
  index.md                    # Entry point — project overview with links
  architecture/
    overview.md               # System architecture, components, tech stack
    auth.md                   # Authentication and authorization design
    data-model.md             # Database schema, entities, relationships
    infrastructure.md         # Deployment, environments, cloud resources
  repos/
    api-service.md            # What this repo does, structure, setup
    auth-service.md           # Auth service internals
    web-app.md                # Frontend: stack, routing, key components
  decisions/
    adr-007-oauth.md          # Why OAuth 2.0 replaced sessions
    adr-012-graphql-bff.md    # Why GraphQL for mobile BFF
  api/
    routes.md                 # REST endpoints by domain
    error-handling.md         # Error types, HTTP mapping, conventions
  onboarding/
    getting-started.md        # First-day setup guide
    local-development.md      # Running services locally
  conventions/
    coding-standards.md       # Team coding conventions
    git-workflow.md           # Branching, PR, review process
  log.md                      # Change log of wiki updates
```

## Page Types

Claude organizes wiki pages into categories based on the content it finds:

### index.md

The root page. Always generated. Contains:
- Project name and description
- Links to every wiki page grouped by category
- A one-line summary of each page

This page is regenerated on every ingest/sync to reflect the current wiki structure.

### Architecture Pages

Compiled from: Confluence architecture docs, code structure, ADRs, Jira epics, Teams architecture discussions.

These pages explain the system design: what components exist, how they communicate, what technologies are used, and why those choices were made.

### Repo Pages

Compiled from: GitHub repository content (READMEs, code structure, package.json, route definitions, model files).

One page per repository. Each page covers:
- What the repo does
- Tech stack and key dependencies
- Directory structure
- How to set up and run locally
- Key patterns and conventions in the codebase

### Decision Pages

Compiled from: Confluence ADRs, Jira architecture epics, Teams architecture-decisions channel.

Each page documents one significant technical decision: the context, options considered, decision made, and consequences. These are especially valuable for agents — they explain *why* things are the way they are.

### API Pages

Compiled from: Route definitions in code, API documentation files, Swagger/OpenAPI specs, Jira stories describing endpoints.

Cover endpoints, request/response schemas, authentication requirements, and error codes.

### Onboarding Pages

Compiled from: README files, Confluence onboarding guides, setup scripts, environment configuration.

Step-by-step guides for getting a new engineer productive. Includes local setup, required tools, environment variables, and running tests.

### Convention Pages

Compiled from: Confluence coding standards, PR review comments patterns, linter configs, team discussions.

Coding standards, Git workflow, naming conventions, error handling patterns — the unwritten rules that every team has.

## How Claude Compiles Pages

During `ctx ingest` or `ctx sync`, Claude:

1. **Reads all source data** from `.ctx/sources/` (cached from connectors)
2. **Identifies topics** by clustering related content across sources
3. **Creates pages** with clear headings, organized sections, and cross-references
4. **Cites sources** for every factual claim in the wiki
5. **Resolves conflicts** when sources disagree (most recent source wins, flagged in text)

### Source Citations

Every page includes source references so you can trace claims back to their origin:

```markdown
## Authentication Flow

The platform uses OAuth 2.0 with PKCE for all client applications
[ACME-142, Confluence:ENG/Auth Design]. JWTs are issued with a
15-minute expiry and refresh tokens stored in Redis with 7-day TTL
[auth-service/src/config.ts, ACME-156].

The decision to move from session cookies to JWT was driven by the
mobile app requirement for stateless auth [ADR-007, Confluence:ARCH/ADR-007].
```

### Cross-References

Pages link to each other using relative markdown links:

```markdown
For details on the JWT structure, see [Auth Architecture](../architecture/auth.md).
The payment routes are documented in [API Routes](../api/routes.md#payments).
```

## How Pages Get Updated

On subsequent `ctx sync` runs, Claude:

1. Detects which sources have changed since the last sync
2. Identifies which wiki pages are affected by those changes
3. Updates only the affected sections of those pages
4. Preserves manual additions (added via `ctx add`) unless contradicted by newer source data
5. Appends an entry to `log.md`

### log.md

The change log tracks every wiki update:

```markdown
# Wiki Change Log

## 2025-01-20 — Sync

- **Updated:** architecture/auth.md — Added rate limiting section
  (source: ACME-198 closed, auth-service PR #47 merged)
- **Updated:** api/routes.md — Added /v2/payments/refund endpoint
  (source: api-service commit abc123)

## 2025-01-15 — Ingest

- **Created:** 14 pages from 616 sources
- Initial wiki compilation
```

## Manual Edits

You can edit wiki pages directly if needed. withctx tracks which content is manually edited vs. compiled:

- Compiled content may be updated by future syncs
- Content added via `ctx add` is preserved and marked as manual
- If you edit a compiled section, it becomes "pinned" — future syncs will not overwrite it unless you remove the pin

To pin a section, add a comment:

```markdown
<!-- ctx:pinned -->
## Custom Section
This content will not be overwritten by sync.
<!-- /ctx:pinned -->
```

## Reading the Wiki

The wiki is plain markdown. Read it however you prefer:

- **On GitHub** — browse the `acme-context` repo
- **In your editor** — open `.ctx/context/` in VS Code, IntelliJ, etc.
- **Via CLI** — `ctx query "how does auth work?"` searches the wiki
- **Via agents** — `ctx pack` compresses the wiki into a context block
