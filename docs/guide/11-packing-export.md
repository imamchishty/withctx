# Packing and Export

`ctx pack` compresses the wiki into a single context block sized for LLM consumption. `ctx export` saves the wiki in portable formats. Packing is how agents consume your project knowledge.

## ctx pack

### Basic Usage

Pack the entire wiki into a single output:

```bash
ctx pack
```

Output goes to stdout — a single markdown document containing the most important content from every wiki page, formatted for an LLM prompt.

### Writing to File

```bash
ctx pack --output CLAUDE.md
```

Creates a `CLAUDE.md` file that Claude Code reads automatically. This is the primary integration point for AI agents.

### Token Budgets

Control how much content goes into the packed output:

```bash
# Default: fits ~12,000 tokens
ctx pack

# Smaller budget for shorter prompts
ctx pack --budget 4000

# Larger budget for models with big context windows
ctx pack --budget 32000
```

When the wiki exceeds the budget, Claude prioritizes:
1. Architecture overview and key decisions
2. Content matching the current scope or query
3. Conventions and coding standards
4. Repo-specific details
5. Onboarding information

Lower-priority content is summarized or omitted to fit the budget.

### Scoped Packing

Pack only a section of the wiki relevant to a specific repo or topic:

```bash
# Context for working on the API service
ctx pack --scope repos/api-service

# Architecture context only
ctx pack --scope architecture

# Just decisions
ctx pack --scope decisions
```

Scoped packing includes:
- All pages within the specified scope
- Cross-referenced content from other pages that the scoped pages depend on
- Relevant conventions and decisions

```bash
ctx pack --scope repos/api-service --output CLAUDE.md
```

Produces a focused context block covering:
- What api-service does and how it is structured
- API routes and error handling
- Auth flow (because api-service depends on auth-service)
- Coding conventions relevant to the API
- Recent decisions affecting the API

### Query-Focused Packing

Pack context most relevant to a specific question:

```bash
ctx pack --query "How does payment processing work?"
```

Claude selects and prioritizes wiki content that answers the question. This is useful when an agent is about to work on a specific task.

```bash
ctx pack --query "payment refund flow" --budget 8000 --output CLAUDE.md
```

### Output Formats

```bash
# Claude Code format (default) — optimized for Claude
ctx pack --format claude --output CLAUDE.md

# OpenAI format — optimized for GPT system prompts
ctx pack --format openai --output system-prompt.txt

# Generic markdown — readable by any LLM or human
ctx pack --format markdown --output context.md
```

#### Claude Format

```markdown
# Project Context: acme-platform

## Architecture
The acme-platform is an e-commerce system with three services...

## Key Decisions
- OAuth 2.0 with PKCE (ADR-007) — replaced session cookies for mobile support
- PostgreSQL over DynamoDB — ACID transactions required for payments

## Conventions
- All HTTP handlers validate input with Zod schemas
- Error responses use { error: { code, message, details } } format
...
```

#### OpenAI Format

```
You are an AI assistant working on the acme-platform project.

PROJECT CONTEXT:
Architecture: E-commerce platform with three services (api-service, auth-service, web-app)...

KEY RULES:
1. All HTTP handlers must validate input with Zod schemas
2. Error responses use { error: { code, message, details } } format
...
```

### Combining Options

Options compose naturally:

```bash
# Scoped, budgeted, query-focused, written to file
ctx pack \
  --scope repos/api-service \
  --query "adding a new endpoint" \
  --budget 6000 \
  --format claude \
  --output CLAUDE.md
```

## ctx export

Export the entire wiki for archival, migration, or external consumption.

### Markdown Export

Copies the wiki directory structure to a new location:

```bash
ctx export --format markdown --output ./exported-wiki/
```

Creates:

```
exported-wiki/
  index.md
  architecture/
    overview.md
    auth.md
    ...
  repos/
    api-service.md
    ...
```

### JSON Export

Exports the entire wiki as a single JSON file:

```bash
ctx export --format json --output wiki.json
```

```json
{
  "project": "acme-platform",
  "exported_at": "2025-01-20T10:00:00Z",
  "pages": [
    {
      "path": "index.md",
      "title": "acme-platform",
      "content": "...",
      "sources": ["..."],
      "last_updated": "2025-01-20T06:00:00Z"
    },
    {
      "path": "architecture/overview.md",
      "title": "System Architecture",
      "content": "...",
      "sources": ["ACME-142", "Confluence:ENG/Architecture Overview"],
      "last_updated": "2025-01-20T06:00:00Z"
    }
  ]
}
```

Useful for:
- Feeding into other tools or dashboards
- Building custom integrations
- Creating backups before major changes

## Common Workflows

### Agent before coding

```bash
# Before an agent works on the auth service
ctx pack --scope repos/auth-service --budget 8000 --output CLAUDE.md
# Agent reads CLAUDE.md, writes code with full context
```

### Daily refresh for CI agents

```bash
# In GitHub Action, generate fresh context
ctx sync
ctx pack --output .ctx/context/CLAUDE.md
git add .ctx/context/CLAUDE.md
git commit -m "chore: refresh agent context"
```

### Onboarding document

```bash
# Generate a standalone onboarding doc
ctx pack --format markdown --budget 16000 --output onboarding-context.md
```

### Comparing formats

```bash
# See how many tokens each format uses
ctx pack --format claude | wc -w    # ~4,200 words
ctx pack --format openai | wc -w   # ~3,800 words (more compressed)
ctx pack --format markdown | wc -w # ~4,500 words (most readable)
```
