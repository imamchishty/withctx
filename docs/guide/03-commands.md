# 3. Commands

withctx has **12 top-level commands**. Every one answers a distinct question. If you learn five of them — `ask`, `sync`, `status`, `approve`, `lint` — you have 80% of the value.

The other seven reveal themselves as you need them. You do not need to memorise anything.

> **Aliases.** Older names (`ctx query`, `ctx ingest`, `ctx chat`, `ctx search`, `ctx serve`, `ctx mcp`, `ctx costs`, `ctx history`, `ctx sources`, `ctx repos`, etc.) still work as hidden aliases so existing scripts don't break — they just don't show up in `ctx help` anymore. New docs, new help output, and new tab completions use the canonical verbs below.

## The 12 verbs at a glance

| Verb | Question it answers |
|---|---|
| `ctx setup` | How do I start? |
| `ctx doctor` | Is my environment healthy? |
| `ctx config` | What am I configured to ingest from? |
| `ctx sync` | Is the wiki up to date? |
| `ctx ask` | What does the wiki say about X? |
| `ctx status` | Is the wiki healthy overall? |
| `ctx lint` | Is the wiki consistent and safe? |
| `ctx approve` | I've read this page and it's correct — stamp it. |
| `ctx verify` | Do the wiki's claims still match the live tree? |
| `ctx review` | Does this PR drift from the wiki? |
| `ctx teach` | Drill me on what the wiki says. |
| `ctx pack` | Emit a bundle for agents / CI / publishing / serving. |

Everything the old 40-command surface used to do is either (a) a flag on one of these twelve or (b) a hidden alias that still runs. A quick absorption map:

- `ctx query` / `ctx chat` / `ctx search` / `ctx grep` / `ctx who` / `ctx why` / `ctx explain` / `ctx faq` / `ctx onboard` → `ctx ask` (with flags)
- `ctx costs` / `ctx metrics` / `ctx history` / `ctx todos` / `ctx impact` / `ctx timeline` / `ctx changelog` / `ctx diff` → `ctx status` (with flags)
- `ctx sources` / `ctx repos` → `ctx config` (with subcommands)
- `ctx export` / `ctx publish` / `ctx embed` / `ctx snapshot` / `ctx serve` / `ctx mcp` → `ctx pack` (with flags)
- `ctx init` / `ctx go` / `ctx reset` / `ctx install-hooks` → `ctx setup` (with flags)
- `ctx ingest` / `ctx watch` → `ctx sync` (with flags)
- `ctx bless` → `ctx approve` (rename; old verb still routes)

## The trust pipeline: `sync` → `approve` → `verify` → `review`

Four verbs form the trust loop that takes a page from "Claude wrote it" to "the team stands behind it, and CI protects it":

1. **`ctx sync`** compiles pages from sources. They land in the `manual` tier — drafts.
2. **`ctx approve <page>`** records that a human read the page and vouches for it. The tier auto-promotes to `asserted`.
3. **`ctx verify <page>`** runs assertion checks (path-exists, grep, regex) against the live tree. If every assertion passes, the tier auto-promotes to `verified`. If any fail, it demotes back to `asserted` — the human vouch is still there, but the facts no longer line up.
4. **`ctx review <pr> --drift`** checks a PR against approved/verified pages and flags the ones that would need re-approval if the PR lands.

Every verb in this pipeline is deterministic and LLM-free except `ctx sync`. You can run `approve`, `verify`, and `review --drift` in CI and in pre-commit hooks without spending a cent.

> **Heads up: `ctx bless` was renamed to `ctx approve`.** "Bless" was a borrowed word that confused new users. "Approve" maps cleanly to the pull-request mental model: you're signing off on a doc the same way you'd sign off on code. The old `ctx bless` verb is still registered as a hidden alias so existing scripts and muscle memory keep working — but every new doc, help screen, and tab-completion uses `ctx approve`.

## The 5 verbs you'll use every day

### `ctx ask "..."` — the only way you query the wiki

