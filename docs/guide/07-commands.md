# CLI Reference

All commands are invoked as `ctx <command>`. Run `ctx --help` for a summary or `ctx <command> --help` for details on any command.

## ctx go

**The fastest way to start.** Runs `ctx init` and `ctx ingest` in a single command. Detects your project's sources automatically and compiles the wiki.

```bash
cd your-project
ctx go
```

This is equivalent to running `ctx init` followed by `ctx ingest`, but with smart defaults — it scans for common sources (local docs, README, src/) and starts ingestion immediately.

**Flags:**

| Flag | Description |
|------|-------------|
| `--org <name>` | Set the organization name for multi-repo setups |
| `--name <name>` | Project name (default: directory name) |
| `--bare` | Minimal ctx.yaml without example comments |

---

## ctx setup

Interactive setup wizard for teams. Walks you through configuring sources, connecting integrations, and setting up your project step by step.

```bash
ctx setup
```

```
Welcome to withctx setup!

? Project name: acme-platform
? Description: E-commerce platform with API, auth, and web app
? Add local file sources? (Y/n) Y
  Added: ./docs/, ./src/, ./README.md
? Connect Jira? (y/N) y
  ? Jira host: https://acme.atlassian.net
  ? Project key: ACME
? Connect GitHub? (y/N) y
  ? Repository: acme-corp/acme-api
? Run initial ingest now? (Y/n) Y

Setup complete! Wiki compiled with 8 pages.
```

Use this when you want guided help choosing which sources to connect. For a quick start without the wizard, use `ctx go` instead.

---

## ctx init

Initialize a new withctx project in the current directory.

```bash
ctx init
```

Creates:
- `ctx.yaml` — project configuration with commented examples
- `.ctx/context/` — wiki directory
- `.ctx/sources/` — source cache directory (gitignored)
- `.ctx/costs.json` — usage tracking (gitignored)
- Appends to `.gitignore` if present

**Flags:**

| Flag | Description |
|------|-------------|
| `--name <name>` | Project name (default: directory name) |
| `--bare` | Minimal ctx.yaml without example comments |

---

## ctx sources

List and verify configured sources.

```bash
ctx sources
```

Shows each configured source, how many items it found, and whether authentication is working. Use this to verify your `ctx.yaml` before running ingest.

**Flags:**

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |

---

## ctx repos

List configured repositories (for multi-repo setups).

```bash
ctx repos
```

```
Configured repositories:

  api-service     https://github.com/acme-corp/acme-api     24 files
  auth-service    https://github.com/acme-corp/acme-auth     16 files
  web-app         https://github.com/acme-corp/acme-web      31 files
```

---

## ctx ingest

Run a full ingestion. Reads all sources and compiles the wiki from scratch. Use this for the initial setup or when you want a clean recompilation.

```bash
ctx ingest
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--source <type>` | Only ingest from a specific source type (e.g., `--source jira`) |
| `--dry-run` | Show what would be ingested without calling Claude |
| `--verbose` | Show detailed progress |
| `--force` | Recompile all pages even if sources haven't changed |

---

## ctx add

Add manual context to the wiki. For notes, decisions, conventions, and corrections that don't exist in any connected source.

```bash
# Quick note
ctx add "Redis cache TTL is 5 minutes for user sessions"

# Typed context
ctx add --type decision "We chose Postgres over DynamoDB for ACID compliance"
ctx add --type convention "All HTTP handlers must validate input with Zod schemas"
ctx add --type context "The payments team is in UTC+5, async reviews preferred"
ctx add --type correction "The auth doc says sessions — it's actually JWT since Q3"

# From a file
ctx add --file ./notes/migration-plan.md

# Open editor to write
ctx add --edit

# With tags for organization
ctx add --tags "auth,security" "MFA is required for all admin endpoints"
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--type <type>` | Context type: `decision`, `convention`, `context`, `correction` |
| `--file <path>` | Read context from a file |
| `--edit` | Open `$EDITOR` to write context |
| `--tags <tags>` | Comma-separated tags for categorization |

See [Manual Context](09-manual-context.md) for detailed usage.

---

## ctx query

Ask a question against the compiled wiki. Single question, single answer.

```bash
ctx query "What database does the payments service use?"
```

```
The payments service uses PostgreSQL 15 via Prisma ORM. The schema
is defined in api-service/prisma/schema.prisma with models for
Payment, Transaction, Refund, and PaymentMethod.

Sources: repos/api-service.md, architecture/data-model.md
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--scope <scope>` | Limit search to specific wiki section (e.g., `--scope architecture`) |
| `--json` | Output as JSON |
| `--sources` | Show full source references |
| `--context <path>` | Path to external context repo |

