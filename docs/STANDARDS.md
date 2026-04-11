# withctx Standards — the bar we hold everything to

This is the permanent reference for what "best in class" means in this
codebase. Every feature, every command, every error message is measured
against the four axes below. If a change doesn't move at least one axis
forward, it's decoration.

> **Scope note for v1.x**
> We ship **markdown only**. No HTML export, no browser UI, no static
> site. The wiki is files you can `less`, `grep`, `git diff` and render
> in any editor. That constraint is a feature — it's what lets the tool
> be trusted, scripted and embedded. Everything below assumes
> markdown-first.

---

## The four axes

### 1. Best information — every claim is trustworthy or visibly isn't

A wiki is worthless the moment someone finds one stale page. We'd
rather show 10 trustworthy pages than 100 half-rotten ones. The rules:

- **Every page carries a freshness header.** When it was last
  refreshed, by whom, against which commit, from how many sources. No
  exceptions.
- **Every factual claim is tiered.** `verified` (came from an executed
  assertion or a live source), `asserted` (extracted from source docs
  but not re-checked), `manual` (human-added note), `historical` (known
  to be dated). Renderers make the tier visible.
- **Contradictions surface instead of being silently picked.** If Jira
  says X and code says Y, `ctx lint` flags it. We never hide
  disagreement.
- **Stale pages decay loudly.** No query hits + no source changes in
  90 days = `ctx status` warns, `ctx lint` suggests pruning.
- **Citations or it didn't happen.** `ctx query` answers cite the
  source page + line range. Pages compiled from external sources link
  back to the originating Jira/Confluence/Notion doc.
