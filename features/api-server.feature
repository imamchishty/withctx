@api
Feature: REST API server
  As a developer integrating withctx into tooling and dashboards
  I want a REST API server exposing wiki operations
  So that I can programmatically query, pack, lint, and manage context

  Background:
    Given a project initialized with "ctx init"
    And the wiki has been compiled with "ctx ingest"
    And the API server is started with "ctx serve"
    And the server is listening on port 4400

  # ── Server startup ──────────────────────────────────────────────

  Scenario: Start the API server
    When I run "ctx serve"
    Then the server should start on port 4400
    And the CLI should output "withctx API server listening on http://localhost:4400"

  Scenario: Start the API server on a custom port
    When I run "ctx serve --port 8080"
    Then the server should start on port 8080
    And the CLI should output "withctx API server listening on http://localhost:8080"

  Scenario: Server fails if port is already in use
    Given port 4400 is already in use by another process
    When I run "ctx serve"
    Then the CLI should exit with error code 1
    And the error message should contain "Port 4400 is already in use"

  # ── GET /api/health ─────────────────────────────────────────────

  Scenario: Health check endpoint
    When I send a GET request to "http://localhost:4400/api/health"
    Then the response status should be 200
    And the response body should be:
      """
      {
        "status": "ok",
        "version": "0.1.0",
        "uptime": 123
      }
      """

  Scenario: Health check returns version from package.json
    When I send a GET request to "http://localhost:4400/api/health"
    Then the response body "version" field should match the package.json version

  # ── GET /api/status ─────────────────────────────────────────────

  Scenario: Status endpoint returns wiki and source status
    When I send a GET request to "http://localhost:4400/api/status"
    Then the response status should be 200
    And the response body should contain:
      | field               | type     |
      | project             | string   |
      | wikiPages           | number   |
      | wikiSizeBytes       | number   |
      | sourcesCount        | number   |
      | sources             | array    |
      | lastIngest          | string   |
      | lastSync            | string   |

  Scenario: Status endpoint includes per-source details
    When I send a GET request to "http://localhost:4400/api/status"
    Then the "sources" array should contain entries with:
      | field       | type    |
      | type        | string  |
      | identifier  | string  |
      | status      | string  |
      | lastSynced  | string  |

  # ── GET /api/pages ──────────────────────────────────────────────

  Scenario: List all wiki pages
    Given the wiki contains 8 pages
    When I send a GET request to "http://localhost:4400/api/pages"
    Then the response status should be 200
    And the response body should contain an array of 8 pages
    And each page should include:
      | field        | type    |
      | path         | string  |
      | title        | string  |
      | lastUpdated  | string  |
      | sizeBytes    | number  |

  Scenario: List pages with pagination
    Given the wiki contains 50 pages
    When I send a GET request to "http://localhost:4400/api/pages?limit=10&offset=0"
    Then the response should contain 10 pages
    And the response should include pagination metadata:
      | field  | value |
      | total  | 50    |
      | limit  | 10    |
      | offset | 0     |

  # ── GET /api/pages/:path ────────────────────────────────────────

  Scenario: Get a specific wiki page by path
    Given the wiki contains "wiki/api-service.md"
    When I send a GET request to "http://localhost:4400/api/pages/api-service.md"
    Then the response status should be 200
    And the response body should contain:
      | field        | type    |
      | path         | string  |
      | title        | string  |
      | content      | string  |
      | lastUpdated  | string  |
      | sources      | array   |
      | crossRefs    | array   |

  Scenario: Get a non-existent wiki page
    When I send a GET request to "http://localhost:4400/api/pages/nonexistent.md"
    Then the response status should be 404
    And the response body should contain:
      """
      {
        "error": "Page not found: nonexistent.md"
      }
      """

  Scenario: Get a nested wiki page by path
    Given the wiki contains "wiki/onboarding/start-here.md"
    When I send a GET request to "http://localhost:4400/api/pages/onboarding/start-here.md"
    Then the response status should be 200
    And the "path" field should be "wiki/onboarding/start-here.md"

  # ── POST /api/query ─────────────────────────────────────────────

  Scenario: Query the wiki via API
    When I send a POST request to "http://localhost:4400/api/query" with body:
      """
      {
        "query": "How does authentication work in the api-service?"
      }
      """
    Then the response status should be 200
    And the response body should contain:
      | field     | type    |
      | answer    | string  |
      | sources   | array   |
      | tokens    | number  |

  Scenario: Query with scope and token budget
    When I send a POST request to "http://localhost:4400/api/query" with body:
      """
      {
        "query": "What endpoints are available?",
        "scope": "api-service",
        "maxTokens": 1000
      }
      """
    Then the response status should be 200
    And the response "tokens" field should not exceed 1000

  Scenario: Query with empty body
    When I send a POST request to "http://localhost:4400/api/query" with body:
      """
      {}
      """
    Then the response status should be 400
    And the response body should contain:
      """
      {
        "error": "Missing required field: query"
      }
      """

  # ── POST /api/pack ──────────────────────────────────────────────

  Scenario: Pack wiki via API
    When I send a POST request to "http://localhost:4400/api/pack" with body:
      """
      {
        "format": "claude",
        "maxTokens": 8000
      }
      """
    Then the response status should be 200
    And the response body should contain:
      | field     | type    |
      | content   | string  |
      | format    | string  |
      | tokens    | number  |

  Scenario: Pack with scope via API
    When I send a POST request to "http://localhost:4400/api/pack" with body:
      """
      {
        "format": "openai",
        "scope": "auth-service",
        "maxTokens": 4000
      }
      """
    Then the response status should be 200
    And the "format" field should be "openai"

  Scenario: Pack with unsupported format via API
    When I send a POST request to "http://localhost:4400/api/pack" with body:
      """
      {
        "format": "xml"
      }
      """
    Then the response status should be 400
    And the response body should contain:
      """
      {
        "error": "Unsupported format: xml. Use claude, openai, or markdown."
      }
      """

  # ── POST /api/add ───────────────────────────────────────────────

  Scenario: Add a manual note via API
    When I send a POST request to "http://localhost:4400/api/add" with body:
      """
      {
        "content": "Auth tokens expire after 1 hour, not 24 hours",
        "type": "correction",
        "tags": ["auth", "security"]
      }
      """
    Then the response status should be 201
    And the response body should contain:
      | field     | type    |
      | id        | string  |
      | type      | string  |
      | content   | string  |
      | tags      | array   |
      | addedAt   | string  |

  Scenario: Add a note with missing content
    When I send a POST request to "http://localhost:4400/api/add" with body:
      """
      {
        "type": "decision"
      }
      """
    Then the response status should be 400
    And the response body should contain:
      """
      {
        "error": "Missing required field: content"
      }
      """

  # ── POST /api/lint ──────────────────────────────────────────────

  Scenario: Lint the wiki via API
    When I send a POST request to "http://localhost:4400/api/lint" with body:
      """
      {}
      """
    Then the response status should be 200
    And the response body should contain:
      | field            | type    |
      | contradictions   | array   |
      | stale            | array   |
      | orphans          | array   |
      | missing          | array   |
      | summary          | object  |

  Scenario: Lint specific categories via API
    When I send a POST request to "http://localhost:4400/api/lint" with body:
      """
      {
        "only": ["contradictions", "stale"]
      }
      """
    Then the response status should be 200
    And the response should only include "contradictions" and "stale" arrays
    And "orphans" and "missing" should be empty arrays

  # ── POST /api/ingest ────────────────────────────────────────────

  Scenario: Trigger ingest via API
    When I send a POST request to "http://localhost:4400/api/ingest" with body:
      """
      {}
      """
    Then the response status should be 200
    And the response body should contain:
      | field           | type    |
      | pagesCreated    | number  |
      | pagesUpdated    | number  |
      | pagesUnchanged  | number  |
      | sourcesProcessed| number  |
      | tokensUsed      | number  |
      | duration        | number  |

  Scenario: Trigger incremental ingest via API
    When I send a POST request to "http://localhost:4400/api/ingest" with body:
      """
      {
        "full": false
      }
      """
    Then the response status should be 200
    And only changed sources should be processed

  # ── Error handling ──────────────────────────────────────────────

  Scenario: Invalid JSON body returns 400
    When I send a POST request to "http://localhost:4400/api/query" with invalid JSON
    Then the response status should be 400
    And the response body should contain:
      """
      {
        "error": "Invalid JSON in request body"
      }
      """

  Scenario: Unknown endpoint returns 404
    When I send a GET request to "http://localhost:4400/api/unknown"
    Then the response status should be 404
    And the response body should contain:
      """
      {
        "error": "Not found"
      }
      """

  Scenario: Server returns CORS headers
    When I send an OPTIONS request to "http://localhost:4400/api/query"
    Then the response should include CORS headers:
      | header                       | value |
      | Access-Control-Allow-Origin  | *     |
      | Access-Control-Allow-Methods | GET, POST, OPTIONS |