---

## ctx chat

Start an interactive chat session against the wiki. Supports multi-turn conversation with follow-up questions.

```bash
ctx chat
```

**In-session commands:**

| Command | Description |
|---------|-------------|
| `/save` | Save the current conversation's insights to the wiki |
| `/exit` | End the chat session |
| `/sources` | Show sources for the last response |
| `/scope <section>` | Narrow context to a wiki section |

**Flags:**

| Flag | Description |
|------|-------------|
| `--scope <scope>` | Start scoped to a wiki section |
| `--context <path>` | Path to external context repo |

See [Chat](08-chat.md) for detailed usage.

---

## ctx lint

Check the wiki for quality issues: contradictions, stale content, orphan pages, missing cross-references.

```bash
ctx lint
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--fix` | Attempt to auto-fix issues |
| `--json` | Output as JSON |

See [Lint](10-lint.md) for detailed usage.

---

## ctx pack

Compile the wiki into a single context block for LLM consumption.

```bash
# Full wiki packed into one file
ctx pack

# Scoped to a specific area
ctx pack --scope repos/api-service

# With token budget
ctx pack --budget 8000

# Query-focused: pack context relevant to a question
ctx pack --query "How does payment processing work?"

# Write to file
ctx pack --output CLAUDE.md

# Specific format
ctx pack --format openai --output system-prompt.txt
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--scope <scope>` | Pack only a specific wiki section |
| `--budget <tokens>` | Maximum token budget for the output |
| `--query <question>` | Pack context most relevant to this question |
| `--output <path>` | Write to file instead of stdout |
| `--format <format>` | Output format: `claude` (default), `openai`, `markdown` |

See [Packing and Export](11-packing-export.md) for detailed usage.

---

## ctx export

Export the wiki in various formats, including RAG-ready formats for use with AI frameworks.

```bash
# Standard formats
ctx export --format markdown
ctx export --format json

# RAG-ready formats for AI pipelines
ctx export --format langchain           # LangChain Document objects
ctx export --format llamaindex          # LlamaIndex Node objects
ctx export --format rag-json            # Plain JSON chunks with metadata

# Control chunk size for RAG exports
ctx export --format langchain --chunk-size 256
```

**What are RAG formats?** RAG (Retrieval-Augmented Generation) is a technique where AI models look up relevant information before answering questions. These export formats produce pre-chunked documents that plug directly into popular AI frameworks like LangChain and LlamaIndex.

**Flags:**

| Flag | Description |
|------|-------------|
| `--format <format>` | Export format: `claude-md`, `system-prompt`, `markdown`, `json`, `langchain`, `llamaindex`, `rag-json` |
| `--scope <dir>` | Limit to a specific wiki subdirectory |
| `--budget <tokens>` | Token budget limit |
| `--snapshot` | Create a timestamped snapshot archive |
| `--chunk-size <words>` | Chunk size in words for RAG formats (default: 512) |

---

## ctx embed

Generate vector embeddings for your wiki pages so you can use semantic search. Embeddings are mathematical representations of your text that allow searching by meaning rather than exact keywords.

```bash
ctx embed                     # Incremental — only embeds new/changed pages
ctx embed --force             # Re-embed everything from scratch
ctx embed --provider openai   # Use OpenAI embeddings instead of auto-detect
```

```
Embedding [4/14] repos/api-service.md
✔ Embedding complete

  Embedding Stats:
    Pages embedded:    14
    Total chunks:      127
    Dimensions:        1536
    Store:             chroma
    Embedding provider: openai
    Last embedded:     2025-01-20T10:32:00.000Z
```

Run this after `ctx ingest` or `ctx sync` to keep embeddings up to date. Then use `ctx search` to query by meaning.

**Flags:**

| Flag | Description |
|------|-------------|
| `--provider <provider>` | Embedding provider: `openai`, `local` (default: auto-detect from environment) |
| `--store <store>` | Vector store: `chroma`, `memory` (default: auto-detect) |
| `--force` | Re-embed all pages, even if unchanged |

---

## ctx search

Semantic search across your wiki. Unlike `ctx query` (which uses Claude to answer), `ctx search` finds the most relevant wiki chunks by meaning without an AI call.

```bash
ctx search "how does authentication work"
ctx search "payment retry logic" --limit 10
ctx search "database migrations" --threshold 0.5
ctx search "deployment" --source wiki
```

