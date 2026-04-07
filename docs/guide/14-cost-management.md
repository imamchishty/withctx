# Cost Management

withctx uses the Anthropic API (via Claude CLI) for compilation, querying, linting, and syncing. Understanding what costs money and how to control it helps you budget effectively.

## What Calls Claude (Costs Money)

| Command | Claude API call | Typical cost |
|---------|----------------|-------------|
| `ctx ingest` | Yes — full compilation | $0.50-2.00 (depends on source volume) |
| `ctx sync` | Yes — incremental update | $0.05-0.25 per run |
| `ctx query` | Yes — answers from wiki | $0.005-0.02 per query |
| `ctx chat` | Yes — per message | $0.005-0.02 per message |
| `ctx add` | Yes — compiles into wiki | $0.005-0.01 per add |
| `ctx lint` | Yes — analyzes wiki | $0.10-0.15 per run |
| `ctx onboard` | Yes — generates guide | $0.05-0.10 per run |

## What Is Free (No Claude Calls)

| Command | Why it's free |
|---------|--------------|
| `ctx init` | Creates files locally |
| `ctx sources` | Checks API connectivity, no Claude |
| `ctx repos` | Lists configured repos |
| `ctx diff` | Checks source timestamps only |
| `ctx status` | Reads local metadata |
| `ctx pack` | Reads and formats existing wiki pages |
| `ctx export` | Copies existing wiki pages |
| `ctx costs` | Reads local cost log |
| `ctx serve` | Starts HTTP server (queries still cost per-call) |

## The ctx costs Command

Track your spending:

```bash
ctx costs
```

```
withctx usage — acme-platform

  This month (January 2025):
    Command       Input tokens   Output tokens   Cost
    ─────────────────────────────────────────────────
    ingest           145,000        28,000       $0.85
    sync (x5)         62,000        12,400       $0.38
    query (x12)        8,100         3,200       $0.06
    chat (x3 sessions) 4,500        1,800       $0.03
    add (x8)           3,200         1,100       $0.02
    lint (x2)         38,000         5,600       $0.22
    ─────────────────────────────────────────────────
    Total            260,800        52,100       $1.56

  Lifetime: $1.56
```

### By Month

```bash
ctx costs --month 2025-01
```

### JSON Output

```bash
ctx costs --json
```

## Budget Configuration

Set monthly and per-command budgets in `ctx.yaml`:

```yaml
# ctx.yaml
costs:
  monthly_budget: 10.00          # Warn when approaching $10/month
  per_ingest_budget: 3.00        # Max cost per ingest run
  per_sync_budget: 0.50          # Max cost per sync run
  warn_at: 0.80                  # Warn at 80% of budget
```

When a budget is approaching:

```bash
ctx sync
```

```
 Warning: Monthly cost is $8.42 / $10.00 (84%)
 Sync complete: 2 pages updated
```

When a budget is exceeded:

```bash
ctx ingest
```

```
 Monthly budget exceeded ($10.12 / $10.00)
 Use --force to override budget limit
```

## Model Selection

By default, withctx uses the model configured in your Claude CLI. You can override it for cost optimization:

```yaml
# ctx.yaml
model:
  default: claude-sonnet-4-20250514     # Good balance of quality and cost
  ingest: claude-sonnet-4-20250514      # Full compilation — needs quality
  sync: claude-sonnet-4-20250514        # Incremental updates
  query: claude-haiku-4-20250414         # Fast, cheap for Q&A
  lint: claude-sonnet-4-20250514        # Needs reasoning for contradictions
```

### Cost Comparison by Model

Approximate costs for a 14-page wiki from 600+ sources:

| Operation | Haiku | Sonnet | Opus |
|-----------|-------|--------|------|
| Initial ingest | $0.15 | $0.85 | $4.50 |
| Daily sync | $0.02 | $0.11 | $0.60 |
| Single query | $0.002 | $0.01 | $0.05 |
| Lint | $0.03 | $0.15 | $0.80 |

### Recommendations

- **Budget-conscious teams:** Use Haiku for queries and syncs, Sonnet for ingest and lint
- **Quality-focused teams:** Use Sonnet for everything, Opus for initial ingest
- **High-volume querying:** Use Haiku for queries (sub-cent per question)

## Typical Monthly Costs

### Small Team (1-5 engineers, 1 repo, weekly sync)

```
Initial ingest (1x):     $0.85
Weekly sync (4x):         $0.44
Queries (20x):            $0.20
Manual adds (10x):        $0.10
Monthly lint (2x):        $0.30
────────────────────────────────
Monthly total:          ~$1.89
```

### Medium Team (5-15 engineers, 3 repos, daily sync)

```
Initial ingest (1x):     $2.00
Daily sync (22x):         $2.42
Queries (100x):           $1.00
Manual adds (30x):        $0.30
Weekly lint (4x):         $0.60
────────────────────────────────
Monthly total:          ~$6.32
```

### Large Team (15+ engineers, 10+ repos, twice-daily sync)

```
Initial ingest (1x):     $5.00
Twice-daily sync (44x):  $4.84
Queries (500x):           $5.00
Manual adds (50x):        $0.50
Daily lint (22x):         $3.30
────────────────────────────────
Monthly total:         ~$18.64
```

## Cost Optimization Tips

**Use scoped sync.** If only one source changed, sync just that source:

```bash
ctx sync --source jira    # Only check Jira, skip GitHub/Confluence/Teams
```

**Use query budgets.** For agents making many queries, use Haiku:

```yaml
model:
  query: claude-haiku-4-20250414
```

**Reduce sync frequency.** For low-activity projects, weekly sync is sufficient. Check with `ctx diff` (free) before deciding to sync.

**Limit source scope.** In `ctx.yaml`, use JQL filters, date ranges, and path exclusions to avoid ingesting content that does not contribute to useful wiki pages.

**Pack instead of query.** If an agent needs context for a task, `ctx pack` (free) is cheaper than multiple `ctx query` calls. Pack once, use the output for the entire task.
