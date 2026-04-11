/**
 * Demo mode (`ctx setup --demo`) — the retention-axis killer feature.
 *
 * A new user who wants to see what withctx *produces* before paying a
 * single Anthropic token can run:
 *
 *     ctx setup --demo
 *
 * and immediately get:
 *   - A sample `ctx.yaml` describing an imaginary multi-repo platform
 *   - A pre-built `.ctx/context/` wiki with overview, architecture,
 *     conventions and decisions pages
 *   - A pre-populated refresh journal so `ctx status` and `ctx history`
 *     show realistic output from the first run
 *
 * Zero LLM calls. Pure markdown. Purpose: let users kick the tyres
 * with their own `ctx chat` / `ctx query` (which DO call the LLM) and
 * see how the product feels end-to-end before betting on it.
 *
 * The sample is authored here rather than shipped as a separate
 * `samples/` directory so it's always in sync with the current schema
 * and never gets left out of the npm package.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { CtxDirectory } from "../storage/ctx-dir.js";
import { PageManager } from "../wiki/pages.js";
import { recordRefresh } from "../usage/recorder.js";
import type { CtxConfig } from "../types/config.js";

// ── Sample project description ────────────────────────────────────────
// Values chosen to feel real but obviously fictional — a "platform"
// with three services. Enough surface area for the wiki to have
// something interesting to show, small enough not to bore.

const DEMO_PROJECT_NAME = "acme-platform-demo";

const DEMO_CONFIG: CtxConfig = {
  project: DEMO_PROJECT_NAME,
  version: "1.4",
  repos: [
    { name: "api", github: "acme/api", branch: "main" },
    { name: "web", github: "acme/web", branch: "main" },
    { name: "worker", github: "acme/worker", branch: "main" },
  ],
  ai: {
    provider: "anthropic",
    api_key: "${ANTHROPIC_API_KEY}",
  },
  sources: {
    local: [
      { name: "docs", path: "./docs" },
      { name: "api", path: "./api" },
    ],
  },
  costs: {
    budget: 10,
    alert_at: 80,
    model: "claude-sonnet-4-20250514",
  },
} as CtxConfig;

// ── Sample wiki pages ─────────────────────────────────────────────────
//
// Written by hand so the demo shows off the tier/freshness front-matter
// that `ctx verify` and `ctx status` key off. Every page carries a
// plausible `ctx` block.

interface DemoPage {
  path: string;
  title: string;
  tier: "verified" | "asserted" | "manual";
  sources: number;
  body: string;
}

const DEMO_PAGES: DemoPage[] = [
  {
    path: "overview.md",
    title: "Platform Overview",
    tier: "asserted",
    sources: 12,
    body: `# Platform Overview

**acme-platform** is the demo project that ships with \`ctx setup --demo\`.
It imagines a three-service SaaS (api, web, worker) so the wiki has
something interesting to render.

## Services

| Service | Language    | Owner        | Docs                         |
|---------|-------------|--------------|------------------------------|
| api     | TypeScript  | @platform    | [api](./repos/api/overview.md) |
| web     | TypeScript  | @frontend    | [web](./repos/web/overview.md) |
| worker  | Go          | @platform    | [worker](./repos/worker/overview.md) |

## Entry points

- **Customer-facing:** \`acme.com\` → web → api
- **Internal:** \`admin.acme.com\` → web (admin bundle) → api
- **Async jobs:** worker pulls from Redis streams populated by api

## What to try

\`\`\`bash
ctx query "how does auth work?"
ctx chat
ctx status
\`\`\`

These all run against THIS wiki — no real project needed.

---

_This is a demo project. Run \`ctx setup\` in a real repo when you're
ready to compile your own wiki._
`,
  },
  {
    path: "architecture.md",
    title: "Architecture",
    tier: "asserted",
    sources: 8,
    body: `# Architecture

\`\`\`
      ┌─────────┐     ┌─────────┐     ┌─────────┐
      │   web   │────▶│   api   │────▶│  worker │
      └─────────┘     └────┬────┘     └────┬────┘
                           │               │
                           ▼               ▼
                      ┌─────────┐     ┌─────────┐
                      │ postgres│     │  redis  │
                      └─────────┘     └─────────┘
\`\`\`

## Principles

1. **One database per service.** No cross-service foreign keys.
2. **Async by default.** Anything > 100ms is pushed to worker via Redis streams.
3. **Contracts, not conventions.** Every inter-service call goes through
   a typed OpenAPI contract checked in CI.

## Data flow: "user signs up"

1. \`web\` POSTs to \`api /auth/signup\`
2. \`api\` creates a row in \`users\`, emits \`user.created\` on \`redis streams\`
3. \`worker\` consumes, sends welcome email, writes audit log
4. \`api\` returns 201 + JWT to \`web\`

The audit write is async and idempotent — if \`worker\` crashes mid-send
the email retries but the user row is already committed.

## Decision log links

- [Why Redis streams over RabbitMQ](./decisions.md#streams-over-rabbit)
- [Why JWT over sessions](./decisions.md#jwt-over-sessions)
`,
  },
  {
    path: "conventions.md",
    title: "Conventions",
    tier: "manual",
    sources: 3,
    body: `# Conventions

## Branches

- \`main\` → production
- \`staging\` → staging (auto-deploys on merge)
- Feature branches: \`feat/<ticket>-<slug>\`
- Hotfixes: \`hotfix/<slug>\` — allowed to skip staging

## Commit messages

We follow Conventional Commits. Types in use: \`feat\`, \`fix\`, \`refactor\`,
\`docs\`, \`test\`, \`chore\`, \`perf\`. Scope is the service name:

\`\`\`
feat(api): add /auth/refresh endpoint
fix(web): handle 401 on stale JWT
\`\`\`

## PR review

- Two approvals required for \`api\` and \`worker\`.
- One approval for \`web\` (Storybook screenshots preferred over English).
- \`ctx review <pr-url>\` runs the wiki-aware AI pre-review — the human
  reviewer sees its notes alongside their own.

## Code style

- \`prettier\` + \`eslint\` for TS, \`gofmt\` + \`golangci-lint\` for Go.
- No custom lint rules beyond the shared configs.
- Tests live next to source (\`foo.ts\` + \`foo.test.ts\`).
`,
  },
  {
    path: "decisions.md",
    title: "Architecture Decision Records",
    tier: "asserted",
    sources: 5,
    body: `# Architecture Decision Records

Short-form ADRs. One heading per decision.

## streams-over-rabbit

**Decision:** Use Redis streams for internal pub/sub, not RabbitMQ.

**Context:** We already run Redis for caching. RabbitMQ would be a new
operational surface.

**Consequences:** Streams have weaker delivery semantics than AMQP. We
accept this for a 30% drop in ops surface. If we need exactly-once
later, we'll revisit.

## jwt-over-sessions

**Decision:** JWT in an httpOnly cookie, no server-side session store.

**Context:** We want \`api\` to be stateless so worker can validate
tokens without a DB round-trip. Session store would be a second hop.

**Consequences:** Token revocation is harder. We mitigate with short
(15 min) expiry + a rotating refresh token in \`auth_refresh_tokens\`.

## sonnet-for-ingest

**Decision:** Use Claude Sonnet 4 for \`ctx ingest\` runs. Use Haiku for
\`ctx query\` / \`ctx chat\` interactive answers.

**Context:** Ingest is a long, one-shot compile — quality matters more
than latency. Interactive answers are the opposite.

**Consequences:** Monthly spend is ~40% lower than running everything
on Sonnet. See \`ctx costs\` for actual numbers.
`,
  },
  {
    path: "index.md",
    title: "Wiki Index",
    tier: "asserted",
    sources: 0,
    body: `# Wiki Index

Demo wiki — compiled without any real LLM calls.

## Pages

- [overview](./overview.md) — what the platform is
- [architecture](./architecture.md) — services, data flow, diagrams
- [conventions](./conventions.md) — branches, commits, review rules
- [decisions](./decisions.md) — ADRs

## Try it

\`\`\`bash
ctx status        # see wiki health
ctx chat          # interactive Q&A (uses real LLM if key is set)
ctx query "how does auth work?"
ctx history       # who refreshed when
\`\`\`

---

_Demo mode. Run \`ctx setup\` in a real repo for your own wiki._
`,
  },
];

function formatFrontmatter(page: DemoPage, refreshedAt: string): string {
  const fm = {
    ctx: {
      refreshed_at: refreshedAt,
      refreshed_by: "demo@withctx",
      sources: page.sources,
      tier: page.tier,
      model: "demo",
    },
  };
  return `---\n${yamlStringify(fm, { indent: 2 }).trimEnd()}\n---\n\n`;
}

export interface DemoScaffoldResult {
  configPath: string;
  ctxPath: string;
  pageCount: number;
  projectName: string;
}

/**
 * Scaffold a complete demo project — ctx.yaml, .ctx/ directory, wiki
 * pages with freshness headers, and a refresh-journal entry so
 * `ctx status` / `ctx history` show realistic output.
 *
 * Idempotent: refuses to overwrite an existing ctx.yaml. Callers
 * should check first and print a friendlier error than the bare throw.
 */