```
  Search results for: "how does authentication work"
  Showing top 5 results

  1. architecture/auth.md [0.892]
     Section: Authentication Flow
     The API uses JWT tokens issued by auth-service. Tokens are validated...

  2. repos/api-service/patterns.md [0.741]
     Section: Middleware Chain
     The auth middleware runs after rate limiting and before route handlers...

  3. decisions.md [0.683]
     Section: JWT Migration
     After the Q3 security audit, the team migrated from session-based...
```

You must run `ctx embed` first to generate embeddings before searching.

**Flags:**

| Flag | Description |
|------|-------------|
| `--limit <n>`, `-n` | Number of results to show (default: 5) |
| `--threshold <score>`, `-t` | Minimum similarity score from 0 to 1 (default: 0) |
| `--source <type>`, `-s` | Filter by source type: `wiki`, `source`, `memory` |

---

## ctx mcp

Start an MCP (Model Context Protocol) server so AI coding agents can read your wiki directly. MCP is a standard protocol that lets tools like Claude Code, Cursor, and Windsurf connect to external data sources.

```bash
ctx mcp                       # Start the MCP server (connects via stdio)
ctx mcp --list                # List available tools without starting the server
```

```
Available MCP Tools:

  search_context
    Search across compiled wiki knowledge

  get_page
    Retrieve a specific wiki page by its path

  get_architecture
    Return the architecture overview

  get_conventions
    Return coding conventions

  get_decisions
    Return decision records (ADRs)

  get_faq
    Return the FAQ

  list_pages
    List all wiki pages

  list_sources
    Show configured data sources

  get_file_context
    Get all wiki context relevant to a specific file

  add_memory
    Store an agent learning or memory note

  Total: 10 tools
```

See [MCP Integration](19-mcp-integration.md) for setup instructions with Claude Code, Cursor, and Windsurf.

**Flags:**

| Flag | Description |
|------|-------------|
| `--list` | List available MCP tools without starting the server |

---

## ctx sync

Incremental update. Checks for changes in sources and updates only affected wiki pages.

```bash
ctx sync
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--source <type>` | Only sync a specific source type |
| `--dry-run` | Show what would change without updating |
| `--verbose` | Show detailed progress |

---

## ctx diff

Show what has changed in sources since the last sync without making any updates.

```bash
ctx diff
```

```
Changes since last sync (2025-01-18):

  Jira:
    ACME-198 closed (was: In Progress)
    ACME-201 created: "Add rate limiting to auth endpoints"

  GitHub:
    api-service: 3 commits on main
    auth-service: PR #47 merged

  Confluence:
    ENG/Auth Design — modified 2025-01-19

  Affected wiki pages:
    architecture/auth.md (Jira + GitHub + Confluence changes)
    api/routes.md (GitHub changes)
```

---

## ctx status

Show the current state of the wiki: page count, freshness, last sync time.

```bash
ctx status
```

```
Project: acme-platform
Wiki:    .ctx/context/
Pages:   14
Sources: 616 items across 7 source types
Last ingest: 2025-01-15 10:32:00
Last sync:   2025-01-20 06:00:00
Freshness:
   12 pages current
    2 pages may be stale (sources changed since last sync)

Stale pages:
  architecture/auth.md — sources updated 2025-01-19
  api/routes.md — sources updated 2025-01-20
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |

---

## ctx onboard

Generate a focused onboarding guide for a specific role or area.

```bash
ctx onboard
ctx onboard --role "backend engineer"
ctx onboard --scope repos/api-service
```

Produces a readable onboarding document from the wiki, tailored to the specified role or scope. Output goes to stdout by default.

**Flags:**

| Flag | Description |
|------|-------------|
| `--role <role>` | Tailor onboarding to a role (e.g., "frontend engineer", "SRE") |
| `--scope <scope>` | Focus on specific wiki sections |
| `--output <path>` | Write to file |

---

## ctx costs

Show token usage and estimated costs.

```bash
ctx costs
```

```
withctx usage — acme-platform

  This month (January 2025):
    Ingest:    145,000 input / 28,000 output    $0.85
    Sync (x3): 12,400 input / 4,200 output      $0.09
    Query (x8): 6,800 input / 2,100 output       $0.05
    Add (x5):   2,200 input / 800 output          $0.02

  Total: $1.01

  Lifetime: $1.01
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--month <YYYY-MM>` | Show costs for a specific month |
| `--json` | Output as JSON |

---

## ctx serve

Start a local HTTP API server for programmatic access.

```bash
ctx serve
ctx serve --port 3100
```

Exposes the wiki via a REST API. See [For Agents](15-for-agents.md) for API documentation.

**Flags:**

| Flag | Description |
|------|-------------|
| `--port <port>` | Port number (default: 3100) |
| `--host <host>` | Bind address (default: 127.0.0.1) |

---

## ctx doctor

Pre-flight diagnostics. Run this first if something isn't working.

```bash
ctx doctor
```

```
withctx doctor
──────────────

  ✅ Node.js          v20.11.0
  ✅ ctx.yaml          Found at ./ctx.yaml
  ✅ .ctx/ directory    Initialized
  ✅ ANTHROPIC_API_KEY  Set (sk-ant-...redacted)
  ✅ API connection     Claude responds (model: claude-sonnet-4)

  Sources:
  ✅ local:docs         ./docs exists (16 files)
  ✅ local:src          ./src exists (73 files)
  ⚠️  jira:ACME         JIRA_URL set but JIRA_TOKEN missing
  ❌ confluence:ENG     CONFLUENCE_URL not set

  3 of 4 sources ready. Fix issues above before running ctx ingest.
