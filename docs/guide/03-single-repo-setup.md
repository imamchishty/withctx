# Single-Repo Setup

The simplest way to use withctx: one repo, local files, context wiki lives alongside your code.

## When to Use This

- Small to medium projects with one repository
- You want the context wiki committed alongside the code
- Engineers and agents access context from the same repo

## Directory Structure

After setup, your repo looks like this:

```
acme-api/
  src/
  tests/
  docs/
    architecture.md
    api-reference.md
  .ctx/
    context/            # Compiled wiki (committed)
      index.md
      architecture/
        overview.md
      onboarding/
        getting-started.md
      log.md
    sources/            # Raw cached data (gitignored)
    costs.json          # Usage tracking (gitignored)
  ctx.yaml              # Configuration (committed)
  package.json
```

## Step 1: Initialize

```bash
cd acme-api
ctx init
```

## Step 2: Configure ctx.yaml

```yaml
# ctx.yaml
project: acme-api
description: REST API for the Acme e-commerce platform

sources:
  local:
    paths:
      - ./README.md
      - ./docs/
      - ./src/          # ctx reads code for structure, not line-by-line
    exclude:
      - "**/*.test.ts"
      - "**/node_modules/**"
      - "**/dist/**"
```

### Source Options

The `local` source reads files from your filesystem:

```yaml
sources:
  local:
    paths:
      - ./docs/               # Entire directory
      - ./README.md           # Specific file
      - ./src/routes/         # Code directory for structure analysis
    exclude:
      - "**/*.test.ts"        # Glob patterns to skip
      - "**/*.snap"
    extensions:               # Limit to specific file types (optional)
      - .md
      - .ts
      - .yaml
```

## Step 3: Run Initial Ingest

```bash
ctx ingest
```

```
 Reading sources...
  Local files: 18 files found
  Skipped: 4 files (excluded by pattern)
 Compiling wiki pages...
  Created: index.md
  Created: architecture/overview.md
  Created: architecture/data-model.md
  Created: api/routes.md
  Created: api/error-handling.md
  Created: onboarding/getting-started.md
 Wiki compiled: 6 pages from 14 sources
 Tokens used: ~12,400 input, ~5,800 output
 Cost: ~$0.07
```

## Step 4: Review the Wiki

Check what was generated:

```bash
ctx status
```

```
Wiki: .ctx/context/
Pages: 6
Sources: 14 files
Last ingest: 2025-01-15 10:32:00
Freshness: all pages current
```

Read the index:

```bash
cat .ctx/context/index.md
```

```markdown
# acme-api

REST API for the Acme e-commerce platform.

## Architecture
- [System Overview](architecture/overview.md) — Fastify-based REST API,
  PostgreSQL, Redis caching layer
- [Data Model](architecture/data-model.md) — Users, Orders, Products,
  Payments entities and relationships

## API
- [Routes](api/routes.md) — REST endpoints organized by domain
- [Error Handling](api/error-handling.md) — Centralized error handler,
  typed error classes, HTTP status mapping

## Onboarding
- [Getting Started](onboarding/getting-started.md) — Local setup,
  environment variables, running tests
```

## Step 5: Commit the Wiki

Add the context wiki to version control:

```bash
git add .ctx/context/ ctx.yaml
git commit -m "feat: add withctx compiled wiki"
```

The `.ctx/sources/` and `.ctx/costs.json` files are already in `.gitignore` (added by `ctx init`).

## Step 6: Keep It Fresh

When your code or docs change, run sync to update:

```bash
ctx sync
```

```
 Checking for changes...
  Modified: docs/architecture.md
  Modified: src/routes/payments.ts
 Updating wiki pages...
  Updated: architecture/overview.md (2 sections refreshed)
  Updated: api/routes.md (payments routes added)
 Sync complete: 2 pages updated
```

## Adding Manual Context

Engineers can add context that does not exist in any source file:

```bash
# Quick note
ctx add "We chose Fastify over Express for performance — benchmarked 2x throughput"

# Decision record
ctx add --type decision "Switched from REST to GraphQL for the mobile BFF layer"

# Convention
ctx add --type convention "All API responses must include a requestId header"
```

These get compiled into the wiki on the next ingest or sync.

## Querying

```bash
# Direct question
ctx query "What database do we use and why?"

# Start interactive chat
ctx chat
```

## Agent Usage

AI agents read the compiled wiki directly:

```bash
# Generate a context block for Claude Code
ctx pack --output .ctx/context/CLAUDE.md

# Scoped context for a specific area
ctx pack --scope api --output CLAUDE.md
```

The agent reads `CLAUDE.md` before writing code, giving it full project context.
