# Quickstart

## Get Started in 30 Seconds

```bash
npm install -g withctx
cd your-project
ctx go
```

That's it. `ctx go` initializes your project, detects your sources (docs, code, README), and compiles your wiki in one command.

Once it finishes, ask it anything:

```bash
ctx query "What is the tech stack?"
ctx chat                        # Interactive Q&A
```

---

## Prerequisites

### 1. Node.js 20+

**Mac:**
```bash
brew install node
```

**Windows:**
Download from https://nodejs.org (LTS version) and run the installer.

**Linux:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. An AI Provider API Key

You need an API key from at least one provider. Anthropic (Claude) is recommended:

1. Go to https://console.anthropic.com
2. Sign up or log in
3. Go to API Keys and create a key
4. Set it in your terminal:

```bash
# Mac/Linux — add to ~/.zshrc or ~/.bashrc to persist
export ANTHROPIC_API_KEY=sk-ant-your-key-here

# Windows (PowerShell)
$env:ANTHROPIC_API_KEY = "sk-ant-your-key-here"
```

Or create a `.env` file in your project root:
```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Other providers also work (OpenAI, Google Gemini, Ollama). See [Multi-Provider AI](17-new-features.md#multi-provider-ai) for details.

### 3. Verify Setup

```bash
ctx doctor
```

This checks Node.js, your API key, and connectivity. Fix any issues it reports before proceeding.

---

## Optional Next Steps

### Connect more sources

Edit `ctx.yaml` to add Jira, Confluence, GitHub, Slack, Notion, and more:

```yaml
sources:
  local:
    paths:
      - ./docs/
      - ./src/
  jira:
    host: https://your-org.atlassian.net
    projects:
      - key: PROJ
```

Then re-ingest:
```bash
ctx ingest
```

### Use the interactive setup wizard

If you prefer guided setup over editing YAML:

```bash
ctx setup
```

### Enable semantic search

```bash
ctx embed                                    # Generate embeddings
ctx search "how does authentication work"    # Search by meaning
```

### Connect AI coding agents

If you use Claude Code, Cursor, or Windsurf, connect them to your wiki via MCP:

```bash
ctx mcp --list                # See available tools
```

See [MCP Integration](19-mcp-integration.md) for setup instructions.

### Export for AI pipelines

```bash
ctx export --format langchain    # For LangChain
ctx export --format llamaindex   # For LlamaIndex
ctx export --format rag-json     # Framework-agnostic JSON chunks
```

---

## What's Next

- [Single-repo setup](03-single-repo-setup.md) — full setup for a simple project
- [Multi-repo setup](04-multi-repo-setup.md) — dedicated context repo for larger teams
- [Microservices guide](18-microservices.md) — multi-repo teams with cross-service context
- [Sources](05-sources.md) — connect all 16 source types
- [Commands](07-commands.md) — full CLI reference
- [MCP Integration](19-mcp-integration.md) — AI agent setup
