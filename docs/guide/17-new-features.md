# Power Features Guide

These features were added to make withctx more than a wiki compiler — they give you deep project intelligence.

> **What are "flags"?** Flags are options you add after a command. For example, `ctx review --severity strict` runs a strict review. Flags start with `--`.

---

## ctx doctor

**Checks if everything is set up correctly before you start.**

Use it when: you just installed withctx, or something isn't working.

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
  ✅ API connection     Claude responds (claude-sonnet-4)

  Sources:
  ✅ local:docs         ./docs exists (16 files)
  ✅ local:src          ./src exists (73 files)
  ⚠️  jira:ACME         JIRA_URL set but JIRA_TOKEN missing
  ❌ confluence:ENG     CONFLUENCE_URL not set

  3 of 4 sources ready.
```

Fix any ❌ items before running `ctx ingest`. **This is free — no Claude API call.**

---

## ctx review

**Reviews a pull request using your project's wiki knowledge.** Unlike normal code review tools, this knows your conventions, architecture decisions, and cross-repo dependencies.

Use it when: you want a thorough PR review, or before merging something important.

```bash
# Review a GitHub PR
ctx review https://github.com/acme/api-service/pull/47

# Review your staged changes before committing
ctx review --staged

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
  - auth-service also calls the payment API — confirm it handles retries

❌ Issues:
  - Missing idempotency key check — retry could double-charge
    (see decisions/payment-idempotency.md)

Tokens: 12,340 input / 2,891 output ($0.08)
```

| Flag | What it does |
|------|-------------|
| `--staged` | Review currently staged git changes |
| `--file <path>` | Review a diff file |
| `--severity <level>` | `strict`, `normal` (default), `lenient` |
| `--focus <area>` | `security`, `performance`, `patterns`, `all` (default) |
| `--output <path>` | Write review to a file |

---

## ctx explain

**Explains any file in your project — not just what it does, but WHY it exists and how it connects to everything else.**

Use it when: you're working on a file you didn't write and need full context.

```bash
ctx explain src/middleware/auth.ts

# Brief version
ctx explain src/middleware/auth.ts --depth brief

# For a new team member
ctx explain src/middleware/auth.ts --for new-engineer
```

```
src/middleware/auth.ts
─────────────────────

What it does:
  Validates JWT tokens on all protected routes.

Why it exists:
  After the Q3 security audit, the team migrated from sessions to JWTs.
  (see decisions/jwt-migration.md)

Patterns:
  - Uses the "middleware chain" pattern (see conventions.md)

Connections:
  - Tokens issued by auth-service (see cross-repo/dependencies.md)
  - Rate limiting runs BEFORE this (see architecture.md)

Gotchas:
  - Token secret is in Vault, NOT env vars
  - skipAuth paths must match the OpenAPI spec exactly

Tokens: 8,120 input / 1,560 output ($0.05)
```

| Flag | What it does |
|------|-------------|
| `--depth <level>` | `brief`, `normal` (default), `deep` |
| `--for <audience>` | `new-engineer`, `senior`, `agent` |
| `--save` | Save explanation as a wiki page |

---

## ctx impact

**Analyzes what would break if you made a proposed change.** Architects use this to plan migrations, refactors, and major changes.

Use it when: you're considering a big change and want to know the blast radius.

```bash
ctx impact "migrate from MongoDB to PostgreSQL"
ctx impact "remove auth-service and merge into api-service"
ctx impact "upgrade to Node.js 22"
```

```
Impact Analysis: "migrate from MongoDB to PostgreSQL"

Affected Services:
  🔴 api-service — primary database, all models use Mongoose
  🔴 auth-service — stores sessions in MongoDB
  🟡 web-app — API response shapes may change

Key Risks:
  🔴 HIGH: Aggregation pipelines have no direct Postgres equivalent
  🟡 MEDIUM: Mongoose → Prisma rewrite in 2 services

Estimated Effort: XL (4-6 weeks)

Recommended Approach:
  1. Set up PostgreSQL alongside MongoDB (dual-write)
  2. Migrate auth-service first (smaller surface)
  3. Migrate api-service incrementally
  4. Cut over data pipeline last

