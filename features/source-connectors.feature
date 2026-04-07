@sources
Feature: Source connector management
  As a developer configuring project context sources
  I want to add, remove, list, and validate connectors for all supported source types
  So that Claude has access to the knowledge it needs to compile the wiki

  Background:
    Given a project initialized with "ctx init"
    And a valid "ctx.yaml" exists in the project root

  # ── Add sources ─────────────────────────────────────────────────

  Scenario Outline: Add a source of each supported type
    When I run "ctx sources add <type> <args>"
    Then the "ctx.yaml" should contain a source of type "<type>"
    And the CLI should output "Source added: <type>"
    And "ctx sources list" should include the new source

    Examples:
      | type       | args                                          |
      | local      | ./services/api-service                        |
      | pdf        | docs/architecture-overview.pdf                |
      | word       | docs/onboarding-guide.docx                    |
      | pptx       | docs/tech-strategy.pptx                       |
      | excel      | data/team-roster.xlsx                         |
      | github     | https://github.com/acme/acme-platform         |
      | jira       | --project ACME --url https://acme.atlassian.net |
      | confluence | --space ENG --url https://acme.atlassian.net   |
      | teams      | --team "Engineering" --channel "general"       |

  Scenario: Add multiple local paths as sources
    When I run "ctx sources add local ./services/api-service"
    And I run "ctx sources add local ./services/auth-service"
    And I run "ctx sources add local ./services/payment-service"
    Then the "ctx.yaml" should contain 3 local sources
    And "ctx sources list" should show:
      | type  | path                          | status  |
      | local | ./services/api-service        | active  |
      | local | ./services/auth-service       | active  |
      | local | ./services/payment-service    | active  |

  # ── Remove sources ──────────────────────────────────────────────

  Scenario: Remove a source by type and identifier
    Given the "ctx.yaml" contains the following sources:
      | type       | identifier                    |
      | local      | ./services/api-service        |
      | local      | ./services/auth-service       |
      | jira       | ACME                          |
    When I run "ctx sources remove local ./services/auth-service"
    Then the "ctx.yaml" should no longer contain a local source for "./services/auth-service"
    And the "ctx.yaml" should still contain the local source for "./services/api-service"
    And the CLI should output "Source removed: local ./services/auth-service"

  Scenario: Remove an external connector source
    Given the "ctx.yaml" contains a "jira" source for project "ACME"
    When I run "ctx sources remove jira ACME"
    Then the "ctx.yaml" should no longer contain a "jira" source
    And the CLI should output "Source removed: jira ACME"

  Scenario: Attempt to remove a non-existent source
    When I run "ctx sources remove local ./nonexistent"
    Then the CLI should exit with error code 1
    And the error message should contain "Source not found: local ./nonexistent"

  # ── List sources ────────────────────────────────────────────────

  Scenario: List all configured sources
    Given the "ctx.yaml" contains the following sources:
      | type       | identifier                          | status   |
      | local      | .                                   | active   |
      | pdf        | docs/architecture-overview.pdf      | active   |
      | github     | acme/acme-platform                  | active   |
      | jira       | ACME                                | active   |
      | confluence | ENG                                 | stale    |
      | teams      | Engineering/general                 | active   |
    When I run "ctx sources list"
    Then the output should display a table with columns "type", "identifier", "status", "last-synced"
    And the table should contain 6 rows

  Scenario: List sources filtered by type
    Given the "ctx.yaml" contains sources of types "local", "pdf", "jira", "confluence"
    When I run "ctx sources list --type jira"
    Then only "jira" sources should be displayed

  # ── Credential validation ───────────────────────────────────────

  Scenario Outline: Validate credentials for external connectors
    Given a "<connector>" source is configured in "ctx.yaml"
    And the credentials for "<connector>" are "<validity>"
    When I run "ctx sources validate <connector>"
    Then the CLI should output "<expected_message>"
    And the exit code should be <exit_code>

    Examples:
      | connector  | validity | expected_message                          | exit_code |
      | github     | valid    | github: credentials valid                 | 0         |
      | github     | invalid  | github: authentication failed             | 1         |
      | jira       | valid    | jira: credentials valid                   | 0         |
      | jira       | expired  | jira: token expired — re-authenticate     | 1         |
      | confluence | valid    | confluence: credentials valid              | 0         |
      | confluence | invalid  | confluence: authentication failed          | 1         |
      | teams      | valid    | teams: credentials valid                  | 0         |
      | teams      | invalid  | teams: authentication failed              | 1         |

  Scenario: Validate all sources at once
    Given the "ctx.yaml" contains sources with valid credentials for "github" and "jira"
    And the "confluence" source has expired credentials
    When I run "ctx sources validate"
    Then the output should show:
      | source     | status                          |
      | github     | credentials valid               |
      | jira       | credentials valid               |
      | confluence | token expired — re-authenticate  |
    And the exit code should be 1

  # ── Source status tracking ──────────────────────────────────────

  Scenario: Track source sync status
    Given the "ctx.yaml" contains the following sources:
      | type       | identifier     | last_synced              |
      | local      | .              | 2026-04-07T10:00:00Z     |
      | jira       | ACME           | 2026-04-06T15:30:00Z     |
      | confluence | ENG            | 2026-04-01T09:00:00Z     |
    When I run "ctx sources status"
    Then the output should show each source with its last sync time
    And the "confluence" source should be flagged as "stale" (older than 3 days)

  Scenario: Source status shows never-synced sources
    Given the "ctx.yaml" contains a "jira" source that has never been synced
    When I run "ctx sources status"
    Then the "jira" source should show status "never synced"

  # ── Jira advanced configuration ─────────────────────────────────

  Scenario: Add multiple Jira projects
    When I run "ctx sources add jira --project ACME --url https://acme.atlassian.net"
    And I run "ctx sources add jira --project PLATFORM --url https://acme.atlassian.net"
    And I run "ctx sources add jira --project INFRA --url https://acme.atlassian.net"
    Then the "ctx.yaml" should contain 3 jira sources
    And each jira source should have a distinct project key

  Scenario: Add Jira source with JQL filter
    When I run "ctx sources add jira --project ACME --url https://acme.atlassian.net --jql 'status = \"In Progress\" AND assignee = currentUser()'"
    Then the "ctx.yaml" should contain a jira source with the JQL filter
    And the JQL filter should be stored in the source configuration

  Scenario: Add Jira source filtering by labels
    When I run "ctx sources add jira --project ACME --url https://acme.atlassian.net --labels architecture,tech-debt"
    Then the "ctx.yaml" jira source should include label filters:
      | label         |
      | architecture  |
      | tech-debt     |

  # ── Confluence advanced configuration ───────────────────────────

  Scenario: Add multiple Confluence spaces
    When I run "ctx sources add confluence --space ENG --url https://acme.atlassian.net"
    And I run "ctx sources add confluence --space PLATFORM --url https://acme.atlassian.net"
    Then the "ctx.yaml" should contain 2 confluence sources
    And each should reference a different space key

  Scenario: Add Confluence source for specific pages by URL
    When I run "ctx sources add confluence --url https://acme.atlassian.net --pages 'https://acme.atlassian.net/wiki/spaces/ENG/pages/12345,https://acme.atlassian.net/wiki/spaces/ENG/pages/67890'"
    Then the "ctx.yaml" confluence source should include page references:
      | page_id |
      | 12345   |
      | 67890   |

  Scenario: Add Confluence source for specific pages by ID
    When I run "ctx sources add confluence --url https://acme.atlassian.net --page-ids 12345,67890,11111"
    Then the "ctx.yaml" confluence source should include 3 page IDs

  Scenario: Add Confluence source filtered by label
    When I run "ctx sources add confluence --space ENG --url https://acme.atlassian.net --labels architecture,runbooks"
    Then the "ctx.yaml" confluence source should include label filters:
      | label         |
      | architecture  |
      | runbooks      |

  # ── Edge cases ──────────────────────────────────────────────────

  Scenario: Add a source with a path that does not exist
    When I run "ctx sources add local ./nonexistent-directory"
    Then the CLI should exit with error code 1
    And the error message should contain "Path does not exist: ./nonexistent-directory"

  Scenario: Add a duplicate source
    Given the "ctx.yaml" contains a local source for "./services/api-service"
    When I run "ctx sources add local ./services/api-service"
    Then the CLI should output "Source already exists: local ./services/api-service"
    And the "ctx.yaml" should still contain only one local source for that path

  Scenario: Add a PDF that is not a valid PDF file
    Given a file "docs/not-a-pdf.pdf" exists but is not a valid PDF
    When I run "ctx sources add pdf docs/not-a-pdf.pdf"
    Then the CLI should exit with error code 1
    And the error message should contain "Invalid PDF file: docs/not-a-pdf.pdf"
