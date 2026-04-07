# Quickstart

Get from zero to a working context wiki in five minutes.

## Prerequisites

- **Node.js 20+** — check with `node --version`
- **Claude CLI** — installed and authenticated (`claude --version`)
- **ANTHROPIC_API_KEY** — set in your environment or `.env` file

## Step 1: Install

```bash
npm install -g withctx
```

Verify it works:

```bash
ctx --version
# withctx v0.1.0
```

## Step 2: Initialize a Project

Navigate to your project root and run:

```bash
cd ~/projects/acme-platform
ctx init
```

Output:

```
 Initializing withctx...
 Created .ctx/ directory
 Created ctx.yaml with defaults
 Created .ctx/context/ wiki directory

Edit ctx.yaml to configure your sources, then run: ctx ingest
```

This creates:

```
.ctx/
  context/          # Wiki pages will live here
  sources/          # Cached raw source data (gitignored)
  costs.json        # Token usage tracking
ctx.yaml            # Project configuration
```

## Step 3: Configure Sources

Open `ctx.yaml` and point it at your sources. For the quickstart, we will use local files only:

```yaml
# ctx.yaml
project: acme-platform
description: E-commerce platform with API, auth, and web app

sources:
  local:
    paths:
      - ./README.md
      - ./docs/
      - ./architecture/
```

## Step 4: Ingest

Run the initial ingest to compile your wiki:

```bash
ctx ingest
```

Output:

```
 Reading sources...
  Local files: 12 files found
 Compiling wiki pages...
  Created: index.md
  Created: architecture/overview.md
  Created: repos/api-service.md
  Created: onboarding/getting-started.md
 Wiki compiled: 4 pages from 12 sources
 Tokens used: ~8,200 input, ~3,100 output
 Cost: ~$0.04
```

## Step 5: Query

Ask a question against your compiled wiki:

```bash
ctx query "What is the tech stack?"
```

Output:

```
The acme-platform uses:
- Backend: Node.js with Fastify, TypeScript
- Database: PostgreSQL with Prisma ORM
- Auth: OAuth 2.0 with PKCE, JWT tokens
- Frontend: React 18 with Next.js 14
- Infrastructure: AWS ECS, RDS, ElastiCache

Sources: architecture/overview.md, repos/api-service.md
```

## Step 6: Start a Chat (Optional)

For a multi-turn conversation:

```bash
ctx chat
```

```
 withctx chat — type /exit to quit, /save to save insights

You: How is the API structured?

ctx: The API follows a modular route structure using Fastify plugins.
     Each domain (users, orders, payments) is a separate plugin
     registered in src/app.ts. Routes are in src/routes/, handlers
     in src/handlers/, and schemas in src/schemas/.

     Source: repos/api-service.md

You: What about error handling?

ctx: Errors use a centralized error handler registered as a Fastify
     onError hook. Domain errors extend a base AppError class with
     error codes. The convention is to throw typed errors from
     handlers and let the hook format the HTTP response.

     Source: repos/api-service.md, architecture/overview.md

You: /exit
 Session ended.
```

## What's Next

- [Single-repo setup](03-single-repo-setup.md) — full setup for a simple project
- [Multi-repo setup](04-multi-repo-setup.md) — dedicated context repo for larger teams
- [Sources](05-sources.md) — connect Jira, Confluence, Teams, GitHub, and more
- [Commands](07-commands.md) — full CLI reference
