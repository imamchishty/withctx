# Quickstart

Get from zero to a working context wiki in five minutes.

## Prerequisites

You need two things installed. If you've never used Node.js before, follow these steps:

### 1. Install Node.js 20+

**Mac:**
```bash
# Using Homebrew (recommended)
brew install node

# Verify
node --version   # should show v20+ or v22+
```

**Windows:**
Download from https://nodejs.org (LTS version) and run the installer.

**Linux:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Get an Anthropic API Key

1. Go to https://console.anthropic.com
2. Sign up or log in
3. Go to API Keys → Create Key
4. Copy the key (starts with `sk-ant-`)

Set it in your terminal:
```bash
# Mac/Linux — add to your shell profile (~/.zshrc or ~/.bashrc)
export ANTHROPIC_API_KEY=sk-ant-your-key-here

# Windows (PowerShell)
$env:ANTHROPIC_API_KEY = "sk-ant-your-key-here"
```

Or create a `.env` file in your project root:
```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

## Step 1: Install

```bash
npm install -g withctx
```

Verify it works:

```bash
ctx --version
# withctx v0.1.0
```

## Step 1.5: Verify Everything Works

```bash
ctx doctor
```

This checks Node.js, API key, and connectivity. Fix any ❌ items before proceeding.

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
