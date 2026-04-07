@query
Feature: One-off context queries
  As a developer needing quick answers about my project
  I want to query the compiled wiki with natural language
  So that I get accurate, source-attributed answers without manual searching

  Background:
    Given a project initialized with "ctx init"
    And the wiki has been compiled with "ctx ingest"
    And the wiki contains pages for "api-service", "auth-service", "payment-service", and "conventions"

  # ── Natural language queries ────────────────────────────────────

  Scenario: Query about a specific service
    When I run "ctx query 'How does authentication work in the api-service?'"
    Then the response should describe the authentication mechanism
    And the response should reference "wiki/auth-service.md"
    And the response should include source attribution

  Scenario: Query about project conventions
    When I run "ctx query 'What are the API naming conventions?'"
    Then the response should reference "wiki/conventions.md"
    And the response should list the relevant conventions

  Scenario: Query about cross-service dependencies
    When I run "ctx query 'What services does payment-service depend on?'"
    Then the response should list the dependencies of "payment-service"
    And the response should reference wiki pages for each dependency

  Scenario: Query with no matching context
    When I run "ctx query 'What is the deployment process for Kubernetes?'"
    And the wiki contains no information about Kubernetes deployments
    Then the response should indicate the information is not available
    And the response should suggest running "ctx ingest" or adding relevant sources

  # ── Source attribution ──────────────────────────────────────────

  Scenario: Response includes source attribution
    When I run "ctx query 'What port does the api-service run on?'"
    Then the response should include a "Sources" section
    And the sources should list specific wiki pages:
      | source                 |
      | wiki/api-service.md    |
    And each source should include the relevant section heading

  Scenario: Response attributes multiple sources
    When I run "ctx query 'How do services communicate with each other?'"
    Then the response should reference multiple wiki pages
    And each claim in the response should have a source attribution

  # ── Save answer as wiki page ────────────────────────────────────

  Scenario: Save query answer as a new wiki page
    When I run "ctx query 'Summarize the authentication flow end-to-end' --save"
    Then a new wiki page should be created at "wiki/auth-flow-summary.md"
    And the page should contain the query answer
    And "wiki/index.md" should be updated to include the new page
    And the CLI should output "Answer saved to wiki/auth-flow-summary.md"

  Scenario: Save query answer with a custom filename
    When I run "ctx query 'What is the database schema?' --save --output wiki/database-schema.md"
    Then the answer should be saved to "wiki/database-schema.md"

  Scenario: Saved answer includes metadata
    When I run "ctx query 'How does rate limiting work?' --save"
    Then the saved page should include metadata:
      | field         | value                           |
      | generated_by  | ctx query                       |
      | query         | How does rate limiting work?     |
      | generated_at  | 2026-04-07T...                  |
      | sources       | wiki/api-service.md             |

  # ── Scoped queries ─────────────────────────────────────────────

  Scenario: Query scoped to a specific repo
    Given the workspace contains repos "api-service" and "auth-service"
    When I run "ctx query 'What endpoints are available?' --scope api-service"
    Then the response should only reference pages under "wiki/api-service/"
    And the response should not include information from "auth-service"

  Scenario: Query scoped to a wiki section
    When I run "ctx query 'What conventions apply to error handling?' --scope conventions"
    Then the response should primarily reference "wiki/conventions.md"

  Scenario: Scoped query with no results in scope
    When I run "ctx query 'What is the payment flow?' --scope auth-service"
    Then the response should indicate no relevant information in the specified scope
    And the response should suggest broadening the scope

  # ── Token budget ────────────────────────────────────────────────

  Scenario Outline: Query with token budget
    When I run "ctx query 'Describe the system architecture' --max-tokens <budget>"
    Then the response should not exceed <budget> tokens
    And the response should still include source attribution

    Examples:
      | budget |
      | 500    |
      | 1000   |
      | 2000   |
      | 4000   |

  Scenario: Token budget produces concise responses
    When I run "ctx query 'Describe the system architecture' --max-tokens 500"
    Then the response should be a concise summary
    And the response should prioritize the most important architectural points

  # ── API endpoint ────────────────────────────────────────────────

  Scenario: Query via REST API
    Given the API server is running on port 4400
    When I send a POST request to "http://localhost:4400/api/query" with body:
      """
      {
        "query": "How does authentication work?",
        "scope": null,
        "maxTokens": 2000
      }
      """
    Then the response status should be 200
    And the response body should contain:
      | field     |
      | answer    |
      | sources   |
      | tokens    |

  Scenario: API query with scope parameter
    Given the API server is running on port 4400
    When I send a POST request to "http://localhost:4400/api/query" with body:
      """
      {
        "query": "What endpoints are available?",
        "scope": "api-service",
        "maxTokens": 1000
      }
      """
    Then the response should only contain information from the "api-service" scope

  # ── Edge cases ──────────────────────────────────────────────────

  Scenario: Query before wiki is compiled
    Given the wiki has not been compiled yet
    When I run "ctx query 'How does authentication work?'"
    Then the CLI should output "Wiki is empty. Run 'ctx ingest' first."
    And the exit code should be 1

  Scenario: Query with empty string
    When I run "ctx query ''"
    Then the CLI should exit with error code 1
    And the error message should contain "Query cannot be empty"