Absorbs the old `query`, `chat`, `search`, `grep`, `explain`, `faq`, and `who` commands. The flags select the mode.

```bash
# One-shot natural-language question (default — was `ctx query`)
ctx ask "how does auth work?"

# Follow-up on your previous ask (history kept)
ctx ask "what about refresh tokens" --continue

# Interactive REPL (was `ctx chat`)
ctx ask --chat

# Semantic vector search (was `ctx search`)
ctx ask --search "rate limiting"

# Literal keyword search, zero LLM cost, works offline (was `ctx grep`)
ctx ask --grep "TODO"

# Answer with zero LLM cost — grep + deterministic extraction only
ctx ask "which port does the api run on?" --offline

# Ownership lookup (was `ctx who`)
ctx ask --who "payments service"

# Script-friendly output
ctx ask "list our dependencies" --json
```

One verb, one mental model: "I want to ask the wiki something". Flags narrow the retrieval mode.

### `ctx sync` — update the wiki

Absorbs the old `ingest`, `sync`, `go`, `watch`, and `add` commands.

```bash
# Incremental: only recompile pages whose sources changed (default)
ctx sync

# First run / full rebuild (was `ctx ingest`)
ctx sync --full

# Dry run: show what WOULD change, don't write or spend
ctx sync --dry-run

# Daemon mode: re-sync on file changes (was `ctx watch`)
ctx sync --watch

# Add a manual note — Claude integrates it into the right page
ctx sync --note "payments uses Stripe v2024-06-01 API"

# Override stale source content with a correction
ctx sync --note "we moved off Redis in March" --type correction
```

`ctx sync` is idempotent. Running it twice in a row compiles nothing the second time. Running it after editing a single source file recompiles only the pages that source feeds.

### `ctx status` — is the wiki healthy?

Absorbs the old `status`, `metrics`, `todos`, and `impact` commands.

```bash
# Wiki health dashboard: pages, freshness, coverage, gaps
ctx status

# Machine-readable health snapshot for CI / dashboards
ctx status --json

# Show scanned TODO/FIXME markers (was `ctx todos`)
ctx status --todos

# Impact analysis: which wiki pages reference this source file?
ctx status --impact src/auth.ts

# Detailed metrics view (was `ctx metrics`)
ctx status --metrics
```

### `ctx approve <page>` — mark a page as reviewed

A daily human action. Think of it as "Approve" on a pull request, but for documentation: you're saying "I read this, the facts are right, I'll stand behind it." The command stamps your git email + timestamp into the page's front matter. `ctx status` shows the approval ratio; `ctx lint` flags pages that have drifted since their last approval.

```bash
ctx approve overview.md
ctx approve architecture.md
ctx approve --all-touched             # approve every page you've edited this session
ctx approve overview.md --revoke      # withdraw an earlier approval
ctx approve overview.md --note "verified against prod deploy 2026-04-10"
```

Un-approved pages fade in confidence tier over time. A wiki full of approved pages is a wiki the team actually trusts.

> Aliases: `ctx bless` still works. It was the original name and is kept as a hidden alias so scripts written against it don't break.

### `ctx lint` — is the wiki consistent and safe?

Absorbs the old `lint` command plus verification, redaction, and policy checks.

```bash
# Standard lint: contradictions, stale pages, orphans, missing references
ctx lint

# Also run the assertion engine against the wiki
ctx lint --verify

# Scan for leaked secrets, PII, internal hostnames
ctx lint --redaction

# Auto-fix anything auto-fixable (broken links, missing refs, formatting)
ctx lint --fix

# JSON output for CI
ctx lint --json
```

Run this in CI. Fail the build on `--redaction` violations and contradictions.

## Setup verbs (you'll use these rarely)

### `ctx setup` — bootstrap a project

Absorbs the old `setup`, `init`, `go`, `reset`, and the proposed `install-hooks`.

