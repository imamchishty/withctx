# CLI Reference

All commands are invoked as `ctx <command>`. Run `ctx --help` for a summary or `ctx <command> --help` for details on any command.

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

Export the wiki in various formats.

```bash
ctx export --format markdown --output ./exported-wiki/
ctx export --format json --output wiki.json
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--format <format>` | Export format: `markdown`, `json` |
| `--output <path>` | Output file or directory |

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
