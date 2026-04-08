# Sources

withctx connects to thirteen source types. Each connector reads data from its source, caches it locally in `.ctx/sources/`, and feeds it to Claude for wiki compilation.

## Overview

| Source | Config key | Auth required | What gets ingested |
|--------|-----------|---------------|-------------------|
| Local files | `local` | No | Markdown, text, code files |
| PDF | `pdf` | No | Text content, metadata |
| Word (.docx) | `word` | No | Text, headings, tables, embedded images |
| PowerPoint (.pptx) | `powerpoint` | No | Slide text, speaker notes, structure |
| Excel (.xlsx, .csv) | `excel` | No | Sheet data, headers, named ranges |
| GitHub | `repos` / `github` | `GITHUB_TOKEN` | Code, READMEs, issues, PRs |
| Jira | `jira` | `JIRA_EMAIL` + `JIRA_TOKEN` | Issues, epics, components, labels |
| Confluence | `confluence` | `CONFLUENCE_EMAIL` + `CONFLUENCE_TOKEN` | Pages, page trees, spaces |
| Microsoft Teams | `teams` | `TEAMS_*` credentials | Messages, threads, meeting transcripts |
| SharePoint | `sharepoint` | `TEAMS_*` credentials | Word, Excel, PPT, PDF from SharePoint sites |
| CI/CD | `cicd` | `GITHUB_TOKEN` | Build runs, success rates, failure analysis |
| Test Coverage | `coverage` | No | lcov, istanbul, cobertura coverage reports |
| Pull Requests | `pull-requests` | `GITHUB_TOKEN` | Merged PRs, reviewers, files changed, activity |

---

## Local Files

Reads files directly from the filesystem. Supports markdown, plain text, YAML, JSON, and source code files.

### Configuration

```yaml
sources:
  local:
    paths:
      - ./README.md               # Single file
      - ./docs/                    # Entire directory (recursive)
      - ./src/routes/              # Code for structure analysis
      - ./architecture/adrs/       # Architecture decision records
    exclude:
      - "**/*.test.ts"             # Glob patterns
      - "**/*.snap"
      - "**/node_modules/**"
      - "**/dist/**"
      - "**/.env*"
    extensions:                    # Optional: only read these types
      - .md
      - .ts
      - .yaml
      - .json
    max_file_size: 100kb           # Skip files larger than this
```

### What Gets Ingested

- File content with path preserved for context
- Directory structure for understanding project layout
- Code files are analyzed for structure (exports, routes, models) rather than ingested line-by-line

---

## PDF

Reads text content from PDF files. Handles multi-page documents, extracts metadata (title, author, creation date).

### Configuration

```yaml
sources:
  pdf:
    paths:
      - ./docs/specs/api-spec-v2.pdf
      - ./docs/compliance/
    exclude:
      - "**/draft-*.pdf"
    max_pages: 100                  # Skip PDFs longer than this
```

### What Gets Ingested

- Full text content extracted from all pages
- Document metadata (title, author, dates)
- Table content is extracted as structured text
- Scanned PDFs (image-only) are not supported — text must be selectable

---

## Word (.docx)

Reads Microsoft Word documents including text, headings, tables, lists, and embedded images.

### Configuration

```yaml
sources:
  word:
    paths:
      - ./docs/requirements/prd-v3.docx
      - ./docs/specs/
    exclude:
      - "**/*-draft.docx"
    extract_images: true            # Extract embedded images for context
```

### What Gets Ingested

- Full document text with heading hierarchy preserved
- Tables converted to structured text
- Lists (bulleted and numbered)
- Embedded images extracted and described (when `extract_images: true`)
- Document properties (title, author, last modified)
- Comments and track changes are ignored by default

### Notes

- Uses the `mammoth` library for extraction
- Complex formatting (text boxes, SmartArt) may be simplified
- Embedded images are saved to `.ctx/sources/images/` and described by Claude during compilation

---

## PowerPoint (.pptx)

