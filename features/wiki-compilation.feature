@wiki @core
Feature: Wiki compilation from sources
  As a developer using withctx
  I want Claude to read all configured sources and compile them into wiki pages
  So that I have a living, structured knowledge base for my project

  Background:
    Given a project initialized with "ctx init"
    And the "ctx.yaml" contains configured sources

  # ── First ingest creates wiki pages ─────────────────────────────

  Scenario: First ingest compiles local source code into wiki pages
    Given the project "acme-platform" contains the following source files:
      | path                              | description                         |
      | src/services/api-service/index.ts | Express API with REST endpoints     |
      | src/services/auth-service/auth.ts | JWT authentication middleware       |
      | src/services/auth-service/rbac.ts | Role-based access control           |
      | src/shared/types.ts               | Shared TypeScript type definitions  |
      | src/shared/utils.ts               | Common utility functions            |
    When I run "ctx ingest"
    Then the wiki should contain the following pages:
      | page                      |
      | wiki/index.md             |
      | wiki/overview.md          |
      | wiki/api-service.md       |
      | wiki/auth-service.md      |
      | wiki/shared-libraries.md  |
    And "wiki/index.md" should list all generated pages
    And "wiki/log.md" should contain an entry for this ingest operation

  Scenario: First ingest compiles PDF documents
    Given the "ctx.yaml" contains a PDF source "docs/architecture-overview.pdf"
    And the PDF contains 12 pages about system architecture
    When I run "ctx ingest"
    Then the wiki should contain a page summarizing the PDF content
    And the page should attribute content to "docs/architecture-overview.pdf"

  Scenario: First ingest compiles Word documents
    Given the "ctx.yaml" contains a Word source "docs/onboarding-guide.docx"
    When I run "ctx ingest"
    Then the wiki should contain a page compiled from the Word document
    And the page should preserve the document's heading structure

  Scenario: First ingest compiles PowerPoint presentations
    Given the "ctx.yaml" contains a PPTX source "docs/tech-strategy.pptx"
    And the presentation contains 15 slides about platform strategy
    When I run "ctx ingest"
    Then the wiki should contain a page compiled from the presentation
    And key points from each slide should be captured

  # ── Code compilation with fenced blocks + file attribution ──────

  Scenario: Code is compiled with fenced blocks and file paths
    Given the source file "src/services/api-service/routes.ts" contains:
      """
      export function registerRoutes(app: Express) {
        app.get('/api/health', healthCheck);
        app.post('/api/users', createUser);
        app.get('/api/users/:id', getUser);
      }
      """
    When I run "ctx ingest"
    Then the "wiki/api-service.md" page should contain a fenced code block:
      """
      ```typescript
      // src/services/api-service/routes.ts
      export function registerRoutes(app: Express) {
        app.get('/api/health', healthCheck);
        app.post('/api/users', createUser);
        app.get('/api/users/:id', getUser);
      }
      ```
      """
    And the code block should include the file attribution comment

  Scenario: Multiple code files are attributed correctly
    Given the source contains:
      | file                              | language   |
      | src/services/auth-service/auth.ts | typescript |
      | src/shared/utils.ts               | typescript |
      | scripts/deploy.sh                 | bash       |
      | config/nginx.conf                 | nginx      |
    When I run "ctx ingest"
    Then each code reference in the wiki should include:
      | attribute       |
      | file path       |
      | language tag    |
      | fenced block    |

  # ── Subsequent ingest updates only changed pages ────────────────

  Scenario: Subsequent ingest updates only modified sources
    Given a previous ingest produced the following wiki pages:
      | page                  | content_hash |
      | wiki/api-service.md   | abc123       |
      | wiki/auth-service.md  | def456       |
      | wiki/overview.md      | ghi789       |
    And only "src/services/api-service/routes.ts" has been modified since
    When I run "ctx ingest"
    Then only "wiki/api-service.md" should be updated
    And "wiki/auth-service.md" should remain unchanged
    And "wiki/overview.md" should remain unchanged
    And "wiki/log.md" should record "1 page updated, 2 pages unchanged"

  Scenario: Subsequent ingest detects new source files
    Given a previous ingest completed successfully
    And a new file "src/services/payment-service/index.ts" has been added
    When I run "ctx ingest"
    Then a new wiki page "wiki/payment-service.md" should be created
    And "wiki/index.md" should be updated to include the new page
    And "wiki/log.md" should record "1 page created"

  Scenario: Subsequent ingest handles deleted source files
    Given a previous ingest produced "wiki/legacy-service.md"
    And the source directory "src/services/legacy-service/" has been deleted
    When I run "ctx ingest"
    Then "wiki/legacy-service.md" should be marked as stale
    And "wiki/log.md" should record "1 page marked stale (source deleted)"

  # ── Cross-references between pages ──────────────────────────────

  Scenario: Wiki pages contain cross-references
    Given the source code shows that "api-service" imports from "auth-service"
    When I run "ctx ingest"
    Then "wiki/api-service.md" should contain a link to "wiki/auth-service.md"
    And the cross-reference should describe the dependency relationship

  Scenario: Index page maintains a complete cross-reference map
    Given the wiki contains pages for "api-service", "auth-service", and "shared-libraries"
    When I run "ctx ingest"
    Then "wiki/index.md" should contain a section listing all cross-references:
      | from             | to                | relationship     |
      | api-service      | auth-service      | imports          |
      | api-service      | shared-libraries  | imports          |
      | auth-service     | shared-libraries  | imports          |

  # ── Images in Word/Confluence via Claude vision ─────────────────

  Scenario: Word document images are processed via Claude vision
    Given the "ctx.yaml" contains a Word source "docs/architecture-guide.docx"
    And the document contains embedded architecture diagrams
    When I run "ctx ingest"
    Then the wiki page should include descriptions of the diagrams
    And each diagram description should note it was processed via vision
    And the descriptions should capture key entities and relationships

  Scenario: Confluence page images are processed via Claude vision
    Given the "ctx.yaml" contains a Confluence source for space "ENG"
    And the Confluence page "System Architecture" contains embedded diagrams
    When I run "ctx ingest"
    Then the wiki page should include vision-processed descriptions of the diagrams
    And the descriptions should be integrated into the surrounding text context

  # ── Excel data compiled into people/services pages ──────────────

  Scenario: Excel team roster compiled into people page
    Given the "ctx.yaml" contains an Excel source "data/team-roster.xlsx"
    And the spreadsheet contains:
      | Name           | Role              | Team          | Expertise          |
      | Alice Chen     | Tech Lead         | Platform      | Go, Kubernetes     |
      | Bob Smith      | Senior Engineer   | Auth          | TypeScript, OAuth  |
      | Carol Jones    | Staff Engineer    | API           | Node.js, GraphQL   |
    When I run "ctx ingest"
    Then the wiki should contain a "wiki/people.md" page
    And the page should list team members with their roles and expertise
    And each person should be cross-referenced with their team's wiki page

  Scenario: Excel service catalog compiled into services page
    Given the "ctx.yaml" contains an Excel source "data/service-catalog.xlsx"
    And the spreadsheet contains:
      | Service          | Owner        | Language   | Port  | Dependencies         |
      | api-service      | Carol Jones  | TypeScript | 3000  | auth-service, db     |
      | auth-service     | Bob Smith    | TypeScript | 3001  | db, redis            |
      | payment-service  | Alice Chen   | Go         | 3002  | api-service, stripe  |
    When I run "ctx ingest"
    Then the wiki should contain a "wiki/services.md" page
    And each service should list its owner, language, and dependencies
    And services should cross-reference their respective wiki pages

  # ── index.md + log.md maintained automatically ──────────────────

  Scenario: index.md is maintained as the wiki table of contents
    Given the wiki contains the following pages:
      | page                      |
      | wiki/overview.md          |
      | wiki/api-service.md       |
      | wiki/auth-service.md      |
      | wiki/conventions.md       |
      | wiki/people.md            |
    When I run "ctx ingest"
    Then "wiki/index.md" should list all pages with:
      | field        |
      | page path    |
      | title        |
      | summary      |
      | last updated |

  Scenario: log.md tracks all ingest operations
    Given 3 previous ingest operations have been performed
    When I run "ctx ingest"
    Then "wiki/log.md" should contain 4 entries in reverse chronological order
    And each entry should include:
      | field              |
      | timestamp          |
      | pages created      |
      | pages updated      |
      | pages unchanged    |
      | sources processed  |
      | tokens used        |

  # ── Edge cases ──────────────────────────────────────────────────

  Scenario: Ingest with no configured sources
    Given the "ctx.yaml" has an empty sources list
    When I run "ctx ingest"
    Then the CLI should output "No sources configured. Run 'ctx sources add' to add sources."
    And no wiki pages should be created

  Scenario: Ingest handles source read errors gracefully
    Given the "ctx.yaml" contains a PDF source "docs/corrupted.pdf"
    And the PDF file is corrupted
    When I run "ctx ingest"
    Then the CLI should output a warning "Failed to read source: docs/corrupted.pdf"
    And other sources should still be processed
    And "wiki/log.md" should record the error
