# MCP Integration Guide

How to connect AI coding agents to your withctx wiki so they can read project context while writing code.

---

## What Is MCP?

MCP (Model Context Protocol) is an open standard created by Anthropic that lets AI tools connect to external data sources. Think of it as a USB port for AI — any tool that supports MCP can plug into any data source that speaks MCP.

When you run `ctx mcp`, withctx starts an MCP server that exposes your compiled wiki as a set of tools. AI agents can then search the wiki, read pages, look up architecture decisions, and even store learnings — all automatically while they work.

**Without MCP:** You copy-paste context into the AI chat, or maintain a CLAUDE.md file manually.

**With MCP:** The AI reads your wiki directly and looks up whatever it needs on its own.

---

## Configure in Claude Code

Claude Code supports MCP servers natively. Add withctx to your project's Claude Code settings.

### Option 1: Project-level (recommended)

Create or edit `.claude/settings.json` in your project root:

```json
{
  "mcpServers": {
    "withctx": {
      "command": "npx",
      "args": ["-y", "withctx", "mcp"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

Replace `/absolute/path/to/your/project` with the actual path to the directory containing your `ctx.yaml`.

### Option 2: Global (all projects)

Edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "withctx": {
      "command": "npx",
      "args": ["-y", "withctx", "mcp"]
    }
  }
}
```

With the global setup, withctx looks for `ctx.yaml` in the current working directory. This works well if you always open Claude Code from the project root.

### Verify it works

After adding the config, restart Claude Code. You should see "withctx" listed as a connected MCP server. Ask Claude something about your project — it will automatically use the withctx tools to look up context.

---

## Configure in Cursor

Cursor supports MCP through a configuration file in your project.

Create or edit `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "withctx": {
      "command": "npx",
      "args": ["-y", "withctx", "mcp"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

After saving, restart Cursor. The AI assistant will now have access to your project wiki through the withctx tools.

---

## Configure in Windsurf

Windsurf supports MCP through its settings. Open the command palette and search for "MCP" or edit your Windsurf settings:

```json
{
  "mcpServers": {
    "withctx": {
      "command": "npx",
      "args": ["-y", "withctx", "mcp"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

The exact location of the settings file depends on your Windsurf version. Check Windsurf documentation for the MCP configuration path.

---

## Available Tools (All 10)

When an AI agent connects to the withctx MCP server, it gets access to these tools:

### search_context

Search across the compiled wiki. Returns matching pages with content snippets and a relevance score.

```
Agent asks: "How does authentication work in this project?"
Tool call: search_context({ query: "authentication" })
Returns: matching wiki pages about auth
```

### get_page

Read a specific wiki page by its path. Returns the full page content as markdown.

```
Tool call: get_page({ path: "architecture.md" })
Returns: complete architecture page
```

### get_architecture

Shortcut to get the architecture overview. Falls back to `overview.md` if `architecture.md` doesn't exist.

### get_conventions

Returns the project's coding conventions, patterns, and standards.

### get_decisions

Returns architecture decision records (ADRs) — the "why" behind technical choices.

### get_faq

Returns the auto-generated FAQ for the project.

### list_pages

Lists all wiki pages with their paths and titles. Useful for discovering what context is available.

### list_sources

Shows what data sources are configured (Jira, GitHub, Confluence, etc.) and their types.

### get_file_context

Given a file path, returns all relevant wiki context. The agent uses this when editing a file — it automatically looks up related architecture, conventions, and dependencies.

```
Agent is editing: src/middleware/auth.ts
Tool call: get_file_context({ filePath: "src/middleware/auth.ts" })
Returns: auth architecture, JWT decisions, middleware conventions
```

### add_memory

Stores a learning or observation the agent discovers while working. This gets saved to the wiki's manual section so future sessions benefit from it.

```
Agent discovers: "The payments service requires idempotency keys for all POST requests"
Tool call: add_memory({ content: "Payments service requires idempotency keys...", tags: ["payments", "api"] })
```

---

## Examples of What Agents Can Do

### Before writing code

An agent working on a new payment endpoint can look up:
- Architecture conventions (`get_conventions`) to follow the right patterns
- Service dependencies (`get_architecture`) to understand what other services are involved
- Past decisions (`get_decisions`) to avoid re-debating settled topics

### During code review

An agent reviewing a PR can:
- Search for related conventions (`search_context({ query: "error handling patterns" })`)
- Check deployment order (`get_page({ path: "cross-repo/deployment-order.md" })`)
- Look up related test patterns (`get_file_context({ filePath: "src/handlers/payment.ts" })`)

### Learning over time

When an agent discovers something not in the wiki, it can store it:
- Undocumented API behaviors
- Edge cases found during debugging
- Environment-specific configurations

These memories accumulate in the wiki, making every future session smarter.

---

## Troubleshooting

### "withctx" doesn't appear as a connected server

- Make sure `withctx` is installed: `npm install -g withctx`
- Check that `ctx.yaml` exists in the `cwd` path you specified
- Restart your AI tool after changing the configuration
- Run `ctx doctor` to verify your setup

### Agent says "No wiki pages found"

- Run `ctx ingest` first to compile the wiki
- Check that `.ctx/context/` contains markdown files

### Agent responses don't include project context

- Verify the MCP server is connected (check your AI tool's MCP status)
- Try asking a specific question like "What does the architecture look like?" to trigger a tool call
- Run `ctx mcp --list` to verify the tools are working

### Using with a multi-repo context repo

If your wiki lives in a separate context repo (see [Microservices Guide](18-microservices.md)), point the `cwd` to the context repo, not the service repo:

```json
{
  "mcpServers": {
    "withctx": {
      "command": "npx",
      "args": ["-y", "withctx", "mcp"],
      "cwd": "/path/to/acme-context"
    }
  }
}
```
