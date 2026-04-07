# Why withctx

## The Problem

Engineering knowledge is scattered across seven or more tools: Jira tickets, Confluence pages, Teams messages, GitHub PRs, local markdown files, PDFs shared over email, and Word docs buried in SharePoint. No single person holds the full picture. No single tool does either.

This creates three compounding failures:

**Stale documentation.** Teams write docs during a project kickoff and never touch them again. Within weeks, the Confluence pages describe a system that no longer exists. Engineers learn to ignore docs and go ask somebody instead.

**Slow onboarding.** A new engineer joins and spends two to four weeks piecing together how the system works. They read outdated Confluence, grep through repos, chase down tribal knowledge in Slack threads, and still miss critical context about why decisions were made.

**Agents with no context.** AI coding agents (Claude Code, Copilot, Cursor) are powerful but blind. They see the code in front of them but have zero knowledge of your domain, architecture decisions, team conventions, or the Jira epic that explains why the payment service was split into three microservices. They generate plausible code that violates your actual constraints.

### Before withctx

```
Engineer asks: "How does auth work in our system?"

Step 1: Search Confluence → finds 3 pages, all outdated
Step 2: Search Jira → finds AUTH-142 epic with 47 tickets
Step 3: Grep the auth-service repo → finds code but no "why"
Step 4: Search Teams → finds a thread from 6 months ago
Step 5: Ask Sarah → Sarah left the company
Step 6: Guess and ship → bug in production
```

### After withctx

```
$ ctx query "How does auth work in our system?"

Auth uses OAuth 2.0 with PKCE flow (decided in ADR-007, replacing
session cookies due to mobile app requirements). The auth-service
issues JWTs with 15-minute expiry. Refresh tokens are stored in
Redis with 7-day TTL. See: wiki/architecture/auth.md

Sources: AUTH-142 (Jira), ADR-007 (Confluence), auth-service/README.md
```

Or an AI agent reads the compiled context before writing code:

```
$ ctx pack --scope repos/auth-service --output CLAUDE.md
# Agent now knows: OAuth 2.0 + PKCE, JWT structure, Redis refresh
# tokens, rate limiting rules, team conventions for error handling
```

## The Solution

withctx uses Claude to compile knowledge from all your sources into a living wiki of markdown files. It reads your Jira tickets, Confluence pages, Teams threads, GitHub repos, PDFs, Word docs, PowerPoint decks, and Excel sheets. It synthesizes them into clear, organized, cross-referenced wiki pages.

The wiki lives in a `.ctx/context/` directory — either inside your repo or in a dedicated context repo on GitHub. It updates incrementally when you run `ctx sync`. It is plain markdown, readable by humans and agents alike.

```
.ctx/
  context/
    index.md              # Project overview, auto-generated
    architecture/
      overview.md         # System architecture compiled from all sources
      auth.md             # Auth system: decisions, flows, constraints
      data-model.md       # Database schema and relationships
    repos/
      api-service.md      # What this repo does, key patterns, setup
      auth-service.md     # Auth service internals
      web-app.md          # Frontend: stack, routing, state management
    decisions/
      adr-007-oauth.md    # Why OAuth 2.0 replaced session cookies
    onboarding/
      getting-started.md  # Compiled onboarding guide
    log.md                # Change log: what was updated and when
```

Every page cites its sources. Every page gets refreshed when upstream content changes. Engineers read the wiki to onboard. Agents read it before writing code.

## Who It's For

**Engineering teams** who are tired of maintaining docs that go stale. Instead of asking engineers to write and update documentation, withctx compiles it from the tools they already use.

**AI-augmented teams** who want their coding agents to understand the full project context — not just the code, but the decisions, constraints, conventions, and domain knowledge behind it.

**Platform and DevEx teams** who need to provide consistent, up-to-date context across multiple repos and multiple teams.

## Design Principles

**Compile, don't author.** Engineers should not write documentation. They should do their work in Jira, Confluence, GitHub, and Teams. withctx compiles that work into docs automatically.

**Plain markdown.** The wiki is just `.md` files. No database. No proprietary format. Read it on GitHub, in your editor, or pipe it into any tool.

**Source-cited.** Every statement in the wiki traces back to a source: a Jira ticket, a Confluence page, a PR, a Teams message. When you see something wrong, you know where the upstream problem is.

**Incremental.** First ingest reads everything. Subsequent syncs only process what changed. Fast and cost-efficient.

**Agent-native.** The wiki is designed to be consumed by AI agents. `ctx pack` compresses it into a token-budgeted context block that fits in any LLM prompt.

## Inspiration

This approach is inspired by Andrej Karpathy's observation that LLMs work best when given a curated "wiki" of project knowledge rather than raw documents. Instead of stuffing an entire Confluence space into a prompt, you compile it into clean, structured pages that an LLM can reason over effectively. withctx automates that compilation.