Reads slide content from PowerPoint presentations, including text, speaker notes, and slide structure.

### Configuration

```yaml
sources:
  powerpoint:
    paths:
      - ./docs/presentations/architecture-review.pptx
      - ./docs/presentations/
    exclude:
      - "**/*-template.pptx"
    include_notes: true             # Include speaker notes
```

### What Gets Ingested

- Text content from all slides
- Slide titles and ordering
- Speaker notes (when `include_notes: true`)
- Table content from slides
- Slide count and structure
- Charts and SmartArt are described by their titles/labels, not their visual content

---

## Excel (.xlsx, .csv)

Reads spreadsheet data from Excel workbooks and CSV files. Useful for configuration matrices, feature lists, data dictionaries, and requirement tables.

### Configuration

```yaml
sources:
  excel:
    paths:
      - ./docs/data/feature-matrix.xlsx
      - ./docs/data/environments.csv
    sheets:                          # Optional: specific sheets only
      - "Requirements"
      - "Data Dictionary"
    max_rows: 1000                   # Limit rows per sheet
    header_row: 1                    # Which row contains headers
```

### What Gets Ingested

- All sheets (or specified sheets) with headers and data
- Cell values converted to text (formulas are evaluated to their result)
- Named ranges preserved with their labels
- CSV files parsed with auto-detected delimiters
- Empty rows and columns are trimmed

---

## GitHub

Reads repository content, issues, and pull requests. Repos can be configured either at the top level (via `repos:`) for multi-repo setups, or under `sources.github` for issue and PR ingestion.

### Configuration — Repository Content

```yaml
repos:
  - name: api-service
    url: https://github.com/acme-corp/acme-api
    branch: main                     # Optional, defaults to default branch
    paths:
      - README.md
      - docs/
      - src/routes/
      - src/models/
    exclude:
      - "**/*.test.ts"
      - "**/fixtures/**"
```

### Configuration — Issues and PRs

```yaml
sources:
  github:
    repos:
      - owner: acme-corp
        repo: acme-api
        issues:
          state: open                # open, closed, all
          labels:                    # Filter by labels
            - bug
            - architecture
          since: 90d                 # Only issues updated in last 90 days
        pull_requests:
          state: merged
          since: 30d                 # Recently merged PRs
          include_diff: false        # Don't include full diffs
          include_comments: true     # Include review comments
```

### Authentication

```bash
# .env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

For GitHub Enterprise:

```yaml
sources:
  github:
    host: https://github.acme-corp.com/api/v3
    repos:
      - owner: platform
        repo: api-service
```

### What Gets Ingested

- **Repos:** File content from specified paths, directory structure
- **Issues:** Title, description, labels, status, comments, assignees
- **PRs:** Title, description, review comments, merge status
- Diffs are summarized rather than included verbatim (unless `include_diff: true`)

---

## Jira

Reads issues from one or more Jira Cloud or Jira Data Center projects. Supports filtering by project, component, epic, label, and custom JQL.

### Configuration

```yaml
sources:
  jira:
    host: https://acme-corp.atlassian.net
    projects:
      - key: ACME
        components:                  # Optional: filter by component
          - api
          - auth
          - payments
        issue_types:                 # Optional: filter by type
          - Story
          - Bug
          - Epic
        labels:                      # Optional: filter by label
          - architecture
          - tech-debt

      - key: INFRA
        # No filters = all issues

    # Global JQL filter applied to all projects
    jql: "status != Cancelled AND updated >= -90d"

    # Or use raw JQL for full control
    custom_jql:
      - name: recent-decisions
        query: >
          project = ACME AND type = Epic
          AND labels = architecture-decision
          AND updated >= -180d

    include_comments: true           # Include issue comments
    include_attachments: false       # Don't download attachments
    max_issues: 500                  # Limit per project