```bash
# Interactive setup: detect sources, write ctx.yaml, compile the wiki
ctx setup

# Write ctx.yaml only, skip the first compile
ctx setup --no-ingest

# Also scaffold external connectors
ctx setup --with jira,confluence

# Discover every repo in a GitHub org
ctx setup --org acme --token ghp_...

# Zero-cost demo scaffold — no API key required
ctx setup --demo

# Drop pre-commit git hooks into .git/hooks/
ctx setup --hooks

# Wipe .ctx/ and start over (was `ctx reset`)
ctx setup --reset

# CI-friendly: no prompts, assume yes
ctx setup -y
```

### `ctx doctor` — pre-flight diagnostics

```bash
ctx doctor                  # human-readable dashboard
ctx doctor --json           # machine-readable for CI
ctx doctor --fix            # attempt auto-fix for anything fixable
```

Run this when something's off. It checks Node version, API keys, provider reachability, ctx.yaml validity, .ctx/ writability, source paths, and wiki freshness age.

### `ctx sources` — manage inputs

Absorbs the old `sources`, `repos`, and `import` commands.

```bash
# List all configured sources
ctx sources list

# Add a source (interactive)
ctx sources add

# Add specific source types
ctx sources add github --repo acme/api
ctx sources add jira --project PAY
ctx sources add repo https://github.com/acme/auth       # was `ctx repos add`

# Remove a source
ctx sources remove github/acme/api

# Import an external ctx.yaml or wiki snapshot
ctx sources import ./other-project/ctx.yaml
```

## Trust verbs (ship confidence)

### `ctx verify [page]` — do the claims still match the code?

Runs the assertion engine against the live repository. Assertions come from two places:

1. **Auto-detected paths.** Any backticked token on a page that looks like a file or directory (e.g. `` `src/auth/session.ts` ``) becomes an implicit `path-exists` check. No authoring effort required.
2. **Explicit `ctx-assert` fenced blocks.** A page can declare stronger checks — `grep`, `regex`, `no-match` — in a fenced code block. These catch things like "the README still says 'PostgreSQL'" or "no file matches `legacy.*`".

```bash
# Verify every page in the wiki
ctx verify

# Verify one page
ctx verify architecture.md

# Only run the explicit ctx-assert blocks — skip auto-detected paths
ctx verify --explicit-only

# Show what would be checked, don't write verification metadata
ctx verify --dry-run

# Machine-readable output for CI
ctx verify --json
```

Exit code is non-zero if any assertion fails, so CI can block merges on drift. Successful runs auto-promote pages to the `verified` tier; failed runs demote `verified` pages back to `asserted` (see the trust pipeline above). This is the verb that makes "the wiki is correct" an enforceable property instead of a hope.

### `ctx why <claim>` — where did this come from?

Absorbs the old `why`, `blame`, and `bisect` commands. The evidence-trace tool.

```bash
# Full provenance chain: claim → wiki page → vector chunks → source doc → upstream ticket
ctx why "we use PostgreSQL"

# Like git blame: which ingest run and source commit produced this line
ctx why "rate limit is 100/min" --blame

# Walk backwards through the refresh journal to find when the claim changed
ctx why "uses Redis" --bisect
```

### `ctx review <pr>` — drift check against a PR

Diffs a code PR against the wiki's claims and lists the pages that would drift if the PR merges.

```bash
# Review a GitHub PR by URL or number
ctx review 1234
ctx review https://github.com/acme/api/pull/1234

# Fast deterministic drift check — no LLM call, CI-friendly
ctx review 1234 --drift

# Drift check as JSON for scripting or CI annotations
ctx review 1234 --drift --json

# Sandbox mode: apply the PR locally, run ctx sync --dry-run, diff the result
ctx review 1234 --sandbox

# After reviewing in sandbox, promote the drift updates to the real wiki
ctx review 1234 --sandbox --apply
```

`--drift` is the zero-cost pre-merge check. It finds the wiki pages that touch files the PR changes, classifies each page as `fresh`, `drifted`, `stale`, or "not approved", and exits non-zero when any approved page has drifted. Add it to your required CI checks; use `ctx review` without `--drift` when you want Claude to read the diff and leave substantive comments.

