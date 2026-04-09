# Markdown Intelligence

When withctx ingests markdown files from your repos, it does not treat them as raw text blobs. It auto-classifies each file by type, splits it into sections, resolves cross-references between files, and builds a doc tree hierarchy. The result is structured input that Claude can reason over effectively — not a wall of unprocessed text.

## What It Does

For every markdown file, withctx:

1. **Parses frontmatter** — extracts title, tags, author, date, status, and custom fields from YAML frontmatter
2. **Detects the doc type** — classifies the file into one of 15 categories based on filename patterns and content heuristics
3. **Splits into sections** — breaks the document at `##` headings so each section can be indexed and referenced independently
4. **Resolves cross-references** — finds all relative markdown links and maps them to actual file paths in the repo
5. **Builds a doc tree** — uses README files as directory indices to create a navigable hierarchy

This runs automatically during `ctx ingest` and `ctx sync`. No configuration needed.

## Doc Types

withctx classifies every markdown file into one of 15 types. Classification uses filename patterns first, then falls back to content heuristics. Here are the types with example filenames that trigger each:

| Doc Type | Example Filenames | What It Captures |
|----------|-------------------|------------------|
| **architecture** | `adr-001-auth-flow.md`, `system-design.md`, `design-cache-layer.md` | Architecture decision records, system design docs |
| **deployment** | `runbook-prod.md`, `deploy.md`, `infra-setup.md`, `ci-cd-pipeline.md` | Deployment procedures, runbooks, infrastructure docs |
| **api** | `api.md`, `endpoints.md`, `routes.md`, `swagger-notes.md`, `openapi-guide.md` | API documentation, endpoint references |
| **database** | `schema.md`, `migrations.md`, `db-setup.md`, `erd-overview.md` | Database schemas, migration guides, data models |
| **onboarding** | `getting-started.md`, `new-hire.md`, `setup.md`, `onboarding-guide.md` | Onboarding guides, setup instructions |
| **persona** | `personas.md`, `customer-journey.md`, `user-types.md` | User personas, customer journeys |
| **repo-structure** | `structure.md`, `monorepo.md`, `project-layout.md` | Project layout, directory structure docs |
| **testing** | `test-strategy.md`, `qa-plan.md`, `coverage-report.md` | Test strategies, QA plans, coverage docs |
| **security** | `auth.md`, `compliance.md`, `hipaa.md`, `gdpr-checklist.md`, `security-policy.md` | Security policies, auth docs, compliance guides |
| **incident** | `postmortem-2024-01.md`, `rca-payment-outage.md`, `incident-db-failover.md`, `outage-2024-03.md` | Post-mortems, root cause analyses, incident reports |
| **dependencies** | `third-party.md`, `licensing.md`, `vendor-list.md`, `dependencies-audit.md` | Third-party dependencies, licensing info |
| **feature-flags** | `flags.md`, `toggles.md`, `feature-flag-guide.md`, `config-flags.md` | Feature flag documentation, toggle configs |
| **roadmap** | `rfc-001.md`, `proposal-dark-mode.md`, `roadmap.md`, `plan-q4.md` | RFCs, proposals, roadmap documents |
| **changelog** | `changelog.md`, `release-notes.md`, `history.md` | Release notes, changelogs |
| **general** | anything that does not match the above | Fallback for unclassified docs |

### How Detection Works

Filename patterns are checked first. The filename `adr-001-auth-flow.md` matches the `architecture` pattern (`/^adr-/i`), so it is classified as architecture regardless of content.

If no filename pattern matches, content heuristics kick in. A file named `decisions.md` that contains phrases like "architecture decision record" or "system design" will be classified as architecture based on its content.

If nothing matches, the file is classified as `general`.

## Frontmatter

withctx parses YAML frontmatter between `---` delimiters at the top of any markdown file:

```yaml
---
title: Authentication Architecture
tags: [auth, security, oauth]
author: Sarah Chen
date: 2024-01-15
status: approved
---
```

