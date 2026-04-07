# Manual Context

Not everything lives in Jira, Confluence, or GitHub. Team conventions, verbal decisions, corrections to outdated docs, and tribal knowledge often exist only in people's heads. `ctx add` captures this knowledge and feeds it into the wiki.

## Quick Notes

Add a short piece of context:

```bash
ctx add "Redis cache TTL is 5 minutes for user sessions, 1 hour for product catalog"
```

```
 Added context note
 Will be incorporated into wiki on next sync
```

The note is stored in `.ctx/context/_manual/` and merged into the appropriate wiki page on the next `ctx sync` or `ctx ingest`.

## Typed Notes

Use `--type` to categorize what you are adding. This helps Claude place it correctly in the wiki.

### Decisions

Technical decisions that were made but not recorded anywhere:

```bash
ctx add --type decision "We chose Postgres over DynamoDB because we need ACID transactions for payment processing"
```

```bash
ctx add --type decision "API versioning uses URL path (/v1/, /v2/) not headers — decided in sprint planning 2024-11-04"
```

Decisions get compiled into `decisions/` wiki pages or added to relevant architecture pages.

### Conventions

Team rules and patterns that everyone should follow:

```bash
ctx add --type convention "All HTTP handlers must validate input with Zod schemas before processing"
```

```bash
ctx add --type convention "Error messages must not expose internal details — use error codes and let the client map to user-facing text"
```

```bash
ctx add --type convention "Database migrations must be backward-compatible — no dropping columns in the same release as code changes"
```

Conventions get compiled into `conventions/` wiki pages. Agents read these before writing code.

### Context

Background information that helps understand the project:

```bash
ctx add --type context "The payments team is in UTC+5 (Karachi). Async code reviews preferred. PRs reviewed within 24 hours."
```

```bash
ctx add --type context "We have a hard dependency on Stripe API v2023-10-16. Do not upgrade without coordinating with the payments team."
```

Context notes get woven into relevant wiki pages wherever they are most useful.

### Corrections

The most powerful type. Corrections override stale or incorrect content from other sources:

```bash
ctx add --type correction "The Confluence auth doc says we use session cookies — that is outdated. We migrated to JWT in Q3 2024 (ACME-142)."
```

```bash
ctx add --type correction "The README says to use npm — the team switched to pnpm in December 2024."
```

When Claude compiles the wiki, corrections take priority over other sources. The corrected information replaces the stale content, and the correction is noted in the page:

```markdown
## Authentication

The platform uses JWT-based authentication with OAuth 2.0 PKCE flow.
[Correction: migrated from session cookies in Q3 2024, per ACME-142.
The Confluence auth doc is outdated on this point.]
```

## Adding from Files

When you have a longer piece of context in a file:

```bash
ctx add --file ./notes/migration-plan.md
```

```bash
ctx add --type decision --file ./notes/why-we-chose-kafka.md
```

The file content is read and stored as manual context. The original file is not modified.

## Adding via Editor

Open your default editor to write context:

```bash
ctx add --edit
```

This opens `$EDITOR` (or `vi` by default) with a template:

```markdown
# Add Context
# Type your context below. Lines starting with # are comments.
# Save and close to add. Empty content cancels.
#
# Optional: set type by uncommenting one of:
# type: decision
# type: convention
# type: context
# type: correction

```

Write your content, save, and close the editor. The content is added as manual context.

```bash
# Combine with type
ctx add --type decision --edit
```

## Tags

Tags help organize manual context and control which wiki pages it affects:

```bash
ctx add --tags "auth,security" "MFA is required for all admin endpoints starting Q1 2025"
```

```bash
ctx add --tags "payments,stripe" --type convention "Always use idempotency keys for Stripe API calls"
```

Tags influence where Claude places the content in the wiki. Content tagged `auth` is more likely to appear in `architecture/auth.md` or `conventions/` pages related to auth.

## Listing Manual Context

See all manually added context:

```bash
ctx add --list
```

```
Manual context entries:

  #1  [context]     Redis cache TTL is 5 minutes for user sessions...
      Added: 2025-01-15   Tags: -

  #2  [decision]    We chose Postgres over DynamoDB because...
      Added: 2025-01-15   Tags: -

  #3  [convention]  All HTTP handlers must validate input with Zod...
      Added: 2025-01-16   Tags: -

  #4  [correction]  The Confluence auth doc says we use session cookies...
      Added: 2025-01-17   Tags: auth

  #5  [context]     MFA is required for all admin endpoints...
      Added: 2025-01-18   Tags: auth, security

5 entries total
```

## Removing Manual Context

If a manual note is no longer relevant (the upstream source was updated, the decision was reversed):

```bash
ctx add --remove 4
```

```
 Removed entry #4: [correction] The Confluence auth doc says...
```

## How Manual Context Gets Compiled

Manual context entries are stored as individual markdown files in `.ctx/context/_manual/`:

```
.ctx/context/_manual/
  001-context.md
  002-decision.md
  003-convention.md
  004-correction.md
  005-context.md
```

During `ctx ingest` or `ctx sync`, Claude reads these alongside all other sources. It integrates them into the appropriate wiki pages:

- **Decisions** go into `decisions/` pages or architecture pages
- **Conventions** go into `conventions/` pages
- **Context** is woven into relevant pages
- **Corrections** override conflicting content from other sources
- **Untyped notes** are placed wherever Claude determines they fit best

After compilation, the manual entries remain in `_manual/` so they continue to influence future syncs.

## Best Practices

**Add corrections immediately.** When you spot something wrong in the wiki, add a correction right away. Do not wait for the upstream source to be fixed.

**Be specific.** Instead of "auth is different now," write "Auth migrated from session cookies to JWT in Q3 2024 per ACME-142."

**Use types.** Typed notes get placed more accurately than untyped notes.

**Tag generously.** Tags cost nothing and improve placement accuracy.

**Capture decisions in meetings.** After a meeting where a technical decision is made, run `ctx add --type decision "..."` while it is fresh. This is often the only record of why something was decided.
