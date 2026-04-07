@onboarding
Feature: Engineer onboarding guide generation
  As a new engineer joining the team
  I want auto-generated onboarding guides for the project and each repo
  So that I can get productive quickly without waiting for tribal knowledge transfer

  Background:
    Given a project initialized with "ctx init"
    And the wiki has been compiled with "ctx ingest"
    And the wiki contains pages for "api-service", "auth-service", "payment-service", "conventions", and "people"

  # ── Auto-generate start-here guide ──────────────────────────────

  Scenario: Generate a start-here guide
    When I run "ctx onboard"
    Then the wiki should contain "wiki/onboarding/start-here.md"
    And the guide should include sections:
      | section                   |
      | Project Overview          |
      | Team Structure            |
      | Architecture Summary      |
      | Key Services              |
      | Important Conventions     |
      | Communication Channels    |
      | Useful Links              |

  Scenario: Start-here guide includes team information
    Given the wiki contains a "wiki/people.md" page with team members
    When I run "ctx onboard"
    Then "wiki/onboarding/start-here.md" should list key team members
    And each person should include their role and area of expertise

  Scenario: Start-here guide includes architecture overview
    Given the wiki contains architectural information across multiple pages
    When I run "ctx onboard"
    Then "wiki/onboarding/start-here.md" should contain a high-level architecture summary
    And the summary should reference detailed wiki pages for deeper reading

  # ── Auto-generate local-setup guide ─────────────────────────────

  Scenario: Generate a local-setup guide
    When I run "ctx onboard"
    Then the wiki should contain "wiki/onboarding/local-setup.md"
    And the guide should include sections:
      | section                    |
      | Prerequisites              |
      | Clone Repositories         |
      | Install Dependencies       |
      | Environment Variables      |
      | Database Setup             |
      | Run Services Locally       |
      | Verify Setup               |

  Scenario: Local-setup guide detects package manager
    Given the project uses "pnpm" as detected from "pnpm-lock.yaml"
    When I run "ctx onboard"
    Then "wiki/onboarding/local-setup.md" should reference "pnpm" for installation commands
    And the guide should include "pnpm install" not "npm install"

  Scenario: Local-setup guide includes environment variable list
    Given the source code references the following environment variables:
      | variable             | file                              |
      | DATABASE_URL         | src/config.ts                     |
      | JWT_SECRET           | src/services/auth-service/auth.ts |
      | STRIPE_API_KEY       | src/services/payment-service/pay.ts |
      | REDIS_URL            | src/config.ts                     |
    When I run "ctx onboard"
    Then "wiki/onboarding/local-setup.md" should list required environment variables:
      | variable         | source_file                       | required |
      | DATABASE_URL     | src/config.ts                     | yes      |
      | JWT_SECRET       | src/services/auth-service/auth.ts | yes      |
      | STRIPE_API_KEY   | src/services/payment-service/pay.ts | yes    |
      | REDIS_URL        | src/config.ts                     | yes      |

  Scenario: Local-setup guide detects Docker dependencies
    Given the project contains a "docker-compose.yml" with services:
      | service    | image            | port  |
      | postgres   | postgres:16      | 5432  |
      | redis      | redis:7          | 6379  |
      | mailhog    | mailhog/mailhog  | 8025  |
    When I run "ctx onboard"
    Then "wiki/onboarding/local-setup.md" should include Docker setup instructions
    And the guide should list the required Docker services

  # ── Auto-generate first-pr guide ────────────────────────────────

  Scenario: Generate a first-PR guide
    When I run "ctx onboard"
    Then the wiki should contain "wiki/onboarding/first-pr.md"
    And the guide should include sections:
      | section                  |
      | Branch Naming Convention |
      | Code Style               |
      | Testing Requirements     |
      | PR Template              |
      | Review Process           |
      | CI/CD Pipeline           |

  Scenario: First-PR guide includes testing conventions
    Given the wiki contains testing conventions
    When I run "ctx onboard"
    Then "wiki/onboarding/first-pr.md" should describe the testing approach
    And the guide should include example test commands

  Scenario: First-PR guide includes code review process
    Given the wiki contains information about the review process
    When I run "ctx onboard"
    Then "wiki/onboarding/first-pr.md" should describe:
      | topic                        |
      | Required reviewers           |
      | Approval requirements        |
      | CI checks that must pass     |
      | Merge strategy (squash/merge)|

  # ── Per-repo onboarding guides ──────────────────────────────────

  Scenario: Generate onboarding guide for a specific repo
    Given the workspace contains repos "api-service", "auth-service", "payment-service"
    When I run "ctx onboard api-service"
    Then the wiki should contain "wiki/onboarding/api-service.md"
    And the guide should be specific to the "api-service" repository
    And the guide should include:
      | section                     |
      | Service Overview            |
      | Local Development           |
      | Key Files and Directories   |
      | Dependencies                |
      | Testing                     |
      | Common Tasks                |

  Scenario: Per-repo guide includes key files and directories
    Given the "api-service" repo has the following structure:
      | path                    | purpose                    |
      | src/routes/             | API route definitions      |
      | src/middleware/          | Express middleware          |
      | src/models/             | Database models            |
      | src/services/           | Business logic             |
      | tests/                  | Test files                 |
      | config/                 | Configuration files        |
    When I run "ctx onboard api-service"
    Then "wiki/onboarding/api-service.md" should describe each key directory
    And the guide should explain the purpose of each directory

  Scenario: Per-repo guide lists service dependencies
    Given the "api-service" depends on "auth-service" and "payment-service"
    When I run "ctx onboard api-service"
    Then "wiki/onboarding/api-service.md" should list dependencies:
      | dependency        | relationship                    |
      | auth-service      | JWT validation and RBAC         |
      | payment-service   | Payment processing via gRPC     |

  Scenario Outline: Generate per-repo guides for each service
    When I run "ctx onboard <repo>"
    Then the wiki should contain "wiki/onboarding/<repo>.md"
    And the guide should be tailored to the "<repo>" repository

    Examples:
      | repo             |
      | api-service      |
      | auth-service     |
      | payment-service  |

  # ── Include conventions ─────────────────────────────────────────

  Scenario: Onboarding guides include project conventions
    Given the wiki contains a "wiki/conventions.md" page with:
      | convention                                          |
      | All API endpoints return JSON:API format            |
      | Use UTC timestamps everywhere                       |
      | Branch names follow pattern: type/TICKET-description|
      | All public functions must have JSDoc comments        |
    When I run "ctx onboard"
    Then "wiki/onboarding/start-here.md" should reference key conventions
    And "wiki/onboarding/first-pr.md" should include coding conventions

  # ── Regenerate onboarding ───────────────────────────────────────

  Scenario: Regenerate onboarding guides after wiki update
    Given onboarding guides were previously generated
    And the wiki has been updated with new information
    When I run "ctx onboard --refresh"
    Then all onboarding guides should be regenerated with current wiki content
    And the CLI should output "Onboarding guides refreshed (3 guides updated)"

  Scenario: Regenerate only a specific repo guide
    When I run "ctx onboard api-service --refresh"
    Then only "wiki/onboarding/api-service.md" should be regenerated

  # ── Edge cases ──────────────────────────────────────────────────

  Scenario: Onboard with empty wiki
    Given the wiki has not been compiled yet
    When I run "ctx onboard"
    Then the CLI should output "Wiki is empty. Run 'ctx ingest' first."
    And the exit code should be 1

  Scenario: Onboard for a non-existent repo
    When I run "ctx onboard nonexistent-service"
    Then the CLI should exit with error code 1
    And the error message should contain "Repository not found: nonexistent-service"

  Scenario: Onboard preserves manually edited guides
    Given "wiki/onboarding/start-here.md" has been manually edited
    When I run "ctx onboard"
    Then the CLI should detect the manual edits
    And the CLI should prompt "start-here.md has been manually edited. Overwrite? [y/N]"
