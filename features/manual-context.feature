@manual
Feature: User-added manual context
  As a developer with knowledge not captured in source code
  I want to add manual notes, decisions, and corrections to the wiki
  So that Claude can integrate tribal knowledge into the compiled context

  Background:
    Given a project initialized with "ctx init"
    And the wiki has been compiled with "ctx ingest"

  # ── Quick notes ─────────────────────────────────────────────────

  Scenario: Add a quick inline note
    When I run "ctx add 'The auth-service uses RS256 for JWT signing, not HS256'"
    Then a note should be stored in ".ctx/notes/"
    And the note should have type "context"
    And the CLI should output "Note added — will be integrated on next ingest"

  Scenario: Add a quick note with automatic topic detection
    When I run "ctx add 'Payment webhooks must be idempotent — Stripe sends duplicates'"
    Then the note should be associated with the "payment-service" topic
    And the note should be stored with detected topic metadata

  # ── Typed notes ─────────────────────────────────────────────────

  Scenario Outline: Add a typed note
    When I run "ctx add --type <type> '<content>'"
    Then a note should be stored with type "<type>"
    And the note metadata should include the type "<type>"
    And the CLI should output "Note added (<type>) — will be integrated on next ingest"

    Examples:
      | type       | content                                                        |
      | decision   | We chose PostgreSQL over DynamoDB for transactional guarantees |
      | convention | All API endpoints must return JSON:API format responses        |
      | context    | The legacy billing system is being sunset by Q4 2026           |
      | correction | Auth tokens expire after 1 hour, not 24 hours as documented   |

  Scenario: Decision notes include rationale
    When I run "ctx add --type decision 'Adopted event sourcing for the order service because we need full audit trails and the ability to replay state'"
    Then the note should be stored with type "decision"
    And the note should capture both the decision and the rationale

  # ── Corrections override stale source content ───────────────────

  Scenario: Correction overrides existing wiki content
    Given the wiki page "wiki/auth-service.md" states "tokens expire after 24 hours"
    When I run "ctx add --type correction 'Auth tokens expire after 1 hour, not 24 hours'"
    And I run "ctx ingest"
    Then "wiki/auth-service.md" should reflect the corrected expiry of 1 hour
    And the correction should be attributed as a manual override

  Scenario: Correction takes precedence over source content
    Given the source file "src/config.ts" contains a comment "// Cache TTL: 300s"
    And a correction note states "Cache TTL was changed to 600s in production"
    When I run "ctx ingest"
    Then the wiki should reflect the correction value of 600s
    And the wiki should note the discrepancy between source and correction

  Scenario: Multiple corrections for the same topic
    When I run "ctx add --type correction 'API rate limit is 1000/min, not 500/min'"
    And I run "ctx add --type correction 'API rate limit was increased to 2000/min'"
    And I run "ctx ingest"
    Then the most recent correction should take precedence
    And the wiki should reflect the 2000/min rate limit

  # ── Add from file ───────────────────────────────────────────────

  Scenario: Add a note from a file
    Given a file "/tmp/architecture-decision.md" contains:
      """
      # ADR-042: Switch to gRPC for inter-service communication

      ## Status
      Accepted

      ## Context
      REST calls between services are adding 50ms+ latency per hop.

      ## Decision
      Migrate inter-service communication to gRPC with Protocol Buffers.

      ## Consequences
      - Need to maintain .proto files
      - Faster serialization and lower latency
      - Streaming support for real-time features
      """
    When I run "ctx add --file /tmp/architecture-decision.md --type decision"
    Then the note should be stored with the full file content
    And the note should be typed as "decision"
    And the CLI should output "Note added from file (decision)"

  Scenario: Add a note from a file with auto-type detection
    Given a file "/tmp/note.md" contains content about a convention
    When I run "ctx add --file /tmp/note.md"
    Then the note type should be auto-detected based on content

  # ── Add via $EDITOR ─────────────────────────────────────────────

  Scenario: Add a note via editor
    Given the environment variable EDITOR is set to "vim"
    When I run "ctx add --edit"
    Then the CLI should open the editor with a note template
    And the template should include fields for type and content
    When the user saves and closes the editor
    Then the note should be stored with the edited content

  Scenario: Add a typed note via editor
    When I run "ctx add --edit --type decision"
    Then the editor template should be pre-filled with type "decision"
    And the template should include prompts for decision rationale

  # ── Tagged notes ────────────────────────────────────────────────

  Scenario: Add a note with tags
    When I run "ctx add --tags auth,security 'OAuth2 PKCE flow is required for all public clients'"
    Then the note should be stored with tags:
      | tag      |
      | auth     |
      | security |

  Scenario: Add a note with tags and type
    When I run "ctx add --type convention --tags api,versioning 'All API versions must be in the URL path, e.g. /v1/users'"
    Then the note should have type "convention" and tags "api", "versioning"

  Scenario: Filter notes by tag
    Given the following notes exist:
      | content                             | tags          |
      | Use UTC everywhere                  | convention    |
      | OAuth2 PKCE required                | auth,security |
      | PostgreSQL for transactions          | database      |
      | JWT RS256 signing                    | auth          |
    When I run "ctx notes list --tag auth"
    Then the output should show 2 notes tagged with "auth"

  # ── Claude integrates notes into wiki pages ─────────────────────

  Scenario: Manual notes are integrated into relevant wiki pages
    Given the following notes exist:
      | content                                                  | type       | tags     |
      | Auth tokens expire after 1 hour                          | correction | auth     |
      | All endpoints must use JSON:API format                   | convention | api      |
      | Chose PostgreSQL for transactional guarantees            | decision   | database |
    When I run "ctx ingest"
    Then "wiki/auth-service.md" should incorporate the auth correction
    And "wiki/api-service.md" should incorporate the API convention
    And "wiki/overview.md" should reference the PostgreSQL decision

  Scenario: Convention notes appear in a dedicated conventions page
    Given 5 convention notes have been added
    When I run "ctx ingest"
    Then "wiki/conventions.md" should exist
    And it should list all 5 conventions in a structured format

  Scenario: Decision notes appear in a decisions page
    Given 3 decision notes have been added
    When I run "ctx ingest"
    Then "wiki/decisions.md" should exist
    And each decision should include the rationale and date

  # ── List and manage notes ───────────────────────────────────────

  Scenario: List all manual notes
    Given 5 notes have been added
    When I run "ctx notes list"
    Then the output should display all 5 notes with:
      | field     |
      | id        |
      | type      |
      | content   |
      | tags      |
      | added_at  |

  Scenario: Remove a manual note
    Given a note exists with id "note-001"
    When I run "ctx notes remove note-001"
    Then the note should be deleted from ".ctx/notes/"
    And the CLI should output "Note removed: note-001"