```

### Authentication

```bash
# .env
JIRA_EMAIL=you@acme-corp.com
JIRA_TOKEN=ATATT3xFfGF0...         # API token from id.atlassian.com
```

For Jira Data Center (self-hosted):

```yaml
sources:
  jira:
    host: https://jira.acme-corp.com
    auth: basic                      # or "bearer" for PAT
```

### What Gets Ingested

- Issue key, summary, description, status, type, priority
- Epic linkage and parent/subtask relationships
- Component and label assignments
- Comments (when `include_comments: true`)
- Sprint information
- Custom fields are included in the raw data and available during compilation

---

## Confluence

Reads pages from one or more Confluence Cloud or Data Center spaces. Supports filtering by space, page URL, page ID, label, and page tree.

### Configuration

```yaml
sources:
  confluence:
    host: https://acme-corp.atlassian.net/wiki

    spaces:
      - key: ENG                     # Engineering space
        labels:                      # Optional: only pages with these labels
          - architecture
          - runbook
        exclude_labels:              # Optional: skip pages with these labels
          - draft
          - deprecated

      - key: ARCH                    # Architecture space (all pages)

    # Specific pages by URL
    pages:
      - url: https://acme-corp.atlassian.net/wiki/spaces/ENG/pages/12345/API+Guidelines
      - url: https://acme-corp.atlassian.net/wiki/spaces/ENG/pages/67890/Data+Model

    # Specific pages by ID
    page_ids:
      - "12345"
      - "67890"

    # Page trees: a page and all its descendants
    page_trees:
      - root_id: "11111"            # Architecture Decisions page
        max_depth: 3                 # How deep to traverse

    # Exclude specific pages
    exclude_page_ids:
      - "99999"                      # Skip this page

    include_attachments: false        # Don't download attachments
    max_pages: 200                    # Limit per space
```

### Authentication

```bash
# .env
CONFLUENCE_EMAIL=you@acme-corp.com
CONFLUENCE_TOKEN=ATATT3xFfGF0...    # Same API token as Jira (Atlassian Cloud)
```

### What Gets Ingested

- Page title, content (converted from Confluence storage format to text)
- Page hierarchy (parent/child relationships)
- Labels
- Last modified date and author
- Inline comments are included
- Macros are expanded where possible (code blocks, tables, panels)
- Attachments are listed but not downloaded by default

---

## Microsoft Teams

Reads messages from Teams channels, including threads and meeting transcripts. Filters noise (reactions, short acknowledgments) to focus on substantive content.

### Configuration

```yaml
sources:
  teams:
    channels:
      - team: Engineering
        channel: general
        since: 90d                   # Messages from last 90 days

      - team: Engineering
        channel: architecture-decisions
        since: 180d

      - team: Platform
        channel: incidents
        since: 30d

    transcripts:
      enabled: true                  # Ingest meeting transcripts
      channels:
        - team: Engineering
          channel: general

    noise_filter:
      min_message_length: 20         # Skip very short messages
      skip_reactions: true           # Skip reaction-only messages
      skip_system: true              # Skip "X joined the team" etc.
```

### Authentication

Teams uses Microsoft Graph API, which requires an Azure AD app registration:

```bash
# .env
TEAMS_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
TEAMS_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
TEAMS_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Setup steps:

1. Register an app in Azure AD (portal.azure.com > App registrations)
2. Add API permissions: `ChannelMessage.Read.All`, `Chat.Read`, `OnlineMeetingTranscript.Read.All`
3. Grant admin consent
4. Create a client secret
5. Copy Tenant ID, Client ID, and Client Secret to `.env`

### What Gets Ingested

- Message text with author and timestamp
- Thread structure (replies grouped under parent message)
- Meeting transcripts (when enabled) with speaker labels
- File attachments are referenced but not downloaded
- Reactions, joins/leaves, and short acknowledgments are filtered out

### Noise Filtering

Teams channels are noisy. The noise filter ensures withctx only ingests substantive messages:

