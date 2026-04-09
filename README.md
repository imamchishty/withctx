# withctx

**AI compiles your project knowledge into a living wiki that engineers and agents read before writing code.**

withctx connects to where your knowledge already lives — Jira, Confluence, Teams, GitHub, Slack, Notion, SharePoint, local docs — and has AI compile it into structured markdown pages. Engineers read it to onboard. Agents read it before writing code.

```
Your scattered knowledge              Compiled wiki
─────────────────────                  ─────────────
147 Jira tickets                  →    services/payments.md
23 Confluence pages               →    architecture.md
500 Teams messages                →    decisions.md
6 GitHub repos                    →    repos/api-service/overview.md
12 PDFs and Word docs             →    conventions.md
CI/CD pipeline data               →    repos/api-service/ci.md
Coverage reports                  →    repos/api-service/testing.md
Sarah's head                      →    manual/kafka-decision.md
```

## Get Started in 30 Seconds

```bash
npm install -g withctx
export ANTHROPIC_API_KEY=sk-ant-your-key-here   # get one at console.anthropic.com
cd your-project
ctx go                                           # That's it. One command.
```

`ctx go` detects your sources, creates the config, and compiles the wiki. Then ask it anything:

```bash
ctx query "how does auth work?"
ctx chat                              # Interactive Q&A
```

**Prerequisites:** Node.js 20+ and an API key from Anthropic, OpenAI, Google, or Ollama (local).

## Install & Update

```bash
# Install
npm install -g withctx

# Check your version
ctx --version

# Update to latest
npm update -g withctx
```

## Power Features

These are the commands that make withctx unique — no other tool has this depth of project understanding:

```bash
# Context-aware PR review — catches issues no linter can find
ctx review https://github.com/acme/api-service/pull/47

# Deep file explanation — not just what, but WHY and how it connects
ctx explain src/middleware/auth.ts

# Impact analysis — "what would break if we..."
ctx impact "migrate from MongoDB to PostgreSQL"

# Auto-generated FAQ — top 20 questions every engineer asks
ctx faq --for new-engineer

# Auto release notes from git + wiki context
ctx changelog --since v2.3.0

# Project health dashboard (free, no Claude call)
ctx metrics
```

## How It Works

Inspired by [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): knowledge is compiled once into maintained wiki pages, not re-derived on every query.

```
Sources (Jira, Confluence, Teams, GitHub, SharePoint, docs, CI/CD)
  │
  ▼  ctx ingest
Claude reads everything, compiles structured wiki pages
  │
  ▼
.ctx/context/
├── index.md             # Catalog of all pages (browsable on GitHub)
├── overview.md          # Project summary
├── architecture.md      # Services, deps, infra
├── decisions.md         # ADRs, key choices
├── conventions.md       # Standards, patterns
├── faq.md               # Auto-generated FAQ
├── repos/               # Per-repo deep context
├── cross-repo/          # Dependencies, data flow, deploy order
├── services/            # Business domain context
├── people/              # Team ownership
├── onboarding/          # Auto-generated guides
└── manual/              # Manually added context
```

## MCP Integration (AI Agent Support)

Connect AI coding agents directly to your wiki using MCP (Model Context Protocol). Agents can search context, read architecture docs, and store learnings — automatically, while they work.

```bash
ctx mcp --list                        # See all 10 available tools
```

**Claude Code** — add to `.claude/settings.json`:
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

**Cursor** — add to `.cursor/mcp.json`:
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

See [MCP Integration Guide](docs/guide/19-mcp-integration.md) for full setup with all tools.

## RAG Exports

Export your wiki in formats ready for AI pipelines (LangChain, LlamaIndex, or plain JSON chunks):

```bash
ctx export --format langchain          # LangChain Document objects
ctx export --format llamaindex         # LlamaIndex Node objects
ctx export --format rag-json           # Framework-agnostic JSON chunks
ctx export --format rag-json --chunk-size 256   # Custom chunk size
```

## Vector Search

Search your wiki by meaning, not just keywords:

```bash
ctx embed                                    # Generate embeddings (one-time)
ctx search "how does authentication work"    # Semantic search
```

## All 34 Commands

