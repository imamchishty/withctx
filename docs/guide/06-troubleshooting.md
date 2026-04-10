# 6. Troubleshooting

Common errors and the fix.

First step is always:

```bash
ctx doctor
```

It checks credentials, dependencies, wiki state, and last sync age. Fixes the obvious 80%.

---

## Install / setup

**`command not found: ctx`**
Global npm install didn't get on your `PATH`. Run `npm config get prefix` and add `<prefix>/bin` to PATH.

**`Node.js 20+ required`**
`brew install node@20`, then `brew link --overwrite node@20`. Or use `nvm install 20`.

**`ANTHROPIC_API_KEY not set`**
Get one at console.anthropic.com, then `export ANTHROPIC_API_KEY=sk-ant-...`. Persist it in `~/.zshrc` or your project's `.env`.

---

## Sources

**`Jira: 401 Unauthorized`**
Use a token, not your password. Generate at https://id.atlassian.com/manage-profile/security/api-tokens. The email must match the Atlassian account that owns the token.

**`Confluence: 404`**
`CONFLUENCE_BASE_URL` must include `/wiki` — e.g. `https://yourco.atlassian.net/wiki`.

**`GitHub: rate limited`**
Make sure `GITHUB_TOKEN` is set (not just relying on anonymous limits). `repo` + `read:org` scopes.

**`Slack: missing_scope`**
Add `channels:history` and `channels:read` to the bot token. Re-install the app to your workspace.

**`Notion: object_not_found`**
You haven't shared the database with the integration. Notion → database → ⋯ → Connections → add your integration.

---

## Wiki / runtime

**`Wiki has no pages but ingest succeeded`**
Almost always: your sources matched zero documents. Check `ctx.yaml`'s JQL/CQL/file globs. Run `ctx ingest --verbose` to see what each connector returned.

**`Pages keep getting rebuilt even though nothing changed`**
You're running `ctx ingest` instead of `ctx sync`. `ingest` is a full rebuild; `sync` is incremental and uses a hash index.

**`Cost is way higher than expected`**
Run `ctx costs` — the per-operation breakdown will show which command is eating budget. Likely culprits:
- Running `ingest` instead of `sync`
- `query` without vector retrieval (older configs) — set `query.retrieval: vector` in `ctx.yaml`
- Disabled prompt caching (check `ctx.yaml` `costs.cache_prompts: true`)

**`tsc / build errors after update`**
`rm -rf node_modules .ctx/sync-index.json && npm install -g withctx@latest`.

---

## Editor / agent

**`MCP server connects but tools don't appear`**
Restart the editor entirely. Some hosts don't pick up MCP changes without a full restart. If still missing, run `ctx mcp` standalone — it should print the tool list at startup.

**`Claude Code says it can't read .ctx/`**
You're in a different working directory than where you ran `ctx go`. `.ctx/` is project-local. Either run from the project root, or `ctx serve` and have the agent hit the HTTP API.

---

## Cost

**`Budget alert at 80%`**
You set a budget in `ctx.yaml` (`costs.budget`). Either raise it or:
- Switch heavy commands to `--model claude-haiku-3.5`
- Set `costs.cache_prompts: true`
- Run `sync` not `ingest`

**`Where is the usage data stored?`**
`.ctx/usage.jsonl` — append-only JSONL, one record per call. Greppable, tail-able, easy to back up. `ctx costs` reads it.

---

## Still stuck?

```bash
ctx doctor --verbose
ctx config              # prints resolved config
```

Open an issue with the doctor output: https://github.com/imamchishty/withctx/issues
