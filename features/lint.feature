@lint
Feature: Wiki health checks and linting
  As a developer maintaining project context
  I want to detect contradictions, stale content, and structural issues in the wiki
  So that the compiled context remains accurate and trustworthy

  Background:
    Given a project initialized with "ctx init"
    And the wiki has been compiled with "ctx ingest"

  # ── Contradiction detection ─────────────────────────────────────

  Scenario: Detect contradictions between wiki pages
    Given the wiki contains the following content:
      | page                  | claim                                          |
      | wiki/api-service.md   | The API rate limit is 1000 requests per minute |
      | wiki/conventions.md   | All APIs have a rate limit of 500 per minute   |
    When I run "ctx lint"
    Then the report should contain a contradiction:
      | severity | type           | pages                                     | description                                |
      | error    | contradiction  | api-service.md, conventions.md             | Conflicting rate limit values (1000 vs 500) |

  Scenario: Detect contradictions between source and manual notes
    Given the wiki page "wiki/auth-service.md" states "tokens expire after 24 hours"
    And a manual correction states "tokens expire after 1 hour"
    And the correction has not been integrated yet
    When I run "ctx lint"
    Then the report should flag the unresolved contradiction
    And the report should suggest running "ctx ingest" to resolve

  Scenario: Detect contradictions in service dependencies
    Given the wiki contains:
      | page                       | claim                                    |
      | wiki/api-service.md        | Depends on auth-service and db           |
      | wiki/services.md           | api-service depends on auth-service only |
    When I run "ctx lint"
    Then the report should flag the dependency discrepancy

  Scenario: No contradictions in a consistent wiki
    Given the wiki pages are internally consistent
    When I run "ctx lint"
    Then the report should show 0 contradictions

  # ── Stale content detection ─────────────────────────────────────

  Scenario: Detect stale wiki pages
    Given the wiki contains pages with the following last-updated timestamps:
      | page                    | last_updated             |
      | wiki/api-service.md     | 2026-04-07T10:00:00Z     |
      | wiki/auth-service.md    | 2026-04-07T09:00:00Z     |
      | wiki/legacy-service.md  | 2026-03-01T12:00:00Z     |
      | wiki/old-conventions.md | 2026-02-15T08:00:00Z     |
    When I run "ctx lint"
    Then the report should flag stale pages:
      | page                    | days_stale |
      | wiki/legacy-service.md  | 37         |
      | wiki/old-conventions.md | 51         |

  Scenario: Detect stale content with custom threshold
    When I run "ctx lint --stale-days 7"
    Then pages not updated in the last 7 days should be flagged as stale

  Scenario: Detect pages whose sources have changed
    Given "wiki/api-service.md" was compiled from "src/services/api-service/"
    And "src/services/api-service/routes.ts" has been modified since last ingest
    When I run "ctx lint"
    Then the report should flag "wiki/api-service.md" as potentially outdated
    And the report should note "source modified since last ingest"

  # ── Orphan page detection ───────────────────────────────────────

  Scenario: Detect orphan pages with no incoming references
    Given the wiki contains:
      | page                      | referenced_by              |
      | wiki/api-service.md       | wiki/index.md, wiki/overview.md |
      | wiki/auth-service.md      | wiki/index.md, wiki/api-service.md |
      | wiki/unused-notes.md      |                            |
      | wiki/old-migration.md     |                            |
    When I run "ctx lint"
    Then the report should flag orphan pages:
      | page                    | issue                    |
      | wiki/unused-notes.md    | No incoming references   |
      | wiki/old-migration.md   | No incoming references   |

  Scenario: Index page is not flagged as orphan
    Given "wiki/index.md" has no incoming references from other pages
    When I run "ctx lint"
    Then "wiki/index.md" should not be flagged as an orphan
    And "wiki/log.md" should not be flagged as an orphan

  # ── Missing page detection ──────────────────────────────────────

  Scenario: Detect missing pages that are referenced but do not exist
    Given "wiki/api-service.md" contains a link to "wiki/database-schema.md"
    And "wiki/auth-service.md" contains a link to "wiki/security-policies.md"
    And neither "wiki/database-schema.md" nor "wiki/security-policies.md" exist
    When I run "ctx lint"
    Then the report should flag missing pages:
      | missing_page                | referenced_from         |
      | wiki/database-schema.md     | wiki/api-service.md     |
      | wiki/security-policies.md   | wiki/auth-service.md    |

  Scenario: No missing pages when all references resolve
    Given all cross-references in the wiki point to existing pages
    When I run "ctx lint"
    Then the report should show 0 missing pages

  # ── Summary report ──────────────────────────────────────────────

  Scenario: Lint produces a categorized summary report
    Given the wiki has various issues
    When I run "ctx lint"
    Then the report should contain sections:
      | section          | description                          |
      | Contradictions   | Pages with conflicting information   |
      | Stale Content    | Pages not updated recently           |
      | Orphan Pages     | Pages with no incoming references    |
      | Missing Pages    | Referenced pages that do not exist   |
    And the report should end with a summary line:
      """
      Lint complete: 2 contradictions, 3 stale pages, 1 orphan, 2 missing pages
      """

  Scenario: Lint report with no issues
    Given the wiki is in perfect health
    When I run "ctx lint"
    Then the report should output:
      """
      Lint complete: 0 issues found
      """
    And the exit code should be 0

  Scenario: Lint with JSON output format
    When I run "ctx lint --format json"
    Then the output should be valid JSON
    And the JSON should contain arrays for each issue category:
      | key             |
      | contradictions  |
      | stale           |
      | orphans         |
      | missing         |

  # ── Exit codes ──────────────────────────────────────────────────

  Scenario Outline: Lint exit codes reflect severity
    Given the wiki has <issue_count> issues of severity "<severity>"
    When I run "ctx lint"
    Then the exit code should be <exit_code>

    Examples:
      | issue_count | severity | exit_code |
      | 0           | none     | 0         |
      | 3           | warning  | 0         |
      | 1           | error    | 1         |
      | 5           | error    | 1         |

  # ── API endpoint ────────────────────────────────────────────────

  Scenario: Lint via REST API
    Given the API server is running on port 4400
    When I send a POST request to "http://localhost:4400/api/lint" with body:
      """
      {}
      """
    Then the response status should be 200
    And the response body should contain:
      | field            |
      | contradictions   |
      | stale            |
      | orphans          |
      | missing          |
      | summary          |

  # ── Edge cases ──────────────────────────────────────────────────

  Scenario: Lint with empty wiki
    Given the wiki has not been compiled yet
    When I run "ctx lint"
    Then the CLI should output "Wiki is empty. Run 'ctx ingest' first."
    And the exit code should be 1

  Scenario: Lint only specific categories
    When I run "ctx lint --only contradictions,stale"
    Then the report should only include contradiction and stale content checks
    And orphan and missing page checks should be skipped
