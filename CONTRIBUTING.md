# Contributing to withctx

Thanks for your interest in contributing! withctx is an open-source tool that compiles project knowledge into a maintained wiki for engineers and AI agents.

## Quick Start

```bash
git clone https://github.com/imamchishty/withctx.git
cd withctx
npm install
npm run build
npm link  # makes "ctx" available globally
```

## How to Contribute

### 1. Fork & Branch

```bash
# Fork on GitHub, then:
git clone https://github.com/YOUR_USERNAME/withctx.git
cd withctx
git checkout -b feature/your-feature-name
```

### 2. Make Changes

- Write TypeScript (strict mode, ESM with `.js` extensions in imports)
- Follow existing code patterns
- Add a BDD scenario in `features/` for new features
- Test locally with `npm run build`

### 3. Submit PR

```bash
git add .
git commit -m "feat: description of your change"
git push origin feature/your-feature-name
# Open PR on GitHub
```

## Adding a New Connector

This is the easiest way to contribute. Every connector follows the same interface:

```typescript
// src/connectors/your-connector.ts
import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";

export class YourConnector implements SourceConnector {
  readonly type = "your-type" as const;
  readonly name: string;
  private status: SourceStatus;

  constructor(name: string, /* your config */) {
    this.name = name;
    this.status = { name, type: "your-type", status: "disconnected" };
  }

  async validate(): Promise<boolean> {
    // Check credentials, connectivity
    // Set this.status.status = "connected" or "error"
    return true;
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";

    // Yield documents one at a time
    yield {
      id: `your-type:${this.name}:doc-id`,
      sourceType: "your-type",
      sourceName: this.name,
      title: "Document Title",
      content: "Document content...",
      contentType: "text",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };

    this.status.status = "connected";
    this.status.lastSyncAt = new Date().toISOString();
  }

  getStatus(): SourceStatus {
    return { ...this.status };
  }
}
```

Then:
1. Add config schema in `src/types/config.ts`
2. Register in `src/connectors/registry.ts`
3. Add BDD scenarios in `features/source-connectors.feature`
4. Update `docs/guide/05-sources.md`

**Connectors we'd love to see:**
- Slack
- Notion
- Google Docs / Drive
- Linear
- Discord
- Basecamp
- Email (IMAP/Outlook)
- Figma (design context)

## Adding a Lint Rule

```typescript
// src/lint/rules/your-rule.ts
import type { WikiPage, LintIssue } from "../../types/page.js";

export async function checkYourRule(pages: WikiPage[]): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  // Your detection logic
  return issues;
}
```

Register it in `src/lint/linter.ts`.

## Adding an Export Format

```typescript
// src/export/your-format.ts
import type { WikiPage } from "../types/page.js";
import type { ExportResult } from "../types/page.js";

export function exportYourFormat(pages: WikiPage[], options?: { budget?: number }): ExportResult {
  // Format pages into your output
  return { content: "...", format: "your-format", pageCount: pages.length };
}
```

**Formats we'd love to see:**
- Cursor rules (`.cursorrules`)
- Windsurf rules
- Copilot instructions
- JSON structured output
- HTML (for web viewing)

## Project Structure

```
src/
├── cli/commands/    # CLI commands (Commander.js)
├── claude/          # Claude CLI wrapper + prompts
├── connectors/      # Source connectors (plugin pattern)
├── wiki/            # Wiki compiler, pages, index, templates
├── lint/            # Lint rules engine
├── export/          # Export formatters
├── costs/           # Token/cost tracking
├── storage/         # .ctx/ directory management
├── server/          # Fastify REST API
├── config/          # ctx.yaml loader
└── types/           # TypeScript type definitions
```

## Code Style

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **ESM imports** — use `.js` extensions (`import { Foo } from "./foo.js"`)
- **Async generators** — connectors use `async *fetch()` pattern
- **Chalk for colors** — terminal output uses chalk
- **Ora for spinners** — long operations show progress
- **No classes where functions suffice** — but classes for stateful things (connectors, managers)

## BDD Features

All features are defined in `features/*.feature` using Gherkin syntax. When adding a new feature:

1. Add scenarios to existing feature file, or create a new one
2. Tag with `@your-feature`
3. Describe user-facing behavior, not implementation

## Questions?

Open an issue on GitHub or start a discussion. We're happy to help!