### Supported Fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Page title (overrides the first heading) |
| `tags` | array | Tags for categorization — supports `[a, b, c]` or comma-separated |
| `author` | string | Document author |
| `date` | string | Creation or last-updated date |
| `status` | string | Document status (draft, approved, deprecated, etc.) |
| `category` | string | Custom category |

Any field not in the list above is stored in a `custom` map and available during wiki compilation. This means you can add your own fields (`team`, `service`, `priority`) and they will be preserved.

### Title Resolution

withctx resolves the page title in this order:

1. Frontmatter `title` field (highest priority)
2. First `# Heading` in the document body
3. Filename without extension (fallback)

## Sectioning

withctx splits every markdown document into sections based on `##` (H2) headings. Each section becomes an independently addressable unit with a heading, content, and line range.

### Example

Given this document:

```markdown
# Auth Service

Overview of the auth service.

## OAuth 2.0 Flow

The service uses PKCE flow for mobile clients...

## Token Lifecycle

JWTs expire after 15 minutes. Refresh tokens...

## Rate Limiting

API rate limits are enforced per-client...
```

withctx produces four sections:

1. **Preamble** (lines 1-3) — content before the first `##`
2. **OAuth 2.0 Flow** (lines 5-7) — first H2 section
3. **Token Lifecycle** (lines 9-11) — second H2 section
4. **Rate Limiting** (lines 13-15) — third H2 section

H3 headings and below stay inside their parent H2 section. If the document has no H2 headings at all, the entire content is treated as a single section.

This sectioning allows the wiki compiler to reference specific parts of a document rather than pulling in the entire file.

## Cross-Reference Resolution

withctx finds all relative markdown links in a document and resolves them to actual file paths:

```markdown
See [Auth Architecture](../architecture/auth.md) for details.
Check the [API routes](./routes.md#endpoints) for available endpoints.
```

The link `../architecture/auth.md` is resolved relative to the current file's directory. Absolute URLs (`https://...`), mailto links, and anchor-only links (`#section`) are ignored.

When the wiki is compiled, these resolved references create connections between pages. Claude can follow these connections to understand how documents relate to each other.

### Cross-Repo References

In multi-repo setups, withctx also resolves links that point to files in other repos. If `api-service/docs/auth.md` links to `../auth-service/README.md`, and both repos are configured in `ctx.yaml`, the reference is resolved across repo boundaries.

## Doc Tree Hierarchy

withctx builds a parent-child tree from your markdown files using README files as directory indices:

```
docs/
  README.md              <- root node
  architecture/
    README.md            <- child of docs/README.md, parent of files below
    auth.md              <- child of architecture/README.md
    data-model.md        <- child of architecture/README.md
  onboarding/
    getting-started.md   <- child of docs/README.md (no onboarding/README.md)
    local-dev.md         <- child of docs/README.md
```

### Rules

- A `README.md` in a directory is the index node for that directory
- Non-README files in a directory are children of that directory's README
- If no README exists in the directory, files walk up to find the nearest parent README
- Top-level files without a parent become root nodes

This hierarchy tells the wiki compiler how your documentation is organized, so it can generate a navigable structure in the compiled wiki rather than a flat list of pages.

## How This Improves Wiki Quality

Without markdown intelligence, withctx would feed Claude a flat dump of file contents. Claude would have to guess which files are architecture docs vs. changelogs, parse out sections manually, and have no understanding of how documents relate.

With markdown intelligence:

- **Structured classification** means architecture pages are grouped with architecture pages, not mixed in with release notes
- **Sectioning** means Claude can reference "the Rate Limiting section of auth.md" rather than quoting the entire file
- **Cross-references** mean Claude understands that `auth.md` links to `data-model.md` and can synthesize information across both
- **The doc tree** means the compiled wiki mirrors your actual documentation structure, making it navigable for both humans and agents
- **Frontmatter metadata** means Claude knows document status (draft vs. approved), authorship, and tags — so it can prioritize authoritative sources over drafts
