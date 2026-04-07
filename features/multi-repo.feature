@repos
Feature: Multi-repo workspace management
  As a developer working across multiple repositories
  I want to register and manage multiple repos in a single withctx workspace
  So that Claude can build cross-repo context and compile unified knowledge

  Background:
    Given a project initialized with "ctx init"
    And a valid "ctx.yaml" exists in the project root

  # ── Add repos ───────────────────────────────────────────────────

  Scenario: Add a remote repository by URL
    When I run "ctx repos add https://github.com/acme/api-service"
    Then the repository should be cloned into ".ctx/repos/api-service/"
    And the "ctx.yaml" should contain a repo entry for "api-service"
    And the CLI should output "Repository added: api-service (cloned)"

  Scenario: Add multiple repositories
    When I run "ctx repos add https://github.com/acme/api-service"
    And I run "ctx repos add https://github.com/acme/auth-service"
    And I run "ctx repos add https://github.com/acme/payment-service"
    Then the "ctx.yaml" should contain 3 repo entries:
      | name             | url                                        |
      | api-service      | https://github.com/acme/api-service        |
      | auth-service     | https://github.com/acme/auth-service       |
      | payment-service  | https://github.com/acme/payment-service    |
    And each repo should be cloned under ".ctx/repos/"

  Scenario: Add a repo with a custom name
    When I run "ctx repos add https://github.com/acme/api-service --name backend-api"
    Then the repository should be cloned into ".ctx/repos/backend-api/"
    And the "ctx.yaml" should contain a repo entry named "backend-api"

  Scenario: Add a local directory as a repo
    Given a directory exists at "../shared-libs"
    When I run "ctx repos add ../shared-libs"
    Then the "ctx.yaml" should contain a repo entry for "shared-libs"
    And the repo should be registered as a local path (not cloned)

  # ── List repos ──────────────────────────────────────────────────

  Scenario: List all registered repositories
    Given the workspace contains the following repos:
      | name             | url                                        | last_synced              |
      | api-service      | https://github.com/acme/api-service        | 2026-04-07T10:00:00Z     |
      | auth-service     | https://github.com/acme/auth-service       | 2026-04-07T09:30:00Z     |
      | payment-service  | https://github.com/acme/payment-service    | 2026-04-06T15:00:00Z     |
    When I run "ctx repos list"
    Then the output should display:
      | name             | status  | last_synced          |
      | api-service      | active  | 2026-04-07T10:00:00Z |
      | auth-service     | active  | 2026-04-07T09:30:00Z |
      | payment-service  | stale   | 2026-04-06T15:00:00Z |

  # ── Remove repos ───────────────────────────────────────────────

  Scenario: Remove a registered repository
    Given the workspace contains a repo named "auth-service"
    When I run "ctx repos remove auth-service"
    Then the "ctx.yaml" should no longer contain a repo entry for "auth-service"
    And the cloned directory ".ctx/repos/auth-service/" should be removed
    And the CLI should output "Repository removed: auth-service"

  Scenario: Remove a repo preserves other repos
    Given the workspace contains repos "api-service", "auth-service", "payment-service"
    When I run "ctx repos remove auth-service"
    Then the "ctx.yaml" should still contain repos "api-service" and "payment-service"

  # ── Cross-repo dependency detection ─────────────────────────────

  Scenario: Detect cross-repo dependencies via package.json
    Given the workspace contains the following repos:
      | name           | dependencies                        |
      | api-service    | @acme/shared-types, @acme/auth-sdk  |
      | auth-service   | @acme/shared-types                  |
      | shared-types   |                                     |
    When I run "ctx repos deps"
    Then the output should show the dependency graph:
      | repo           | depends_on                          |
      | api-service    | shared-types, auth-service          |
      | auth-service   | shared-types                        |
      | shared-types   |                                     |

  Scenario: Detect cross-repo service dependencies via imports
    Given the repo "api-service" contains files that import from "@acme/auth-sdk"
    And the repo "auth-service" publishes the "@acme/auth-sdk" package
    When I run "ctx repos deps"
    Then "api-service" should list "auth-service" as a dependency

  # ── Per-repo wiki pages ─────────────────────────────────────────

  Scenario: Wiki pages are generated per repository
    Given the workspace contains repos "api-service" and "auth-service"
    When I run "ctx ingest"
    Then the wiki should contain pages namespaced by repo:
      | page                              |
      | wiki/api-service/overview.md      |
      | wiki/api-service/architecture.md  |
      | wiki/auth-service/overview.md     |
      | wiki/auth-service/architecture.md |
    And the "wiki/index.md" should reference both repo sections

  Scenario: Per-repo wiki pages include cross-references
    Given the workspace contains repos "api-service" and "auth-service"
    And "api-service" depends on "auth-service"
    When I run "ctx ingest"
    Then the "wiki/api-service/overview.md" page should cross-reference "wiki/auth-service/overview.md"

  # ── Scoped packing per repo ─────────────────────────────────────

  Scenario: Pack context scoped to a single repo
    Given the workspace contains repos "api-service", "auth-service", "payment-service"
    When I run "ctx pack --scope api-service"
    Then the output should only include wiki pages under "wiki/api-service/"
    And cross-references to other repos should be included as summaries only

  Scenario: Pack context for all repos
    Given the workspace contains repos "api-service" and "auth-service"
    When I run "ctx pack"
    Then the output should include wiki pages for all repos
    And the cross-repo dependency graph should be included

  # ── Single-repo vs multi-repo ───────────────────────────────────

  Scenario: Single-repo project works without repo registration
    Given a project with no registered repos
    And the project contains source code in "src/"
    When I run "ctx ingest"
    Then the wiki should contain pages without repo namespace:
      | page                      |
      | wiki/overview.md          |
      | wiki/architecture.md      |
    And no ".ctx/repos/" directory should be created

  Scenario: Transition from single-repo to multi-repo
    Given a single-repo project with existing wiki pages:
      | page                  |
      | wiki/overview.md      |
      | wiki/architecture.md  |
    When I run "ctx repos add https://github.com/acme/auth-service"
    And I run "ctx ingest"
    Then the original wiki pages should be preserved
    And new pages should appear under "wiki/auth-service/"

  # ── Edge cases ──────────────────────────────────────────────────

  Scenario: Add a repo that is already registered
    Given the workspace contains a repo named "api-service"
    When I run "ctx repos add https://github.com/acme/api-service"
    Then the CLI should output "Repository already registered: api-service"
    And no duplicate entry should be created

  Scenario: Add a repo with an invalid URL
    When I run "ctx repos add https://github.com/acme/nonexistent-repo"
    Then the CLI should exit with error code 1
    And the error message should contain "Failed to clone repository"