| Command | What it does | Costs? |
|---------|-------------|--------|
| `ctx go` | One command to start (init + ingest) | Paid |
| `ctx setup` | Interactive setup wizard | Free |
| `ctx init` | Setup project, detect sources | Free |
| `ctx doctor` | Pre-flight diagnostics | Free |
| `ctx ingest` | Full wiki compilation from all sources | Paid |
| `ctx sync` | Incremental update (changed sources only) | Paid |
| `ctx query` | Ask a question, get an answer with sources | Paid |
| `ctx chat` | Interactive Q&A session | Paid |
| `ctx add` | Add manual context (notes, decisions, corrections) | Paid |
| `ctx review` | Context-aware PR review | Paid |
| `ctx explain` | Deep file explanation with wiki context | Paid |
| `ctx impact` | Impact analysis for proposed changes | Paid |
| `ctx faq` | Auto-generate FAQ from wiki | Paid |
| `ctx changelog` | Auto release notes from git + wiki | Paid |
| `ctx lint` | Check for contradictions, stale content, broken links | Paid |
| `ctx pack` | Export wiki as CLAUDE.md / system prompt | Free |
| `ctx export` | Export wiki (markdown, JSON, LangChain, LlamaIndex, RAG) | Free |
| `ctx embed` | Generate vector embeddings for semantic search | Depends |
| `ctx search` | Semantic search across wiki | Free |
| `ctx mcp` | Start MCP server for AI agent integration | Free |
| `ctx onboard` | Generate onboarding guide | Paid |
| `ctx import` | Import existing markdown into wiki | Paid |
| `ctx status` | Show wiki health and freshness | Free |
| `ctx metrics` | Health dashboard with score 0-100 | Free |
| `ctx timeline` | Visualize project history | Free |
| `ctx diff` | Show wiki changes since last sync | Free |
| `ctx graph` | Visualize page relationships (mermaid) | Free |
| `ctx config` | View/edit ctx.yaml from CLI | Free |
| `ctx sources` | Manage source connectors | Free |
| `ctx repos` | Manage repository registrations | Free |
| `ctx costs` | Token usage and cost report | Free |
| `ctx watch` | Auto-sync on file changes | Paid |
| `ctx reset` | Wipe wiki and recompile | Free |
| `ctx serve` | Start REST API server | Free |

## 16 Source Connectors

| Source | What it ingests |
|--------|----------------|
| **Local files** | Markdown, code, text files |
| **PDF** | Text, tables, sections |
| **Word** (.docx) | Text, tables, embedded diagrams (Claude vision) |
| **PowerPoint** (.pptx) | Slides, speaker notes, embedded images |
| **Excel** (.xlsx/.csv) | Sheets, data, headers as markdown tables |
| **GitHub** | Repos, issues, PRs, code |
| **Jira** | Issues, epics, comments (multiple projects, JQL, labels) |
| **Confluence** | Pages, spaces (multiple spaces, labels, page trees) |
| **Microsoft Teams** | Channels, threads, transcripts (noise filtered) |
| **SharePoint** | Word, Excel, PowerPoint, PDF from SharePoint/OneDrive |
| **CI/CD** | GitHub Actions workflow runs, build stats, failure analysis |
| **Test Coverage** | lcov, istanbul, cobertura reports with per-file breakdown |
| **Pull Requests** | Merged PRs, reviewers, files changed, activity patterns |
| **OpenAPI** | API endpoints, schemas, auth requirements |
| **Notion** | Database entries, pages, content blocks |
| **Slack** | Channel messages, threads (noise filtered) |

## Single Repo vs Multi-Repo

**Single repo** — wiki lives in the repo:
```
my-project/
├── src/
├── .ctx/context/     # wiki here — committed to git
└── ctx.yaml
```

**Multi-repo** — dedicated context repo:
```
acme/context/         # separate repo for the wiki
├── .ctx/context/     # wiki spanning all repos
├── ctx.yaml          # references all repos + external sources
└── .github/workflows/sync.yml  # auto-sync every 30 min
```

## For AI Agents

Agents read the compiled wiki before writing code. Three ways to connect:

```bash
# 1. MCP — agents connect directly (recommended)
ctx mcp                               # Start MCP server for Claude Code, Cursor, Windsurf

# 2. Generate CLAUDE.md as a static file
ctx pack --format claude-md --output CLAUDE.md

# 3. REST API for custom integrations
ctx serve                             # REST API on :4400
```

## Cost

Typical monthly costs:

| Team Size | Monthly Cost |
|-----------|-------------|
| Small (1 repo, 5 engineers) | ~$3-13 |
| Medium (5 repos, Jira + Confluence) | ~$10-40 |
| Large (15+ repos, full integration) | ~$20-120 |

Uses prompt caching for ~90% cost reduction on repeated context. Budget enforcement built in.

## Documentation

- [Quick Start](docs/guide/02-quickstart.md) — zero to working wiki in 30 seconds
- [All Commands](docs/guide/07-commands.md) — full CLI reference (34 commands)
- [Source Setup](docs/guide/05-sources.md) — configure all 16 connectors
- [Power Features](docs/guide/17-new-features.md) — review, explain, impact, vector search, and more
- [Microservices Guide](docs/guide/18-microservices.md) — multi-repo teams
- [MCP Integration](docs/guide/19-mcp-integration.md) — AI agent setup for Claude Code, Cursor, Windsurf
- [For Agents](docs/guide/15-for-agents.md) — agent integration guide
- [Full Guide](docs/guide/) — all 19 pages

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Easiest ways to contribute:
- Add a new connector (Google Drive, Linear, Asana, Trello)
- Add an export format (Cursor rules, Windsurf, Copilot)
- Add a lint rule
- Improve documentation

## License

MIT