## Learning verbs

### `ctx teach [page]` — drill yourself on wiki content

A deterministic, LLM-free quiz generator. `ctx teach` turns wiki prose into fill-in-the-blank, heading-recall, and code-span lookup questions, asks them one at a time, and grades your answers leniently (case-insensitive, punctuation-stripped, word-overlap > 60% counts as correct).

No API key, no network, no persistence — it's a flashcard session that lives and dies in your terminal.

```bash
# Quiz across the whole wiki (default: 5 questions)
ctx teach

# Quiz scoped to one page
ctx teach architecture.md

# Ten questions instead of five
ctx teach -n 10

# Deterministic order — same --seed gives the same quiz every time
ctx teach --seed 42

# Show all questions + answers without grading (study mode)
ctx teach --reveal
```

At the end you get a score, a verdict, and up to three "review these pages" suggestions based on what you missed. The teaching loop is optimised for a new engineer sitting down with the wiki for the first time: the first question is always difficulty 1 (cloze), escalating to heading recall then code-span lookup.

For full-project onboarding guides ("what should I read first?"), the `ctx onboard` alias still works as a hidden command — it's being subsumed into `ctx ask --onboard` in a future release.

## Navigation verbs

### `ctx history` — what changed and when

Absorbs the old `history`, `diff`, `timeline`, and `changelog` commands.

```bash
# Refresh-journal: who synced when, tokens, cost, success/failure
ctx history

# Only failed runs
ctx history --failed

# Diff the wiki against its state at a date / commit
ctx history --since monday
ctx history --since v1.2.0

# Chronological timeline view
ctx history --timeline

# Generate a changelog from git + refresh journal
ctx history --changelog --since v1.0

# JSON for scripts
ctx history --json
```

## Emission verbs

### `ctx pack` — assemble artifacts

Absorbs the old `pack`, `export`, `publish`, `snapshot`, and `embed` commands.

```bash
# CLAUDE.md bundle for agents (default)
ctx pack

# Specific format
ctx pack --format claude-md
ctx pack --format system-prompt
ctx pack --format full-context
ctx pack --format rag                  # RAG-ready JSONL chunks

# Scoped to a subset
ctx pack --scope repos/api

# Static HTML site (GitHub Pages friendly)
ctx pack --html --output ./dist

# Publish to a remote context repo
ctx pack --publish

# Build the vector index for semantic search (was `ctx embed`)
ctx pack --embed

# Pin the current wiki state to a tag
ctx pack --tag v1.2.0
```

### `ctx serve` — HTTP + MCP server

Absorbs the old `serve` and `mcp` commands.

```bash
# REST API on :4400 (was `ctx serve`)
ctx serve

# Model Context Protocol stdio server (was `ctx mcp`)
ctx serve --mcp

# Custom port
ctx serve --port 8080
```

### `ctx costs` — usage and spend

```bash
# Per-operation cost breakdown + monthly budget
ctx costs

# Aggregate across a team (reads from shared bucket)
ctx costs --team

# ROI view: cost contribution per source
ctx costs --sources

# JSON for dashboards
ctx costs --json
```

## Global flags

Every verb respects these:

- `--help` — per-command help with examples
- `--json` — machine-readable output (on every read command)
- `--verbose` / `-v` — show every step
- `--quiet` / `-q` — only errors
- `--yes` / `-y` — skip confirmation prompts
- `--version` — withctx version

## Daily-loop cheat sheet

```bash
ctx sync                             # morning: pull + recompile anything that changed
ctx ask "how does auth work?"        # throughout the day
ctx approve overview.md              # when you've read + confirmed a page is correct
ctx lint                             # before every PR
ctx status                           # end of day: health check
```

That's it. Five commands, one mental model per command. Everything else is a flag or a subcommand you'll discover via `--help` the day you need it.
