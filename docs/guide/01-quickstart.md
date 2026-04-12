# 1. Quickstart

Four commands. That's the whole thing.

```bash
npm i -g withctx
export ANTHROPIC_API_KEY=sk-ant-...    # https://console.anthropic.com
ctx setup
ctx ask "what does this project do?"
```

Requires Node.js 20+.

## What those four commands do

1. **`npm i -g withctx`** — installs the CLI.
2. **`export ANTHROPIC_API_KEY=...`** — gives withctx a Claude key. You can also put it in `ctx.yaml` under `ai.api_key` if you prefer; env wins when both are set.
3. **`ctx setup`** — walks your project, finds code and docs, writes `ctx.yaml`, then compiles a wiki under `.ctx/context/`. Takes ~30 seconds on a small repo.
4. **`ctx ask "..."`** — natural-language question answered from the wiki, with source citations. Add `--chat` for a stateful REPL.

> Older names (`ctx init`, `ctx go`, `ctx query`, `ctx chat`) still work as hidden aliases so your muscle memory isn't wasted — they map to the new verbs above.

## The 5 verbs you'll actually use every day

| Verb | When |
|---|---|
| `ctx ask "..."` | Any time you want an answer |
| `ctx sync` | Morning pull; after a big merge |
| `ctx status` | "Is the wiki healthy?" |
| `ctx approve <page>` | "I've read this and it's correct" |
| `ctx lint` | Before every PR |

That's 80% of the value. Everything else lives behind a flag or a less-common verb — [03-commands.md](03-commands.md) has the full surface (12 verbs total).

## What you got

```
.ctx/
├── context/          ← compiled wiki (plain markdown — cat it, commit it, ship it)
│   ├── overview.md
│   ├── architecture.md
│   ├── conventions.md
│   └── ...
├── usage.jsonl       ← token usage history
└── sync-index.json   ← hash index for incremental sync
ctx.yaml              ← your config — commit this
```

No proprietary format. No database. Just markdown files you can read with `less`.

## Setup flavours

withctx detects what kind of project you're in and adapts. There are three shapes:

### 1. Single repo (the default)

```
my-app/
├── .git/
├── src/
├── docs/
└── README.md
```

```bash
cd my-app
ctx setup
```

Walks `./src`, `./docs`, any markdown in the root. Writes `ctx.yaml` with one local source. Done.

### 2. Siblings under one folder (very common)

```
~/work/acme/
├── api/        ← git repo
├── auth/       ← git repo
├── web/        ← git repo
└── worker/     ← git repo
```

```bash
cd ~/work/acme
ctx setup
```

Because the parent has no `.git`, withctx auto-scans its children, reads each `.git/config` for the origin URL + branch, and asks:

```
Detected 4 git repos in this folder:
    api       github.com/acme/api     [main]
    auth      github.com/acme/auth    [main]
    web       github.com/acme/web     [develop]
    worker    github.com/acme/worker  [main]

Add them all to ctx.yaml? (Y/n)
```

Accepting writes them into both `repos:` (metadata) and `sources.local[]` (so ingest reads them). One wiki, one config, four repos. No flag needed.

### 3. Dedicated context repo (the aggregator pattern)

```
acme/context/           ← dedicated repo, lives on GitHub
├── .git/
├── .ctx/context/       ← the compiled wiki
├── ctx.yaml            ← references all source repos
└── .github/workflows/sync.yml
```

Use this when:
- You want the wiki browsable on GitHub without cluttering a product repo
- Multiple teams share one knowledge graph
- A scheduled GitHub Action keeps it fresh (see [04-recipes.md](04-recipes.md))

```bash
mkdir acme-context && cd acme-context
git init
ctx setup --scan                 # force scan even though this folder is itself a git repo
# or point at an org directly:
ctx setup --org acme --token ghp_...
```

`--scan` overrides the "this folder is itself a repo, don't recurse" guard. `--no-scan` turns it off unconditionally.

## Common setup variations

