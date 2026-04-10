# 3. Commands

Every command, one line each. Run `ctx help` for the same view in your terminal.

## Getting started

| Command | Does |
|---|---|
| `ctx setup` | Detect sources (and sibling git repos if the current dir isn't itself a repo), write `ctx.yaml`, compile the wiki. **The only setup command.** |
| `ctx setup --no-ingest` | Write `ctx.yaml` only — useful when you want to edit it before the first compile. |
| `ctx setup --with jira,confluence` | Also scaffold external connectors. |
| `ctx setup --org acme --token ghp_...` | Discover every repo in a GitHub org via the GitHub API. |
| `ctx setup --scan` | Force sibling-repo scan even if the current folder is a git repo. |
| `ctx setup --no-scan` | Never scan siblings (useful in CI). |
| `ctx setup -y` | Skip all prompts (assume yes to everything). |
| `ctx add <source>` | Interactively add a source (jira, github, slack, …). |

> `ctx init` and `ctx go` are aliases for `ctx setup` — all three names run the same code. Use whichever your muscle memory prefers.

| Then | Does |
|---|---|
| `ctx ingest` | Compile the wiki (run this if you used `--no-ingest`). |
| `ctx todos` | Scan code for TODO/FIXME markers. `--write` saves them to the wiki. |

## Daily use

| Command | Does |
|---|---|
| `ctx query "..."` | Ask the wiki anything. Cites sources by line. |
| `ctx query "..." --continue` | Follow-up on the last query (history kept). |
| `ctx chat` | Interactive Q&A loop. |
| `ctx sync` | Incremental update — only re-compiles changed docs. |
| `ctx sync --force` | Full rebuild. |
| `ctx watch` | Re-ingest on file changes. |
| `ctx status` | Wiki health dashboard (freshness, coverage, gaps). |

## For new team members

| Command | Does |
|---|---|
| `ctx onboard` | Generates a personalised onboarding guide. `--role frontend` for role-specific. |
| `ctx glossary` | Auto-extracts acronyms and internal terms from your wiki. |
| `ctx who <topic>` | "Who owns the payments service?" — ownership map. |

## Code intelligence

| Command | Does |
|---|---|
| `ctx explain <file>` | What does this file/function do, in plain English. |
| `ctx review <pr-url>` | Review a GitHub PR or local diff against wiki conventions. |
| `ctx impact "<change>"` | "What breaks if I rename this column?" |
| `ctx changelog --since v1.0` | Generate a changelog from git history. |

## Exports & integrations

| Command | Does |
|---|---|
| `ctx export rag` | Dump wiki as RAG-ready chunks (JSONL + embeddings). |
| `ctx pack` | Single-file bundle for sharing or upload. |
| `ctx mcp` | Run as a Model Context Protocol server (Cursor / Claude Code). |
| `ctx serve` | HTTP API for the wiki. |

## Admin

| Command | Does |
|---|---|
| `ctx doctor` | Verify setup, creds, dependencies. Run this when stuck. |
| `ctx costs` | Token usage history, per-op breakdown, daily sparkline, wiki growth. |
| `ctx config` | Print resolved config. |
| `ctx reset` | Wipe `.ctx/` and start over. |

## Global flags

- `--verbose` / `-v` — show every step
- `--quiet` / `-q` — only errors
- `--yes` / `-y` — skip confirmations
- `--json` — machine-readable output (most read commands)
