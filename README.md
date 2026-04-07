# withctx

**Claude compiles your project knowledge into a living wiki that engineers and agents can use.**

withctx connects to where your knowledge already lives — Jira, Confluence, Teams, GitHub, local docs — and has Claude compile it into structured markdown pages. Engineers read it to onboard. Agents read it before writing code.

```
Your scattered knowledge              Compiled wiki
─────────────────────                  ─────────────
147 Jira tickets                  →    services/payments.md
23 Confluence pages               →    architecture.md
500 Teams messages                →    decisions.md
6 GitHub repos                    →    repos/api-service/overview.md
12 PDFs and Word docs             →    conventions.md
Sarah's head                      →    manual/kafka-decision.md
```

## Quick Start

```bash
npm i -g withctx
cd your-project
ctx init                              # detect sources, create .ctx/
ctx ingest                            # Claude compiles the wiki
ctx chat                              # ask questions
ctx query "how does auth work?"       # one-off query
ctx lint                              # check wiki health
ctx pack --format claude-md           # export for agents
```

## How It Works

Inspired by [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): knowledge is compiled once into maintained wiki pages, not re-derived on every query.

```
Sources (Jira, Confluence, Teams, GitHub, docs)
  │
  ▼  ctx ingest
Claude reads everything, compiles structured wiki pages
  │
  ▼
.ctx/context/
├── overview.md          # Project summary
├── architecture.md      # Services, deps, infra
├── decisions.md         # ADRs, key choices
├── conventions.md       # Standards, patterns
├── repos/               # Per-repo deep context
├── services/            # Business domain context
├── onboarding/          # Auto-generated guides
└── CLAUDE.md            # Ready for agents
```

## Source Connectors

| Source | What it ingests |
|--------|----------------|
| Local files | Markdown, code, text files |
| PDF | Text, tables, sections |
| Word (.docx) | Text, tables, embedded diagrams (Claude vision) |
| PowerPoint (.pptx) | Slides, speaker notes, embedded images |
| Excel (.xlsx/.csv) | Sheets, data, headers |
| GitHub | Repos, issues, PRs, code |
| Jira | Issues, epics, comments (multiple projects, JQL) |
| Confluence | Pages, spaces (multiple spaces, labels, page trees) |
| Microsoft Teams | Channels, threads, transcripts (noise filtered) |

## Key Features

- **Wiki compilation** — Claude reads your sources and writes structured markdown pages
- **`ctx lint`** — detects contradictions, stale content, orphan pages, missing references
- **`ctx chat`** — conversational Q&A with your project knowledge
- **`ctx add`** — inject context that only exists in your head (with corrections that override stale docs)
- **`ctx pack`** — export context in CLAUDE.md, OpenAI system prompt, or markdown format
- **`ctx sync`** — incremental updates, only recompiles changed content
- **Cost tracking** — know exactly what you spend on Claude API calls
- **Multi-repo** — single-repo or multi-repo projects, same tool
- **GitHub Actions** — auto-sync wiki on a schedule
- **Noise filtering** — Teams messages filtered to decisions only

## Single Repo vs Multi-Repo

**Single repo** — wiki lives in the repo:
```
my-project/
├── src/
├── .ctx/context/     # wiki here
└── ctx.yaml
```

**Multi-repo** — dedicated context repo:
```
acme/context/         # separate repo for the wiki
├── .ctx/context/     # wiki spanning all repos
├── ctx.yaml          # references all repos + external sources
└── .github/workflows/sync.yml
```

## Requirements

- Node.js 20+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed
- `ANTHROPIC_API_KEY` environment variable set

## Documentation

See the [User Guide](docs/guide/) for complete setup and usage instructions.

## License

MIT
