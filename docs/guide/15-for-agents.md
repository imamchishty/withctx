# For Agents

withctx is built for two audiences: engineers who read the wiki, and AI agents that consume it before writing code. This page covers how agents integrate with withctx.

## The Core Idea

An AI coding agent (Claude Code, Copilot, Cursor, a custom OpenAI agent) sees only the code in front of it. It does not know your architecture decisions, team conventions, domain constraints, or the Jira epic that explains why the payment service exists.

withctx fills that gap. Before an agent writes code, it reads a compiled context block that contains the project knowledge it needs.

## Method 1: CLAUDE.md File

Claude Code automatically reads a `CLAUDE.md` file in the project root. Generate one with:

```bash
ctx pack --output CLAUDE.md
```

The agent now has full project context every time it runs. Regenerate it periodically or in CI.

### Scoped CLAUDE.md

For a multi-repo setup, generate a scoped context for each repo:

```bash
# In the context repo
ctx pack --scope repos/api-service --output ../acme-api/CLAUDE.md
ctx pack --scope repos/auth-service --output ../acme-auth/CLAUDE.md
ctx pack --scope repos/web-app --output ../acme-web/CLAUDE.md
```

Each repo gets context relevant to its own concerns, plus cross-cutting architecture decisions and conventions.

### Task-Specific CLAUDE.md

When an agent is about to work on a specific task, generate context focused on that task:

```bash
ctx pack --query "payment refund flow" --budget 8000 --output CLAUDE.md
```

The agent gets context prioritized around payment refunds: the refund endpoint, Stripe integration, database schema for refund records, and the decision to use idempotency keys.

## Method 2: Direct Wiki Reading

Agents that can read files can access the wiki directly:

```
.ctx/context/
  index.md                   # Start here — overview and links
  architecture/overview.md   # System design
  repos/api-service.md       # Repo-specific context
  conventions/coding-standards.md  # Team rules
```

An agent workflow might:

1. Read `index.md` to understand the project structure
2. Read the repo-specific page for the service it is working on
3. Read `conventions/coding-standards.md` for team rules
4. Write code that follows all conventions with full context

## Method 3: ctx serve API

For programmatic access, start the HTTP API:

```bash
ctx serve --port 3100
```

### API Endpoints

#### GET /api/query

Ask a question against the wiki.

```bash
curl "http://localhost:3100/api/query?q=How+does+auth+work"
```

```json
{
  "answer": "The platform uses OAuth 2.0 with PKCE flow...",
  "sources": ["architecture/auth.md", "repos/auth-service.md"]
}
```

#### GET /api/pack

Get a packed context block.

```bash
curl "http://localhost:3100/api/pack?scope=repos/api-service&budget=8000"
```

```json
{
  "context": "# Project Context: acme-platform\n\n## api-service\n...",
  "tokens": 7842,
  "pages_included": 6
}
```

#### GET /api/pages

List all wiki pages.

```bash
curl "http://localhost:3100/api/pages"
```

```json
{
  "pages": [
    {"path": "index.md", "title": "acme-platform", "last_updated": "2025-01-20"},
    {"path": "architecture/overview.md", "title": "System Architecture", "last_updated": "2025-01-20"}
  ]
}
```

#### GET /api/pages/:path

Read a specific wiki page.

```bash
curl "http://localhost:3100/api/pages/architecture/auth.md"
```

```json
{
  "path": "architecture/auth.md",
  "title": "Authentication Architecture",
  "content": "## Authentication\n\nThe platform uses OAuth 2.0...",
  "sources": ["ACME-142", "Confluence:ENG/Auth Design"],
  "last_updated": "2025-01-20"
}
```

#### GET /api/status

Get wiki status and freshness.

```bash
curl "http://localhost:3100/api/status"
```

## Example: Claude Code Agent Workflow

A typical Claude Code workflow with withctx:

### Setup (once)

```bash
# In the context repo
ctx ingest

# Generate CLAUDE.md for each service repo
ctx pack --scope repos/api-service --output ../acme-api/CLAUDE.md
```

### Daily (via GitHub Action)

```yaml
- name: Sync and pack
  run: |
    ctx sync
    ctx pack --scope repos/api-service --output ../acme-api/CLAUDE.md
    ctx pack --scope repos/auth-service --output ../acme-auth/CLAUDE.md
    ctx pack --scope repos/web-app --output ../acme-web/CLAUDE.md
```

### Agent Working Session

The engineer opens Claude Code in `acme-api/`. Claude reads `CLAUDE.md` and knows:

- The API uses Fastify with domain-organized plugins
- Auth is OAuth 2.0 with PKCE, JWTs from auth-service
- All handlers must validate input with Zod
- Error responses use `{ error: { code, message, details } }`
- Database is Postgres via Prisma
- Rate limiting is 10 req/s for most endpoints

The agent writes code that follows every convention and understands the full architecture.

## Example: OpenAI Agent Workflow

For agents using the OpenAI API (GPT-4, etc.):

### Generate System Prompt

```bash
ctx pack --format openai --budget 6000 --output system-prompt.txt
```

### Use in API Call

```python
import openai

# Read the packed context
with open("system-prompt.txt") as f:
    system_prompt = f.read()

response = openai.chat.completions.create(
    model="gpt-4o",
    messages=[
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "Add a refund endpoint to the payments service"}
    ]
)
```

### Use via API Server

```python
import requests

# Get context from withctx API
ctx = requests.get(
    "http://localhost:3100/api/pack",
    params={"scope": "repos/api-service", "budget": 8000}
).json()

response = openai.chat.completions.create(
    model="gpt-4o",
    messages=[
        {"role": "system", "content": ctx["context"]},
        {"role": "user", "content": "Add a refund endpoint to the payments service"}
    ]
)
```

## Example: Custom Agent Pipeline

For custom agent pipelines that run autonomously:

```python
import subprocess
import json

def get_context(scope: str, query: str = None) -> str:
    """Get project context from withctx."""
    cmd = ["ctx", "pack", "--scope", scope, "--budget", "8000"]
    if query:
        cmd.extend(["--query", query])
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.stdout

def ask_wiki(question: str) -> dict:
    """Query the wiki directly."""
    result = subprocess.run(
        ["ctx", "query", "--json", question],
        capture_output=True, text=True
    )
    return json.loads(result.stdout)

# Agent workflow
context = get_context("repos/api-service", query="payment endpoints")
# Feed context into LLM prompt...

# Check a specific question
answer = ask_wiki("What error codes does the payment service return?")
# Use answer in agent logic...
```

## Best Practices for Agent Integration

**Pack once per task, not per question.** Use `ctx pack` (free) at the start of a task rather than `ctx query` (costs per call) for every question the agent has.

**Scope aggressively.** An agent working on auth does not need product catalog context. Use `--scope repos/auth-service` to keep the context focused and the token count low.

**Use query-focused packing for complex tasks.** When the agent is working on a specific feature, `--query "payment refund flow"` prioritizes the most relevant content.

**Refresh CLAUDE.md in CI.** Do not rely on manually running `ctx pack`. Include it in your sync GitHub Action so CLAUDE.md is always current.

**Match budget to model context window.** For Claude with 200K context, you can afford a larger budget. For GPT-4o with 128K, keep the budget tighter. The packed context should not exceed 10-15% of the model's context window to leave room for the actual task.
