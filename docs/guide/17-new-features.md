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
| ctx doctor | **Free** | $0 |
| ctx metrics | **Free** | $0 |
| ctx timeline | **Free** | $0 |
| ctx graph | **Free** | $0 |
| ctx config | **Free** | $0 |
| ctx status | **Free** | $0 |
| ctx diff | **Free** | $0 |
| ctx reset | **Free** | $0 |
