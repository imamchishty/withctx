@init
Feature: Project initialization
  As a developer joining or starting a project
  I want to initialize withctx in my repository
  So that Claude can begin compiling project knowledge into a living wiki

  Background:
    Given the CLI tool "ctx" is installed
    And I am in a project directory

  # ── Auto-detection ──────────────────────────────────────────────

  Scenario: Initialize a project with default auto-detection
    Given the project directory contains the following structure:
      | path                          | type      |
      | src/index.ts                  | file      |
      | src/services/auth.ts          | file      |
      | docs/architecture.md          | file      |
      | README.md                     | file      |
      | package.json                  | file      |
    When I run "ctx init"
    Then a "ctx.yaml" file should be created in the project root
    And a ".ctx/" directory should be created
    And the ".ctx/" directory should contain a "wiki/" subdirectory
    And the "ctx.yaml" should contain the following sources:
      | type  | path |
      | local | .    |
    And the CLI should output "Initialized withctx in /path/to/project"

  Scenario: Auto-detect multiple local source directories
    Given the project directory contains the following structure:
      | path                        | type      |
      | src/main.ts                 | file      |
      | docs/api-spec.md            | file      |
      | docs/runbook.md             | file      |
      | scripts/deploy.sh           | file      |
    When I run "ctx init"
    Then the "ctx.yaml" should contain the following sources:
      | type  | path    |
      | local | .       |
    And the auto-detected paths should include "src/" and "docs/"

  Scenario: Auto-detect PDF documents in the project
    Given the project directory contains the following files:
      | path                             |
      | docs/architecture-overview.pdf   |
      | docs/api-contract.pdf            |
      | src/index.ts                     |
    When I run "ctx init"
    Then the "ctx.yaml" should contain the following sources:
      | type  | path                           |
      | local | .                              |
      | pdf   | docs/architecture-overview.pdf |
      | pdf   | docs/api-contract.pdf          |

  Scenario: Auto-detect Word documents in the project
    Given the project directory contains the following files:
      | path                          |
      | docs/onboarding-guide.docx    |
      | docs/team-conventions.docx    |
    When I run "ctx init"
    Then the "ctx.yaml" should contain a source of type "word" for each ".docx" file

  Scenario: Auto-detect Excel spreadsheets in the project
    Given the project directory contains the following files:
      | path                        |
      | data/team-roster.xlsx       |
      | data/service-catalog.xlsx   |
    When I run "ctx init"
    Then the "ctx.yaml" should contain a source of type "excel" for each ".xlsx" file

  Scenario: Auto-detect PowerPoint files in the project
    Given the project directory contains the following files:
      | path                            |
      | docs/tech-strategy.pptx         |
      | docs/quarterly-review.pptx      |
    When I run "ctx init"
    Then the "ctx.yaml" should contain a source of type "pptx" for each ".pptx" file

  # ── ctx.yaml generation ─────────────────────────────────────────

  Scenario: Generated ctx.yaml has correct structure
    When I run "ctx init"
    Then the "ctx.yaml" should have the following top-level keys:
      | key       |
      | version   |
      | project   |
      | sources   |
      | wiki      |
      | settings  |
    And the "version" field should be "1"
    And the "project" field should match the directory name

  Scenario: .ctx directory structure is created correctly
    When I run "ctx init"
    Then the ".ctx/" directory should contain:
      | path          | type      |
      | wiki/         | directory |
      | wiki/index.md | file      |
      | wiki/log.md   | file      |
      | cache/        | directory |

  # ── --with flags for external connectors ────────────────────────

  Scenario Outline: Initialize with external connector flag
    When I run "ctx init --with <connector>"
    Then the "ctx.yaml" should contain a source entry of type "<connector>"
    And the source entry should have a placeholder configuration for "<connector>"
    And the CLI should output "Added <connector> connector — configure credentials in ctx.yaml"

    Examples:
      | connector  |
      | github     |
      | jira       |
      | confluence |
      | teams      |

  Scenario: Initialize with multiple external connectors
    When I run "ctx init --with github --with jira --with confluence"
    Then the "ctx.yaml" should contain source entries for:
      | type       |
      | local      |
      | github     |
      | jira       |
      | confluence |

  Scenario: Initialize with all connectors at once
    When I run "ctx init --with github --with jira --with confluence --with teams"
    Then the "ctx.yaml" should contain 5 source entries
    And each external connector should have placeholder credentials

  # ── Re-init preserves existing wiki ─────────────────────────────

  Scenario: Re-init preserves existing wiki pages
    Given a project that was previously initialized with "ctx init"
    And the wiki contains the following pages:
      | page                    |
      | wiki/architecture.md    |
      | wiki/auth-service.md    |
      | wiki/conventions.md     |
    When I run "ctx init"
    Then the existing wiki pages should be preserved:
      | page                    |
      | wiki/architecture.md    |
      | wiki/auth-service.md    |
      | wiki/conventions.md     |
    And the CLI should output "Re-initialized withctx (existing wiki preserved)"

  Scenario: Re-init updates ctx.yaml while preserving sources
    Given a project with an existing "ctx.yaml" containing:
      | type       | path              |
      | local      | .                 |
      | jira       | ACME project      |
    And a new file "docs/runbook.pdf" has been added to the project
    When I run "ctx init"
    Then the "ctx.yaml" should still contain the "jira" source
    And the "ctx.yaml" should now include a "pdf" source for "docs/runbook.pdf"

  Scenario: Re-init preserves manual notes
    Given a project that was previously initialized
    And the user has added manual notes:
      | note                                      | type       |
      | Always use UTC timestamps in APIs          | convention |
      | Auth migration planned for Q3              | decision   |
    When I run "ctx init"
    Then the manual notes should be preserved unchanged

  # ── Edge cases ──────────────────────────────────────────────────

  Scenario: Init in an empty directory
    Given the project directory is empty
    When I run "ctx init"
    Then a "ctx.yaml" file should be created with an empty sources list
    And the ".ctx/" directory should be created
    And the CLI should output "Initialized withctx (no sources auto-detected)"

  Scenario: Init fails outside a valid directory
    Given I am not in a valid directory
    When I run "ctx init"
    Then the CLI should exit with error code 1
    And the error message should contain "Cannot initialize: not a valid directory"
