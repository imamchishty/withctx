# 5. For AI agents

withctx is a knowledge layer for humans *and* agents. Three ways to plug it into an agent:

## Option A: MCP server (Cursor, Claude Code, Claude Desktop)

```bash
ctx mcp
```

Adds these tools to the agent:
- `query_wiki` — semantic search over the wiki
- `get_page` — read a specific page
- `list_pages` — discover what's there
- `who_owns` — ownership lookup
- `impact_analysis` — blast-radius check before edits

### Cursor

`~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "withctx": {
      "command": "ctx-mcp",
      "args": []
    }
  }
}
```

### Claude Code

```bash
claude mcp add withctx -- ctx-mcp
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "withctx": { "command": "ctx-mcp" }
  }
}
```

## Option B: RAG export

```bash
ctx export rag --output ./rag/
```

Produces:
```
rag/
├── chunks.jsonl       ← {"id": "...", "text": "...", "source": "...", "embedding": [...]}
├── pages.jsonl        ← page-level metadata
└── manifest.json      ← model + dimensions + chunk count
```

Drop it into Pinecone, Chroma, Weaviate, pgvector — any vector store.

```bash
ctx export rag --no-embeddings    # text only, embed yourself
ctx export rag --format jsonl     # default
ctx export rag --format parquet   # for data pipelines
```

## Option C: Single-file pack

```bash
ctx pack --output context.md
```

One markdown file with the whole wiki. Drop into a system prompt or upload to a model. Smallest setup, biggest token bill — only good for small wikis.

## Option D: HTTP API

```bash
ctx serve --port 3000
```

```
GET  /pages              → list
GET  /pages/:path        → fetch one
POST /query              → {"q": "..."} → answer + citations
GET  /status             → wiki health
```

## What an agent should ALWAYS do before writing code

1. `query_wiki` for the area being changed
2. `who_owns` to know who to tag
3. `impact_analysis` for the proposed change
4. Then write code

That's the whole point of withctx for agents — eliminate the "AI writes code that doesn't fit our conventions" failure mode.