Tokens: 24,560 input / 4,210 output ($0.14)
```

| Flag | What it does |
|------|-------------|
| `--scope <repos>` | Limit to specific repos/services |
| `--save <path>` | Save as wiki page |
| `--format <fmt>` | `terminal` (default), `markdown`, `json` |
| `--output <path>` | Write to file |

---

## ctx faq

**Auto-generates a FAQ page from your wiki — the top 20 questions every engineer would ask.**

Use it when: onboarding new engineers, or you want a quick reference.

```bash
ctx faq                          # generate FAQ (cached after first run)
ctx faq --for new-engineer       # beginner-friendly
ctx faq --for agent              # for AI agents
ctx faq --count 30               # more questions
ctx faq --regenerate             # force refresh
```

The FAQ is saved to `.ctx/context/faq.md` and displayed. On subsequent runs, it shows the cached version (free) unless you use `--regenerate`.

| Flag | What it does |
|------|-------------|
| `--for <audience>` | `new-engineer`, `senior`, `agent` |
| `--count <n>` | Number of questions (default: 20) |
| `--scope <area>` | FAQ for a specific wiki section |
| `--regenerate` | Force regenerate even if cached |

---

## ctx changelog

**Auto-generates release notes from git history + wiki context.**

Use it when: preparing a release, or summarizing recent work.

```bash
ctx changelog                    # since last git tag
ctx changelog --since v2.3.0     # since specific tag
ctx changelog --since 7d         # last 7 days
ctx changelog --output CHANGELOG.md
```

```
## What Changed (since v2.3.0)

### Features
- Payments flow now uses Stripe (relates to: decisions/stripe-migration.md)
- New /api/v2/users endpoint added

### Bug Fixes
- Fixed race condition in token refresh