```

Checks: Node.js version, ctx.yaml, .ctx/ directory, API key, API connection, and every configured source with specific fix instructions for each failure.

---

## ctx review

Context-aware PR review. Uses wiki knowledge to catch issues no other review tool can find.

```bash
# Review a GitHub PR
ctx review https://github.com/acme/api-service/pull/47

# Review staged git changes
ctx review --staged

# Review a diff file
ctx review --file changes.diff

# Strict security-focused review
ctx review https://github.com/acme/api-service/pull/47 --severity strict --focus security
```

```
PR Review: #47 — Add payment retry logic

Summary:
  Adds exponential backoff retry to the payment processing pipeline.

✅ Positives:
  - Follows error handling pattern from conventions.md
  - Retry delays match the SLA in services/payments.md

⚠️  Warnings:
  - No update to api-endpoints.md for the new retry status codes
  - auth-service also calls the payment API (cross-repo/dependencies.md)
    — confirm it handles the new retry responses

❌ Issues:
  - Missing idempotency key check — the retry could double-charge
    (see decisions/payment-idempotency.md)

Cross-Repo Impact:
  - auth-service: may need to handle new 429 retry status
  - web-app: loading state should account for longer retry delays

Tokens: 12,340 input / 2,891 output ($0.08)
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--staged` | Review currently staged git changes |
| `--file <path>` | Review a diff file |
| `--severity <level>` | Review strictness: `strict`, `normal` (default), `lenient` |
| `--focus <area>` | Focus area: `security`, `performance`, `patterns`, `all` (default) |
| `--output <path>` | Write review to file |

---

## ctx explain

Deep explanation of any file using wiki context. Not just "what does this code do" — but WHY it exists and how it connects to the rest of the system.

```bash
# Explain a file
ctx explain src/middleware/auth.ts

# Brief explanation for quick understanding
ctx explain src/middleware/auth.ts --depth brief

# Detailed explanation for a new engineer
ctx explain src/middleware/auth.ts --for new-engineer

# Save explanation as a wiki page
ctx explain src/middleware/auth.ts --save
```

```
src/middleware/auth.ts
─────────────────────

What it does:
  Validates JWT tokens on all protected routes. Extracts user ID
  and roles from the token payload and attaches to request context.

Why it exists:
  After the Q3 security audit, the team migrated from session-based
  auth to JWTs (see decisions/jwt-migration.md). This middleware is
  the enforcement point for that decision.

Patterns:
  - Uses the "middleware chain" pattern (see conventions.md)
  - Error responses follow the standard error envelope format

Connections:
  - Tokens are issued by auth-service (see cross-repo/dependencies.md)
  - Token refresh happens client-side in web-app
  - Rate limiting middleware runs BEFORE this (see architecture.md)

Gotchas:
  - Token secret is in Vault, NOT environment variables
  - The skipAuth paths array must match the OpenAPI spec exactly
  - Clock skew tolerance is set to 30 seconds

