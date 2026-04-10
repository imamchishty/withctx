# 1. Quickstart

Five minutes from zero to a working wiki.

## Install

```bash
npm install -g withctx
export ANTHROPIC_API_KEY=sk-ant-...   # https://console.anthropic.com
```

Requires Node.js 20+.

## Run it

```bash
cd your-project
ctx go
```

`ctx go` does everything: detects sources, creates `ctx.yaml`, ingests your project, compiles a wiki under `.ctx/context/`. Takes ~30 seconds for a small repo, a few minutes for a large one.

## Ask it anything

```bash
ctx query "how does auth work?"
ctx query "what does the payments service do?"
ctx chat                              # conversational mode
```

Answers cite their sources by file and line number.

## What just happened?

```
.ctx/
├── context/          ← compiled wiki (markdown — read it directly)
│   ├── architecture.md
│   ├── api.md
│   ├── onboarding.md
│   └── ...
├── usage.jsonl       ← token usage history
└── sync-index.json   ← hash index for incremental sync
```

You can `cat` the wiki, commit it to git, ship it to your team. No proprietary format.

## What next?

- Add more sources (Jira, Confluence, GitHub, Slack...) → [02-sources.md](02-sources.md)
- See every command → [03-commands.md](03-commands.md)
- New hire onboarding → [04-recipes.md](04-recipes.md)

## Sanity check

```bash
ctx doctor      # verifies setup, credentials, dependencies
ctx status      # wiki health dashboard
ctx costs       # token usage so far
```