### Breaking Changes
- POST /api/payments request body changed
```

| Flag | What it does |
|------|-------------|
| `--since <ref>` | Git tag, date, or duration (7d, 30d) |
| `--format <fmt>` | `terminal`, `markdown`, `json` |
| `--output <path>` | Write to file |
| `--save` | Save as wiki page |

---

## ctx metrics

**Health dashboard — one screen showing everything about your wiki.**

Use it when: you want a quick health check, or to show the team how the wiki is doing.

```bash
ctx metrics
```

```
┌─────────────────────────────────────────────┐
│  withctx metrics — acme-platform            │
├─────────────────────────────────────────────┤
│                                             │
│  📊 Wiki Health Score: 87/100               │
│                                             │
│  Pages:        24 total                     │
│    current:    20 (< 7 days old)            │
│    recent:      2 (< 30 days)              │
│    stale:       2 (> 30 days) ⚠️            │
│                                             │
│  Cross-References:                          │
│    links:      48 total, 0 broken ✅        │
│    orphans:    1 page                       │
│                                             │
│  Costs:                                     │
│    this month: $8.40 / $20.00 budget        │
│    ████████░░░░░░░░░░░░ 42%                 │
│                                             │
└─────────────────────────────────────────────┘
```

**This is free — no Claude API call.**

| Flag | What it does |
|------|-------------|
| `--json` | Machine-readable output |
| `--watch` | Refresh every 30 seconds |

---

## ctx timeline

**Shows project history — what happened when.**

Use it when: you want to understand the sequence of events in the project.

```bash
ctx timeline
ctx timeline --since 30d
ctx timeline --type decisions
```

```
2025-03-01  ● Project initialized (3 repos)
2025-03-15  ◆ Decision: Migrate to TypeScript
2025-04-02  ● auth-service added as source
2025-04-10  ◆ Decision: Use Stripe for payments
2025-04-15  ○ Manual: "Redis TTL is 5 min for sessions"
2025-04-18  ● Sync — 3 pages updated
```

**This is free — no Claude API call.**

| Flag | What it does |
|------|-------------|
| `--since <date>` | Filter by date or duration |
| `--limit <n>` | Show last N events |
| `--type <type>` | `all`, `decisions`, `syncs`, `manual`, `pages` |
| `--format <fmt>` | `terminal`, `markdown`, `json` |

---

## ctx watch

**Watches your local files and auto-syncs the wiki when something changes.**

Use it when: you're actively working on code and want the wiki to stay current.

```bash
ctx watch
```

```
Watching ./src and ./docs for changes...
[14:32:01] src/auth/handler.ts changed → syncing...
[14:32:08] ✔ Updated repos/api-service/patterns.md
^C Stopped watching.
```

Press Ctrl+C to stop. Uses a 2-second debounce so it doesn't sync on every keystroke.

---

## ctx import

**Import an existing markdown file (like a CLAUDE.md or README) into the wiki.**

Use it when: you already have documentation and want to bootstrap the wiki from it.

```bash
ctx import ./CLAUDE.md                    # Claude splits into wiki pages
ctx import ./notes/api-design.md --as api-design  # import as specific page
```

---

## ctx graph

**Visualize how wiki pages link to each other.**

```bash
ctx graph                        # generates mermaid diagram
ctx graph --format dot           # Graphviz format
ctx graph --format text          # ASCII
```

Writes to `.ctx/exports/graph.mermaid`. **Free — no Claude call.**

---

## ctx config

**View and edit your ctx.yaml from the command line** — no need to open the file manually.

```bash
ctx config                       # show full config
ctx config get costs.budget      # read a value
ctx config set costs.budget 50   # change a value
ctx config sources               # list sources with status
```

---

## ctx reset

**Wipe the wiki and start fresh.**

```bash
ctx reset                        # asks for confirmation
ctx reset --force                # skip confirmation
ctx reset --force --reingest     # wipe and immediately recompile
```

Use it when: the wiki has drifted too far and you want a clean recompile.

---

---

## Vector Search (ctx embed + ctx search)

**Find information by meaning, not just keywords.**

Traditional search requires you to know the exact words used in the wiki. Vector search understands what you mean. Search for "how do we handle failed payments" and it finds content about payment retries, even if those exact words aren't used.

### How it works

1. **Embed** — `ctx embed` splits your wiki pages into chunks and converts each chunk into a mathematical representation (a "vector") that captures its meaning.
2. **Search** — `ctx search "your question"` converts your question into the same kind of vector, then finds the closest matches.

### Getting started

```bash
# After your wiki is compiled:
ctx embed                                    # Generate embeddings (one-time)
ctx search "how does authentication work"    # Search by meaning
ctx search "database schema" --limit 10      # Show more results
```

### When to use search vs query

| Use `ctx search` when... | Use `ctx query` when... |
|--------------------------|------------------------|
| You want fast, free results | You want a conversational answer |
| You know roughly what you're looking for | You need Claude to synthesize information |
| You want to see the raw wiki chunks | You want a natural language explanation |
| No AI cost per search | Costs ~$0.02-0.06 per query |

---

## MCP Server (ctx mcp)

**Let AI coding agents read your wiki directly while they write code.**

MCP (Model Context Protocol) is an open standard that lets AI tools connect to external data sources. When you run `ctx mcp`, it starts a server that tools like Claude Code, Cursor, and Windsurf can talk to.

This means your AI assistant can automatically look up architecture decisions, coding conventions, and service dependencies before writing code — no copy-pasting needed.

### Quick setup for Claude Code

Add to your `.claude/settings.json`:

```json
{
  "mcpServers": {
    "withctx": {
      "command": "npx",
      "args": ["-y", "withctx", "mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

### Quick setup for Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "withctx": {
      "command": "npx",
      "args": ["-y", "withctx", "mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

### What agents can do with it

The MCP server exposes 10 tools that agents can call:

- **search_context** — Search the wiki by keyword
- **get_page** — Read a specific wiki page
- **get_architecture** — Get the architecture overview
- **get_conventions** — Get coding standards
- **get_decisions** — Get architecture decision records
- **get_faq** — Get the project FAQ
- **list_pages** — List all wiki pages
- **list_sources** — See configured data sources
- **get_file_context** — Get wiki context relevant to a specific file the agent is editing
- **add_memory** — Store a learning the agent discovers while working

See [MCP Integration](19-mcp-integration.md) for the full setup guide.

---

## Multi-Provider AI

**Use Anthropic, OpenAI, Google Gemini, or Ollama — your choice.**

withctx auto-detects which AI provider to use based on your environment variables. Set the API key for the provider you want and it just works.

### Provider detection order

withctx checks for API keys in this order and uses the first one it finds:

1. `ANTHROPIC_API_KEY` — Uses Claude (recommended)
2. `OPENAI_API_KEY` — Uses GPT-4
3. `GOOGLE_API_KEY` — Uses Gemini
4. If none found — Falls back to Ollama (must be running locally)

### Switching providers

```bash
# Use Anthropic (default)
export ANTHROPIC_API_KEY=sk-ant-your-key-here

# Switch to OpenAI
export OPENAI_API_KEY=sk-your-key-here

# Switch to Google Gemini
export GOOGLE_API_KEY=your-key-here

# Use Ollama (free, runs locally, no API key needed)
# Just make sure Ollama is running: ollama serve
```

### When to use each provider

| Provider | Best for | Notes |
|----------|---------|-------|
| **Anthropic (Claude)** | Best overall quality, especially for code analysis | Recommended default |
| **OpenAI (GPT-4)** | Good alternative if you already have an OpenAI key | Solid performance |
| **Google (Gemini)** | Large context windows | Good for very large codebases |
| **Ollama** | Privacy-sensitive environments, offline use | Free, runs locally, slower |

No code changes needed — just swap the environment variable and everything works the same.

---

## RAG Exports

**Export your wiki in formats ready for AI pipelines.**

RAG (Retrieval-Augmented Generation) is a technique where an AI looks up relevant documents before answering a question. If you're building custom AI applications, these exports give you pre-chunked, metadata-rich documents ready to load into your pipeline.

### Available formats

```bash
# LangChain — produces Document objects with metadata
ctx export --format langchain

# LlamaIndex — produces Node objects with relationships
ctx export --format llamaindex

# Raw JSON chunks — framework-agnostic, works with anything
ctx export --format rag-json

# Control the chunk size (default: 512 words)
ctx export --format langchain --chunk-size 256
```

### What you get

Each export includes:
- Wiki content split into chunks of a consistent size
- Metadata for each chunk: source page, section heading, project name
- Ready to load into your vector database (Pinecone, Weaviate, ChromaDB, etc.)

### Example: loading into LangChain

```python
import json
from langchain.schema import Document

with open(".ctx/exports/context.json") as f:
    data = json.load(f)

docs = [
    Document(page_content=chunk["pageContent"], metadata=chunk["metadata"])
    for chunk in data["documents"]
]
# Now use docs with any LangChain retriever
```

---

## New Connectors: OpenAPI, Notion, Slack

withctx now supports 16 source connectors (up from 13). The three new connectors are:

### OpenAPI

Ingest API specifications (OpenAPI/Swagger files) to give the wiki full knowledge of your API endpoints, request/response schemas, and authentication requirements.

```yaml
sources:
  openapi:
    - name: api-spec
      path: ./openapi.yaml           # Local file
    # Or fetch from a URL:
    - name: external-api
      url: https://api.example.com/openapi.json
```

### Notion

Pull content from Notion databases and pages. Great for teams that keep design docs, product specs, or runbooks in Notion.

```yaml
sources:
  notion:
    - name: product-docs
      database_ids:
        - "abc123..."
      page_ids:
        - "def456..."
```

Requires `NOTION_TOKEN` — create an internal integration at https://www.notion.so/my-integrations.

### Slack

Ingest messages from Slack channels. Filters noise (short messages, reactions, join/leave notifications) to focus on substantive discussions.

```yaml
sources:
  slack:
    - name: engineering
      channels:
        - engineering-general
        - architecture-decisions
      since: 90d
```

Requires `SLACK_TOKEN` — create a Slack app at https://api.slack.com/apps with `channels:history` and `channels:read` scopes.

See [Sources](05-sources.md) for full configuration details on all 16 connectors.

---

## Cost Summary

| Command | Costs Money? | Typical Cost |
|---------|-------------|-------------|
| ctx review | Yes | ~$0.05-0.15 |
| ctx explain | Yes | ~$0.03-0.08 |
| ctx impact | Yes | ~$0.10-0.20 |
| ctx faq | Yes (first run), Free (cached) | ~$0.10-0.15 |
| ctx changelog | Yes | ~$0.05-0.10 |
| ctx ingest | Yes | ~$0.12-1.80 |
| ctx sync | Yes | ~$0.05-0.20 |
| ctx query | Yes | ~$0.02-0.06 |
| ctx go | Yes (runs ingest) | ~$0.12-1.80 |
| ctx embed | Depends on provider | ~$0.01-0.05 |
| ctx doctor | **Free** | $0 |
| ctx metrics | **Free** | $0 |
| ctx timeline | **Free** | $0 |
| ctx graph | **Free** | $0 |
| ctx config | **Free** | $0 |
| ctx status | **Free** | $0 |
| ctx diff | **Free** | $0 |
| ctx reset | **Free** | $0 |
| ctx search | **Free** | $0 |
| ctx mcp | **Free** | $0 |
| ctx setup | **Free** | $0 |