Tokens: 8,120 input / 1,560 output ($0.05)
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--depth <level>` | Detail level: `brief`, `normal` (default), `deep` |
| `--for <audience>` | Explanation style: `new-engineer`, `senior`, `agent` |
| `--save` | Save explanation as a wiki page |
| `--output <path>` | Write to file |

---

## ctx impact

Impact analysis for proposed changes. Ask "what would break if..." and get a comprehensive analysis.

```bash
ctx impact "migrate from MongoDB to PostgreSQL"
ctx impact "remove auth-service and merge into api-service"
ctx impact "upgrade to Node.js 22"
ctx impact "switch from REST to gRPC between services"
```

```
Impact Analysis: "migrate from MongoDB to PostgreSQL"
─────────────────────────────────────────────────────

Affected Services:
  🔴 api-service — primary database, all models use Mongoose
  🔴 auth-service — stores sessions and refresh tokens in MongoDB
  🟡 web-app — no direct DB access, but API response shapes may change

Dependencies:
  - api-service → MongoDB Atlas (direct, would need to change)
  - auth-service → MongoDB via shared connection lib
  - Data pipeline reads from MongoDB oplog (would break)

Key Risks:
  🔴 HIGH: MongoDB aggregation pipelines have no direct Postgres equivalent
  🔴 HIGH: Session storage migration requires zero-downtime cutover
  🟡 MEDIUM: Mongoose ODM → Prisma/TypeORM rewrite in 2 services
  🟢 LOW: Test fixtures use MongoDB memory server

Deployment Impact:
  Deploy order changes — database migration must happen BEFORE
  any service deploys. See cross-repo/deployment-order.md.

People/Teams:
  - Backend team (owns api-service + auth-service)
  - Data team (owns the pipeline reading oplog)
  - DevOps (infrastructure changes)

Estimated Effort: XL
  2 services, 1 data pipeline, infra changes. Estimate 4-6 weeks.

Recommended Approach:
  1. Set up PostgreSQL alongside MongoDB (dual-write)
  2. Migrate auth-service first (smaller surface)
  3. Migrate api-service models incrementally
  4. Cut over data pipeline last
  5. Decommission MongoDB after 2 weeks stable

Tokens: 24,560 input / 4,210 output ($0.14)
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--scope <repos>` | Limit analysis to specific repos/services |
| `--output <path>` | Write analysis to file |
| `--save <path>` | Save as wiki page (e.g., `manual/impact-postgres-migration.md`) |
| `--format <format>` | Output format: `terminal` (default), `markdown`, `json` |

---

## ctx watch

Auto-sync when local files change. Watches configured source paths and triggers incremental sync.

```bash
ctx watch
```

```
Watching ./src and ./docs for changes...
[14:32:01] src/auth/handler.ts changed → syncing...
[14:32:08] ✔ Updated repos/api-service/patterns.md
[14:35:22] docs/architecture.md changed → syncing...
[14:35:29] ✔ Updated architecture.md
^C Stopped watching.
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--interval <seconds>` | Polling interval alternative to fs.watch |

---

## ctx reset

Wipe the wiki and start fresh.

```bash
ctx reset                  # prompts for confirmation
ctx reset --force          # skip confirmation
ctx reset --force --reingest  # wipe and immediately recompile
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--force` | Skip confirmation prompt |
| `--reingest` | Run full ingest after reset |

---

## ctx import

Import an existing markdown file into the wiki. Useful for bootstrapping from existing CLAUDE.md or documentation.

```bash
ctx import ./CLAUDE.md                    # Claude splits into wiki pages
ctx import ./notes/api-design.md --as api-design  # import as specific page
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--as <name>` | Import as a specific page name |

---

## ctx graph

Visualize page relationships in the wiki.

```bash
ctx graph                        # outputs mermaid diagram
ctx graph --format dot           # Graphviz DOT format
ctx graph --format text          # ASCII text
```

Writes to `.ctx/exports/graph.mermaid` (or `.dot`/`.txt`) and prints to terminal.

**Flags:**

| Flag | Description |
|------|-------------|
| `--format <format>` | Output format: `mermaid` (default), `dot`, `text` |

---

## ctx config

View and edit ctx.yaml from the CLI.

```bash
ctx config                       # show full config summary
ctx config get costs.budget      # get a specific value
ctx config set costs.budget 50   # set a value
ctx config sources               # list sources with status
```

---

## Global Flags

These flags work with any command:

| Flag | Description |
|------|-------------|
| `--config <path>` | Path to ctx.yaml (default: ./ctx.yaml) |
| `--context <path>` | Path to context directory (default: ./.ctx/context/) |
| `--help` | Show help |
| `--version` | Show version |
| `--quiet` | Suppress non-essential output |
| `--verbose` | Show detailed output |
