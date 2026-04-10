# 1. Quickstart

Four commands. That's the whole thing.

```bash
npm i -g withctx
export ANTHROPIC_API_KEY=sk-ant-...    # https://console.anthropic.com
ctx setup
ctx chat
```

Requires Node.js 20+.

## What those four commands do

1. **`npm i -g withctx`** — installs the CLI.
2. **`export ANTHROPIC_API_KEY=...`** — gives withctx a Claude key. You can also put it in `ctx.yaml` under `ai.api_key` if you prefer; env wins when both are set.
3. **`ctx setup`** — walks your project, finds code and docs, writes `ctx.yaml`, then compiles a wiki under `.ctx/context/`. Takes ~30 seconds on a small repo.
4. **`ctx chat`** — conversational Q&A backed by the wiki. Answers cite their sources.

> `ctx init` and `ctx go` are aliases for `ctx setup` — they all run the same code. Use whichever feels natural.

## What you got

```
.ctx/
├── context/          ← compiled wiki (plain markdown — cat it, commit it, ship it)
│   ├── overview.md
│   ├── architecture.md
│   ├── conventions.md
│   └── ...
├── usage.jsonl       ← token usage history
└── sync-index.json   ← hash index for incremental sync
ctx.yaml              ← your config — commit this
```

No proprietary format. No database. Just markdown files you can read with `less`.

## Common variations

```bash
ctx setup --name my-project           # override detected project name
ctx setup --with jira,confluence      # also scaffold external connectors
ctx setup --org acme --token ghp_...  # discover all repos in a GitHub org
ctx setup --no-ingest                 # write ctx.yaml only, skip wiki compilation
```

## Ask it anything

```bash
ctx query "how does auth work?"
ctx query "what does the payments service do?"
ctx chat                              # stateful conversation
```

## Sanity check

```bash
ctx doctor      # verifies setup, credentials, dependencies
ctx status      # wiki health dashboard
ctx costs       # token usage so far
```

## What next?

- Add more sources (Jira, Confluence, GitHub, Slack...) → [02-sources.md](02-sources.md)
- See every command → [03-commands.md](03-commands.md)
- Onboarding recipes → [04-recipes.md](04-recipes.md)
- Full `ctx.yaml` reference → [07-config-reference.md](07-config-reference.md)

## Update

```bash
ctx --version                       # check what you have
npm update -g withctx               # update to the latest
```

After an update, run `ctx doctor` once. If a sync index format changed, it will tell you to run `ctx sync --force`.
