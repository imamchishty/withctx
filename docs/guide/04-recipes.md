# 4. Recipes

Real problems, copy-paste solutions.

---

## "I just joined the team — get me up to speed"

```bash
ctx onboard --role backend          # or frontend, sre, qa, pm
ctx glossary                        # acronyms + internal terms
ctx query "what are the gotchas with the payments service?"
ctx who payments                    # who owns it
```

The first command produces a Markdown file tailored to your role.

---

## "I'm about to make a change — what breaks?"

```bash
ctx impact "rename the orders.user_id column to customer_id"
```

It scans the wiki for everywhere that's referenced (services, docs, tickets, decisions) and lists the blast radius.

---

## "I need to review a PR but don't know the codebase"

```bash
ctx review https://github.com/yourorg/repo/pull/1234
ctx review --staged                 # local working changes
ctx review --focus security
```

Reviews against your team's conventions as captured in the wiki — not generic advice.

---

## "Wiki feels stale"

```bash
ctx status                          # see freshness per page
ctx sync                            # incremental — skips unchanged docs
ctx sync --force                    # full rebuild if you've added new sources
```

Set up `ctx watch` in a tmux pane, or add a cron / GitHub Action.

---

## "Cost is creeping up — where's it going?"

```bash
ctx costs
```

Shows lifetime spend, this month, per-operation bar chart, daily sparkline, wiki growth. Set a budget in `ctx.yaml`:

```yaml
costs:
  budget: 25.00      # USD per month
  alert_at: 80       # warn at 80%
```

Then `ctx doctor` will flag if you're over.

Three things that drop cost fast:
1. **Prompt caching** is on by default (~90% off cached system prompts).
2. **Incremental sync** (`ctx sync` not `ingest`) only re-compiles changed docs.
3. **Vector retrieval** in `ctx query` (default) sends ~8 chunks not the whole wiki.

---

## "Multi-repo / monorepo / microservices"

withctx supports three multi-repo patterns. Pick the one that matches how your code is laid out.

### Pattern A — monorepo (all repos in one directory tree)

You already work from a single root. Use `local` and let glob patterns split it up.

```yaml
sources:
  - type: local
    paths:
      - "./packages/api/**"
      - "./packages/web/**"
      - "./packages/worker/**"
    exclude: ["**/node_modules", "**/dist", "**/.next"]

wiki:
  group_by: package         # one wiki section per package
```

The wiki is laid out as:
```
.ctx/context/
├── repos/
│   ├── api/architecture.md
│   ├── web/architecture.md
│   └── worker/architecture.md
└── cross-repo/
    └── shared-conventions.md
```

### Pattern B — sibling repos on disk (the "meta directory" approach)

You have several repos checked out side-by-side and want one wiki across all of them:

```
~/work/acme/
├── ctx.yaml          ← run ctx from here
├── api/              ← separate git repo
├── web/              ← separate git repo
└── worker/           ← separate git repo
```

```yaml
sources:
  - type: local
    paths:
      - "./api/**/*.md"
      - "./web/**/*.md"
      - "./worker/**/*.md"
      - "./api/src/**"
      - "./web/src/**"
      - "./worker/src/**"
    exclude: ["**/node_modules", "**/dist"]
```

Run `ctx setup` from `~/work/acme`. The wiki captures cross-repo conventions in one place without anyone needing a monorepo migration.

### Pattern C — remote multi-repo (GitHub)

You don't want to check out 12 repos locally. Pull from GitHub instead:

```yaml
sources:
  - type: github
    repos:
      - acme/api
      - acme/web
      - acme/worker
      - acme/billing
      - acme/notifications
    include:
      - "README.md"
      - "ARCHITECTURE.md"
      - "docs/**/*.md"
      - "src/**/*.{ts,js,py,go}"
    branch: main
```

GitHub auth: `export GITHUB_TOKEN=ghp_...` (`repo` + `read:org`).

You can mix this with `local` for the *one* repo you have checked out and want code-level depth on:

```yaml
sources:
  - type: local            # the repo you're actively working in
    paths: ["."]
  - type: github           # all the others, README/ARCHITECTURE only
    repos: [acme/web, acme/worker, acme/billing]
    include: ["README.md", "ARCHITECTURE.md", "docs/**/*.md"]
```

### Cross-repo links

withctx detects markdown links between repos (e.g. `[orders service](../orders/README.md)`) and surfaces them in `.ctx/context/cross-repo/`. So if `api`'s README links to `worker`'s deployment doc, the wiki will show that relationship.

It also pairs with multi-space Confluence — give it the project's spaces and it will resolve cross-space page links the same way:

```yaml
sources:
  - type: confluence
    space: [ENG, OPS, ARCH]    # array, not string
```

### CI/CD pattern: one shared wiki, many repos triggering rebuild

The "right" way to keep the wiki fresh in a multi-repo org:

1. Commit `.ctx/context/` to one designated repo (e.g. `acme/wiki`) — it's just markdown.
2. Add a GitHub Action in *each* source repo that calls a `repository_dispatch` on `acme/wiki` whenever main changes.
3. The wiki repo's CI runs `ctx sync && git commit -am "wiki: sync from $REPO" && git push`.

```yaml
# .github/workflows/sync-wiki.yml in acme/wiki
on:
  repository_dispatch:
    types: [source-changed]
  schedule:
    - cron: "0 6 * * *"        # daily safety net
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g withctx
      - run: ctx sync --force
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - run: |
          git config user.name "withctx-bot"
          git config user.email "bot@acme.com"
          git add .ctx/context
          git diff --cached --quiet || git commit -m "wiki: scheduled sync"
          git push
```

Devs hit one wiki. Cost is centralised. Token usage is observable via `ctx costs` on the wiki repo's CI machine.

### Sanity checks for multi-repo

```bash
ctx doctor               # confirms every configured source's creds
ctx status               # which pages came from which repo
ctx sources              # list configured sources with last-seen counts
```

---

## "I want the team to use the same wiki without each running ingest"

Two options:

1. **Commit `.ctx/context/` to git.** It's just markdown. PR diffs become reviewable knowledge changes.
2. **`ctx serve`** — runs an HTTP API on a shared box, devs hit it from their editors.

---

## "I want this wiki inside Cursor / Claude Code"

```bash
ctx mcp        # starts an MCP server
```

Then point your editor's MCP config at the local server. See [05-for-agents.md](05-for-agents.md).

---

## "Someone keeps asking 'why did we choose Kafka?'"

Get it written down once:

```bash
ctx faq --scope architecture
```

Generates a Q&A from your wiki. Bonus: it picks up *implicit* decisions from Slack and Jira if those sources are configured.