export function scaffoldDemo(rootDir: string): DemoScaffoldResult {
  const configPath = join(rootDir, "ctx.yaml");
  if (existsSync(configPath)) {
    throw new Error(
      `ctx.yaml already exists at ${configPath}. Remove it first, or run 'ctx setup --demo' in an empty directory.`
    );
  }

  mkdirSync(rootDir, { recursive: true });
  writeFileSync(
    configPath,
    "# withctx demo project — compiled by `ctx setup --demo`.\n" +
      "# Zero API cost. Read the pages, run `ctx chat`, then run\n" +
      "# `ctx setup` in a real repo when you're ready.\n" +
      yamlStringify(DEMO_CONFIG, { lineWidth: 120 })
  );

  const ctxDir = new CtxDirectory(rootDir);
  ctxDir.initialize();
  const pageManager = new PageManager(ctxDir);

  const refreshedAt = new Date().toISOString();

  for (const page of DEMO_PAGES) {
    const withFrontmatter = formatFrontmatter(page, refreshedAt) + page.body;
    // skipStamp: we're providing the front-matter ourselves so the
    // tier + sources counts stay exactly as authored. If we let the
    // auto-stamper run it would override refreshed_at with "now"
    // (same thing, but we're being explicit).
    pageManager.write(page.path, withFrontmatter, { skipStamp: true });
  }

  // Seed the refresh journal so `ctx history` and `ctx status` have
  // something non-empty to render on the demo's first run.
  try {
    recordRefresh(ctxDir, {
      actor: "demo@withctx",
      trigger: "setup",
      forced: false,
      model: "demo",
      tokens: { input: 0, output: 0 },
      cost: 0,
      pages: { added: DEMO_PAGES.length, changed: 0, removed: 0 },
      duration_ms: 0,
      success: true,
      error: null,
    });
  } catch {
    // best effort
  }

  return {
    configPath,
    ctxPath: ctxDir.path,
    pageCount: DEMO_PAGES.length,
    projectName: DEMO_PROJECT_NAME,
  };
}
