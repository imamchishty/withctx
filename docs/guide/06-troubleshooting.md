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

## Corporate network / on-prem

**`self-signed certificate in certificate chain` or `unable to verify the first certificate`**
Your company's HTTPS traffic goes through a TLS-intercepting proxy or uses an internal CA that Node.js doesn't trust by default.

Fix — point Node at your corporate CA bundle:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem
```

Don't have the `.pem`? Ask your IT team, or extract it yourself:

```bash
openssl s_client -connect jira.corp.com:443 -showcerts </dev/null 2>/dev/null \
  | openssl x509 -outform PEM > corp-ca.pem
```

Persist the export in `~/.zshrc` (or your shell's equivalent) so every terminal picks it up.

**`ETIMEDOUT` / `ECONNREFUSED` when connecting to sources behind a proxy**
withctx can't reach the upstream service because outbound traffic must go through a corporate proxy.

Fix — set the standard proxy env vars:

```bash
export HTTPS_PROXY=http://proxy.corp.com:8080
export NO_PROXY=.corp.example.com,localhost
```

withctx installs undici's `EnvHttpProxyAgent` at startup, so once these vars are set all connectors (Jira, Confluence, GitHub, etc.) route through the proxy automatically.

**`NODE_TLS_REJECT_UNAUTHORIZED=0` (last-resort debug escape hatch)**
If you're still blocked and need to confirm the issue is TLS-related, you can temporarily disable certificate verification:

```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
ctx sync          # does it work now?
```

**Do not leave this on in production.** It disables all certificate checks and makes connections vulnerable to MITM attacks. `ctx doctor` will flag this with a warning if it detects the variable is set. Once you've confirmed TLS is the root cause, switch to the `NODE_EXTRA_CA_CERTS` approach above.

**Verify your network setup**

```bash
ctx doctor    # Network section shows CA bundle, proxy, TLS status
ctx llm       # Confirm LLM is reachable through the proxy
```

If `ctx doctor` shows green for network but a specific connector still fails, the issue is usually source-specific auth — check the Sources section above.

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
You're in a different working directory than where you ran `ctx setup`. `.ctx/` is project-local. Either run from the project root, or `ctx serve` and have the agent hit the HTTP API.

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
