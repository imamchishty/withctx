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

## "Multi-repo monorepo / microservices"

```yaml
sources:
  - type: github
    repos: [acme/api, acme/web, acme/worker]
  - type: local
    paths: ["./packages/*/README.md", "./packages/*/ARCHITECTURE.md"]
```

withctx detects cross-repo references in markdown links and surfaces them in the wiki under `cross-repo/`.

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
