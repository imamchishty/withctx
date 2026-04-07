@sync
Feature: Wiki sync and freshness management
  As a developer keeping project context current
  I want to incrementally sync sources and track wiki freshness
  So that the compiled wiki always reflects the latest state of the project

  Background:
    Given a project initialized with "ctx init"
    And the wiki has been compiled with "ctx ingest"
    And the "ctx.yaml" contains the following sources:
      | type       | identifier                    |
      | local      | .                             |
      | pdf        | docs/architecture.pdf         |
      | jira       | ACME                          |
      | confluence | ENG                           |
      | github     | acme/acme-platform            |

  # ── Incremental sync ───────────────────────────────────────────

  Scenario: Incremental sync only processes changed sources
    Given the following source change status:
      | source                  | changed  |
      | local .                 | yes      |
      | docs/architecture.pdf   | no       |
      | jira ACME               | yes      |
      | confluence ENG          | no       |
      | github acme/acme-platform | no     |
    When I run "ctx sync"
    Then only the "local" and "jira" sources should be processed
    And the "pdf", "confluence", and "github" sources should be skipped
    And the CLI should output "Synced 2 sources (3 unchanged, skipped)"

  Scenario: Incremental sync detects file modifications via checksum
    Given the file "src/services/api-service/routes.ts" has been modified
    And the file "src/services/api-service/index.ts" is unchanged
    When I run "ctx sync"
    Then only the modified file should trigger a wiki update
    And "wiki/api-service.md" should be updated

  Scenario: Incremental sync detects new files
    Given a new file "src/services/notification-service/index.ts" has been added
    When I run "ctx sync"
    Then the sync should detect the new file
    And a new wiki page "wiki/notification-service.md" should be created

  Scenario: Incremental sync detects deleted files
    Given the file "src/services/legacy-service/index.ts" has been deleted
    When I run "ctx sync"
    Then the sync should detect the deletion
    And "wiki/legacy-service.md" should be marked as stale

  Scenario: Full sync re-processes all sources
    When I run "ctx sync --full"
    Then all 5 sources should be processed regardless of change status
    And the CLI should output "Full sync: processed 5 sources"

  # ── Per-source sync ─────────────────────────────────────────────

  Scenario: Sync a specific source by type
    When I run "ctx sync --source jira"
    Then only the "jira" source should be synced
    And other sources should not be processed
    And the CLI should output "Synced source: jira ACME"

  Scenario: Sync a specific source by identifier
    When I run "ctx sync --source 'confluence ENG'"
    Then only the "confluence ENG" source should be synced

  Scenario Outline: Sync individual source types
    When I run "ctx sync --source <source>"
    Then only the "<source>" source should be processed
    And the CLI should output "Synced source: <source>"

    Examples:
      | source     |
      | local      |
      | pdf        |
      | jira       |
      | confluence |
      | github     |

  Scenario: Sync a non-existent source
    When I run "ctx sync --source notion"
    Then the CLI should exit with error code 1
    And the error message should contain "Source not found: notion"

  # ── ctx diff ────────────────────────────────────────────────────

  Scenario: Show diff of changes since last sync
    Given the following changes occurred since last sync:
      | source  | change_type | detail                                   |
      | local   | modified    | src/services/api-service/routes.ts       |
      | local   | added       | src/services/notification-service/index.ts |
      | local   | deleted     | src/services/legacy-service/index.ts     |
      | jira    | new_issues  | 3 new issues in ACME project             |
    When I run "ctx diff"
    Then the output should show:
      | type     | count | details                              |
      | modified | 1     | src/services/api-service/routes.ts   |
      | added    | 1     | src/services/notification-service/   |
      | deleted  | 1     | src/services/legacy-service/         |
      | external | 1     | jira: 3 new issues                   |

  Scenario: Diff with no changes
    Given no sources have changed since the last sync
    When I run "ctx diff"
    Then the output should be "No changes detected since last sync."

  Scenario: Diff for a specific source
    When I run "ctx diff --source local"
    Then only local file changes should be displayed

  # ── ctx status ──────────────────────────────────────────────────

  Scenario: Show freshness status of all sources
    Given the sources have the following sync status:
      | source                  | last_synced              | status  |
      | local .                 | 2026-04-07T10:00:00Z     | fresh   |
      | docs/architecture.pdf   | 2026-04-07T10:00:00Z     | fresh   |
      | jira ACME               | 2026-04-06T15:00:00Z     | fresh   |
      | confluence ENG          | 2026-04-01T09:00:00Z     | stale   |
      | github acme/acme-platform | 2026-03-15T12:00:00Z   | stale   |
    When I run "ctx status"
    Then the output should display a table with columns:
      | column       |
      | source       |
      | last_synced  |
      | status       |
      | age          |
    And stale sources should be highlighted

  Scenario: Status shows wiki page count and size
    When I run "ctx status"
    Then the output should include:
      | metric             | value          |
      | total wiki pages   | 12             |
      | total wiki size    | 45.2 KB        |
      | sources configured | 5              |
      | last full ingest   | 2026-04-07     |

  Scenario: Status with --json flag
    When I run "ctx status --json"
    Then the output should be valid JSON
    And the JSON should include freshness data for all sources

  # ── Prune stale content ─────────────────────────────────────────

  Scenario: Prune stale wiki pages older than threshold
    Given the wiki contains pages with the following ages:
      | page                    | last_updated             |
      | wiki/api-service.md     | 2026-04-07T10:00:00Z     |
      | wiki/auth-service.md    | 2026-04-06T09:00:00Z     |
      | wiki/legacy-service.md  | 2026-02-01T12:00:00Z     |
      | wiki/old-notes.md       | 2026-01-15T08:00:00Z     |
    When I run "ctx sync --prune --older-than 30d"
    Then "wiki/legacy-service.md" should be removed (65 days old)
    And "wiki/old-notes.md" should be removed (82 days old)
    And "wiki/api-service.md" should be preserved
    And "wiki/auth-service.md" should be preserved
    And the CLI should output "Pruned 2 stale pages (older than 30 days)"

  Scenario: Prune with confirmation prompt
    Given there are 3 stale wiki pages older than 30 days
    When I run "ctx sync --prune --older-than 30d"
    Then the CLI should list the pages to be pruned
    And the CLI should prompt "Remove 3 stale pages? [y/N]"

  Scenario: Prune with force flag skips confirmation
    When I run "ctx sync --prune --older-than 30d --force"
    Then stale pages should be removed without confirmation

  Scenario Outline: Prune with different time thresholds
    When I run "ctx sync --prune --older-than <threshold>"
    Then pages older than <days> days should be eligible for removal

    Examples:
      | threshold | days |
      | 7d        | 7    |
      | 14d       | 14   |
      | 30d       | 30   |
      | 90d       | 90   |

  Scenario: Prune does not remove index.md or log.md
    Given "wiki/index.md" was last updated 60 days ago
    When I run "ctx sync --prune --older-than 30d --force"
    Then "wiki/index.md" should not be removed
    And "wiki/log.md" should not be removed

  # ── Edge cases ──────────────────────────────────────────────────

  Scenario: Sync with no configured sources
    Given the "ctx.yaml" has an empty sources list
    When I run "ctx sync"
    Then the CLI should output "No sources configured. Run 'ctx sources add' to add sources."

  Scenario: Sync when external source is unreachable
    Given the "jira" source is configured but the server is unreachable
    When I run "ctx sync"
    Then the CLI should output a warning "Failed to sync source: jira ACME (connection timeout)"
    And other sources should still be synced
    And the exit code should be 0

  Scenario: Sync records operation in log
    When I run "ctx sync"
    Then "wiki/log.md" should contain a new sync entry with:
      | field              |
      | timestamp          |
      | sources synced     |
      | pages updated      |
      | tokens used        |