```bash
ctx setup --name my-project           # override detected project name
ctx setup --with jira,confluence      # also scaffold external connectors
ctx setup --org acme --token ghp_...  # discover every repo in a GitHub org
ctx setup --no-ingest                 # write ctx.yaml only, skip the first compile
ctx setup --demo                      # zero-cost demo — no API key needed
ctx setup --hooks                     # also drop pre-commit git hooks
ctx setup --reset                     # wipe .ctx/ and start over
ctx setup -y                          # skip all prompts (CI-friendly)
```

## Ask it anything

```bash
# One-shot question
ctx ask "how does auth work?"

# Follow-up with memory
ctx ask "what about refresh tokens" --continue

# Stateful REPL
ctx ask --chat

# Cheap semantic search (no answer synthesis)
ctx ask --search "rate limiting"

# Literal keyword search — zero LLM cost, works offline
ctx ask --grep "TODO"

# Ownership lookup
ctx ask --who "payments service"
```

One verb, one mental model: "I want to ask the wiki something." Flags pick the retrieval mode.

## Sanity check

```bash
ctx llm         # check LLM is reachable (provider, model, latency)
ctx doctor      # full pre-flight diagnostics
ctx status      # wiki health dashboard + approval ratio
ctx costs       # token usage so far
```

## The daily loop

```bash
ctx sync                             # morning: pull + recompile anything that changed
ctx ask "how does auth work?"        # throughout the day
ctx approve overview.md              # when you've read + confirmed a page is correct
ctx verify                           # fact-check claims against the live tree (LLM-free)
ctx lint                             # before every PR
ctx status                           # end of day: health check
```

Five commands. One mental model per command. Everything else is a flag you'll discover via `--help` the day you need it.

## The trust pipeline

Most wiki tools give you one dial: "this page exists". withctx gives you four, forming a pipeline that turns a draft page into a fact the team and CI will stake on:

```
sync ──▶ approve ──▶ verify ──▶ review --drift
 │         │           │              │
 │         │           │              └─ blocks PRs that would drift approved pages
 │         │           └──────────────── runs assertions against the live tree,
 │         │                              auto-promotes to "verified" tier
 │         └──────────────────────────── human vouches, auto-promotes to "asserted"
 └────────────────────────────────────── compiles the page from sources (`manual`)
```

Every step after `sync` is LLM-free and CI-safe. Once a page is approved and verified, you don't trust Claude — you trust the assertions Claude wrote, which the CLI re-checks every run.

```bash
ctx approve architecture.md          # I read it, it's right
ctx verify architecture.md           # every `src/...` it mentions actually exists
ctx review 1234 --drift              # this PR would drift architecture.md — fix it
ctx teach architecture.md            # drill me on what the page says
```

`ctx verify` auto-detects backticked paths and runs explicit `ctx-assert` fenced blocks for stronger checks (grep, regex, no-match). `ctx review --drift` classifies each touched page as `fresh`, `drifted`, `stale`, or "not approved" and exits non-zero on any approved page that drifted. `ctx teach` is the onboarding flashcard — it turns wiki prose into quiz questions so a new engineer can test recall without asking a colleague.

> **`ctx bless` still works.** The verb was renamed from `bless` to `approve` to match the code-review mental model. The old name is kept as a hidden alias so existing scripts, muscle memory, and CI pipelines don't break.

## What next?

- Add more sources (Jira, Confluence, GitHub, Slack...) → [02-sources.md](02-sources.md)
- See every command → [03-commands.md](03-commands.md)
- Onboarding recipes → [04-recipes.md](04-recipes.md)
- Full `ctx.yaml` reference → [07-config-reference.md](07-config-reference.md)

**On-prem / corporate network?** See the [troubleshooting guide](06-troubleshooting.md) for NODE_EXTRA_CA_CERTS, HTTPS_PROXY, and self-hosted Jira/Confluence/GitHub Enterprise setup.

## Update

```bash
ctx --version                       # check what you have
npm update -g withctx               # update to the latest
ctx doctor                          # run once after updating
```

If a sync index format changed, `ctx doctor` will tell you to run `ctx sync --full`.