- Messages shorter than `min_message_length` characters are skipped
- Pure reaction messages (thumbs up, etc.) are skipped
- System messages (member joined, meeting started) are skipped
- Duplicate messages (cross-posted) are deduplicated

---

## SharePoint / OneDrive

Fetches Word, Excel, PowerPoint, and PDF documents from SharePoint sites or OneDrive. Uses the same Microsoft Graph API as Teams — if you've set up Teams, SharePoint works with the same credentials.

### Configuration

```yaml
sources:
  sharepoint:
    - name: engineering-docs
      site: acme.sharepoint.com/sites/engineering
      paths:
        - /Shared Documents/Architecture/
        - /Shared Documents/Runbooks/
      filetypes: [docx, xlsx, pptx, pdf, md]

    - name: specific-files
      site: acme.sharepoint.com/sites/engineering
      files:
        - /Shared Documents/team-roster.xlsx
        - /Shared Documents/Q4 Roadmap.pptx
```

### Authentication

Same as Teams — uses Microsoft Graph API:

```bash
# .env (same credentials as Teams)
TEAMS_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
TEAMS_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
TEAMS_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Add `Sites.Read.All` permission to your Azure AD app (in addition to the Teams permissions).

### What Gets Ingested

- Documents are downloaded, parsed by file type (Word → text, Excel → tables, etc.)
- Cached locally in `.ctx/sources/sharepoint/`
- Incremental sync: only re-downloads files changed since last sync
- Wiki pages generated: content merged into relevant topic pages

---

## CI/CD (GitHub Actions)

Fetches build/deploy history from GitHub Actions. Gives the wiki insight into build health, deploy frequency, and common failures.

### Configuration

```yaml
sources:
  cicd:
    - name: api-builds
      provider: github-actions
      repo: acme/api-service
```

### Authentication

```bash
# .env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

### What Gets Ingested

- Workflow run results (success, failure, cancelled)
- Build duration and timing
- Failed job details and step logs
- Summary statistics: success rate, avg build time, deploy frequency
- Wiki pages generated: `repos/api-service/ci.md`

---

## Test Coverage

Reads coverage reports and adds testing insights to the wiki. Supports lcov, istanbul JSON, and cobertura formats.

### Configuration

```yaml
sources:
  coverage:
    - name: api-coverage
      path: ./coverage/lcov.info
      format: lcov                     # lcov | istanbul-json | cobertura
```

### Authentication

None — reads local files.

### What Gets Ingested

- Per-file line/branch/function coverage percentages
- Per-directory breakdown
- Bottom 10 files (lowest coverage) and top 10 files
- Overall project coverage metrics
- Wiki pages generated: `repos/api-service/testing.md`

---

## Pull Requests

Fetches merged PR data to understand recent changes, review patterns, and team activity.

### Configuration

```yaml
sources:
  pull-requests:
    - name: api-prs
      repo: acme/api-service
      include: merged                  # merged | open | all
      since: 30d                       # duration or date
```

### Authentication

```bash
# .env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

### What Gets Ingested

- PR title, description, author, reviewers
- Files changed per PR with additions/deletions
- Review comments and approval status
- Activity summary: PRs per week, avg review time, most active contributors
- Wiki pages generated: `repos/api-service/recent-changes.md`

---

## Checking Configured Sources

After configuring `ctx.yaml`, verify your sources are accessible:

```bash
ctx sources
```

```
Configured sources for acme-platform:

  Local files     3 paths configured     18 files found
  PDF             1 path configured       2 files found
  Word            1 path configured       1 file found
  GitHub repos    3 repos configured      accessible
  Jira            2 projects configured   accessible (187 issues)
  Confluence      2 spaces configured     accessible (43 pages)
  Teams           2 channels configured   accessible (312 messages)

Run ctx ingest to compile the wiki.
```

If a source is misconfigured or authentication fails, the output shows the error:

```
  Jira            2 projects configured   ERROR: 401 Unauthorized
                                          Check JIRA_EMAIL and JIRA_TOKEN in .env
```