- **`ctx verify` is the assertion engine.** Pages can declare
  executable claims (e.g. "file `src/foo.ts` exports `bar`", "route
  `/api/x` returns 200", "env var `FOO` is documented in `.env.example`").
  `ctx verify` re-runs them on every sync and marks failures.

### 2. Best user experience — terminal-first, fast, obvious

The terminal is the only UI. It has to be ruthlessly good.

- **Every read command supports `--json`.** Every write command
  supports `--dry-run`. No exceptions.
- **LLM output streams.** `ctx query`, `ctx chat`, `ctx ask` print
  tokens as they arrive. Nothing that blocks on a full response when
  streaming is available.
- **Every error message includes the fix.** Not "config invalid" but
  "config invalid: `ai.model` is required; add `ai:\n  model:
  claude-sonnet-4-20250514` to ctx.yaml". Users never have to
  guess what to do next.
- **Vocabulary is consistent across every surface.** `source` (not
  "connector" in docs and "source" in code). `refresh` (not "sync"
  some places and "refresh" others). One word, one meaning, everywhere.
- **Shell completions ship with the binary.** `ctx <tab>` works in
  bash, zsh and fish after a single install step.
- **First-run coaching.** After `ctx setup`, the last line of output is
  always "next: `ctx chat` — try asking a question", not a sea of logs.
- **No surprise spend.** Any operation projected to cost > $0.05 prints
  a cost estimate and asks unless `--yes` or env-var-confirmed.
- **Spinners that mean something.** "Asking Claude..." not "Loading...".
  If a phase takes > 2s, users know what's running.

### 3. Best setup — zero-config start, great defaults

Time-to-first-value is the gate. If someone can't get a useful wiki in
under 60 seconds, we've failed.

- **`ctx setup` does everything.** Detects sources, writes `ctx.yaml`,
  compiles the wiki, prints next steps. One command.
- **Demo mode exists.** `ctx setup --demo` bundles a sample project
  so a new user can see the output before paying for their first
  token. Zero API cost.
- **Cost preview before first ingest.** "This will compile ~120 docs
  into ~18 wiki pages, estimated cost $0.34. Continue? [Y/n]". Never
  surprise the user on turn one.
- **Auto-migration between schema versions.** `ctx.yaml` from v1.3
  loads in v1.4 with a one-line notice, not an error.
- **Offline provider auto-detection.** If `ollama serve` is running,
  `ctx setup` offers it as a zero-cost option.
- **Single-binary distribution (stretch).** `curl | sh` install, no
  Node required on the host. npm stays primary; binary is a bonus.
- **Smart defaults over prompts.** If we can detect it, don't ask.
  Only prompt when the detection is ambiguous or the answer is a
  secret.

### 4. Best maintenance — boring to operate, loud when things break

A context wiki that rots silently is worse than no wiki. We over-invest
in operations.

- **CI-refresh is the default for any team.** `ctx publish` sets
  `refreshed_by: ci`, drops a GitHub Action, and local `sync` is
  blocked with a cost-warned bypass (`--allow-local-refresh`).
- **Refresh journal is mandatory.** Every `ctx sync` / `ctx ingest`
  writes one record to `.ctx/usage.jsonl` with actor, trigger, tokens,
  cost, pages changed, duration, success/failure. `ctx history`
  renders it. Forensics always available.
- **Hard budget enforcement.** `costs.budget: 50` means we stop at
  $50, not warn at 80%. "Warn" is available via `alert_at`; the budget
  itself is a wall.
- **Drift detection.** If the underlying repo has moved N commits
  since the last refresh, `ctx status` says so. Wiki never silently
  lags code.
- **Failure webhook.** `maintenance.webhook: https://...` posts to
  Slack/Teams on a failed refresh. Nobody should have to `ctx history
  --failed` to find out CI is broken.
- **Self-healing on transients.** Source fetches retry with backoff.
  One flaky Jira call doesn't kill the whole refresh.
- **CI-grade exit codes.** `ctx status` returns 0/1/2 so a cron job
  can react: 0 = healthy, 1 = stale/warnings, 2 = broken.

---

## The verification loop

Every PR against this repo is checked against this doc. Reviewer asks:

1. **Which axis does this move?** If none, it's decoration. Reject.
2. **Does any existing axis regress?** If yes, justify explicitly.
3. **Does the commit message say which axis?** Info / UX / Setup /
   Maintenance. Makes the roadmap self-auditing.

---

## Active roadmap — ordered by leverage

This is the sequenced list of outstanding standards work. Items move
from here into `CHANGELOG.md` as they ship.

### Info axis
- [ ] `ctx verify` — executable assertions in wiki pages
- [ ] Freshness header on every page (date, commit, source count, actor)
- [ ] Claim tiers (verified / asserted / manual / historical) in renderer
- [ ] `ctx lint --require-citations` flag
- [ ] Stale page decay (no hits + no source changes in 90d → warn)
- [ ] Contradiction surfacing in `ctx lint`

### UX axis
- [ ] Streaming LLM output in `query`, `chat`, `ask`
- [ ] `--json` audit — every read command
- [ ] `--dry-run` audit — every write command
- [ ] Error message audit — every error includes the fix
- [ ] Vocabulary sweep — pick `source` / `refresh` canonically
- [ ] Shell completions (bash / zsh / fish)
- [ ] First-run coaching line after `ctx setup`

### Setup axis
- [ ] `ctx setup --demo` bundled sample project
- [ ] Cost preview before first ingest
- [ ] Schema auto-migration between minor versions
- [ ] Offline provider auto-detection (ollama)
- [ ] Smart-defaults audit — prompt only on ambiguity

### Maintenance axis
- [ ] Hard budget enforcement (stop at budget, not just warn)
- [ ] Drift detection in `ctx status` (commits since last refresh)
- [ ] Failure webhook (`maintenance.webhook`)
- [ ] Self-healing retries on transient source failures
- [ ] CI-grade exit codes from `ctx status`

### Cross-cutting retention (post-standards)
- [ ] `ctx suggest <file>` — surface relevant wiki pages for a path
- [ ] `ctx bot` — GitHub Action that posts wiki pages as PR comments
- [ ] `ctx gap` — query-miss analytics

---

## What this doc is not

- Not a feature list. Features come and go. The axes are permanent.
- Not a release plan. See `CHANGELOG.md` for shipped work.
- Not negotiable. Individual items on the roadmap are; the four axes
  aren't. A PR that introduces untrusted output is rejected even if
  it's shiny.

---

*Last revised: 2026-04-10.*
