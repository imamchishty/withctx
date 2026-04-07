@teams
Feature: Microsoft Teams connector
  As a developer whose team communicates via Microsoft Teams
  I want to ingest relevant Teams messages, decisions, and meeting transcripts
  So that conversational knowledge is captured in the compiled wiki

  Background:
    Given a project initialized with "ctx init"
    And a "teams" source is configured in "ctx.yaml" with:
      | setting   | value                     |
      | team      | Engineering               |
      | channel   | general                   |
      | auth      | Microsoft Graph API token |

  # ── Connect via Microsoft Graph API ─────────────────────────────

  Scenario: Connect to Microsoft Teams via Graph API
    Given valid Microsoft Graph API credentials are configured
    When I run "ctx sources add teams --team 'Engineering' --channel 'general'"
    Then the CLI should authenticate with the Microsoft Graph API
    And the CLI should output "Connected to Teams: Engineering/general"
    And the "ctx.yaml" should contain a teams source entry

  Scenario: Connect to multiple Teams channels
    When I run "ctx sources add teams --team 'Engineering' --channel 'general'"
    And I run "ctx sources add teams --team 'Engineering' --channel 'architecture'"
    And I run "ctx sources add teams --team 'Engineering' --channel 'incidents'"
    Then the "ctx.yaml" should contain 3 teams sources:
      | team         | channel       |
      | Engineering  | general       |
      | Engineering  | architecture  |
      | Engineering  | incidents     |

  Scenario: Connection fails with invalid credentials
    Given the Microsoft Graph API token is invalid
    When I run "ctx sources add teams --team 'Engineering' --channel 'general'"
    Then the CLI should exit with error code 1
    And the error message should contain "Microsoft Graph API authentication failed"

  Scenario: Connection fails with insufficient permissions
    Given the Microsoft Graph API token lacks Teams read permissions
    When I run "ctx sources add teams --team 'Engineering' --channel 'general'"
    Then the CLI should exit with error code 1
    And the error message should contain "Insufficient permissions: ChannelMessage.Read.All required"

  # ── Noise filtering ────────────────────────────────────────────

  Scenario: Filter out greeting messages
    Given the Teams channel contains the following messages:
      | author       | content                                           | type      |
      | Alice Chen   | Good morning everyone!                             | greeting  |
      | Bob Smith    | Hey team                                          | greeting  |
      | Carol Jones  | We need to migrate auth to OIDC by end of sprint  | decision  |
      | Dave Wilson  | Hi all                                            | greeting  |
    When I run "ctx ingest"
    Then the greeting messages should be filtered out
    And the decision message from Carol should be included in the wiki

  Scenario: Filter out reaction-only messages
    Given the Teams channel contains:
      | author       | content  | reactions |
      | Alice Chen   | +1       |           |
      | Bob Smith    |          | thumbsup  |
      | Carol Jones  | Agreed   |           |
    When I run "ctx ingest"
    Then reaction-only and short affirmation messages should be filtered out

  Scenario: Filter out short messages below threshold
    Given the Teams channel contains messages:
      | author       | content                                                    | length |
      | Alice Chen   | ok                                                         | 2      |
      | Bob Smith    | thanks                                                     | 6      |
      | Carol Jones  | The new caching layer reduced p99 latency by 40%          | 52     |
      | Dave Wilson  | lol                                                        | 3      |
    When I run "ctx ingest"
    Then messages shorter than 20 characters should be filtered out
    And Carol's message about caching should be included

  Scenario: Filter out bot messages
    Given the Teams channel contains messages:
      | author              | content                                    | is_bot |
      | Jira Bot            | ACME-123 moved to Done                     | true   |
      | GitHub Bot          | PR #456 merged                              | true   |
      | Alice Chen          | We decided to use gRPC for service mesh    | false  |
      | Azure DevOps Bot    | Build succeeded                             | true   |
    When I run "ctx ingest"
    Then bot messages should be filtered out by default
    And Alice's decision message should be included

  Scenario: Include bot messages with flag
    When I run "ctx ingest --include-bots"
    Then bot messages should also be processed

  # ── Extract decisions from threads ──────────────────────────────

  Scenario: Extract decisions from threaded discussions
    Given the Teams channel contains a thread:
      | author       | content                                                      | is_reply |
      | Alice Chen   | Should we use Redis or Memcached for session caching?        | false    |
      | Bob Smith    | Redis gives us persistence and pub/sub which we need         | true     |
      | Carol Jones  | Agreed, Redis also supports sorted sets for rate limiting    | true     |
      | Alice Chen   | Decision: We will use Redis for session caching              | true     |
    When I run "ctx ingest"
    Then the wiki should contain a decision entry:
      | decision            | context                                      |
      | Use Redis for sessions | Persistence, pub/sub, sorted sets needed  |
    And the decision should be attributed to the thread participants

  Scenario: Identify decisions by keyword patterns
    Given the Teams channel contains messages with decision indicators:
      | content                                                         |
      | Decision: We will migrate to PostgreSQL 16                      |
      | Agreed: All new services must use TypeScript                    |
      | Final call: deploying auth-service v2.1 on Thursday             |
      | Let's go with option B — event sourcing for the order service   |
    When I run "ctx ingest"
    Then each message should be identified as a decision
    And decisions should appear in "wiki/decisions.md"

  # ── Meeting transcripts ─────────────────────────────────────────

  Scenario: Ingest meeting transcripts from Teams
    Given the Teams channel contains a meeting recording with transcript:
      | meeting             | date                 | duration | participants                |
      | Sprint Planning     | 2026-04-07T10:00:00Z | 45min    | Alice, Bob, Carol, Dave     |
    And the transcript contains discussions about:
      | topic                           |
      | Auth service migration timeline |
      | New caching strategy            |
      | API versioning approach         |
    When I run "ctx ingest"
    Then the wiki should contain a page for the meeting
    And the page should summarize key discussion topics
    And action items should be extracted

  Scenario: Meeting transcript extracts action items
    Given a meeting transcript contains:
      | speaker      | content                                                      |
      | Alice Chen   | Bob, can you update the auth service docs by Friday?         |
      | Bob Smith    | Sure, I will also add the migration guide                    |
      | Carol Jones  | I will benchmark the new caching approach this sprint        |
    When I run "ctx ingest"
    Then the wiki should capture action items:
      | assignee     | action                                  | deadline   |
      | Bob Smith    | Update auth service docs                | Friday     |
      | Bob Smith    | Add migration guide                     | Friday     |
      | Carol Jones  | Benchmark new caching approach          | This sprint|

  # ── Shared files via respective connectors ──────────────────────

  Scenario: Process shared PDF files from Teams
    Given a Teams message contains a shared file "architecture-v2.pdf"
    When I run "ctx ingest"
    Then the shared PDF should be downloaded and processed via the PDF connector
    And the wiki should include content from the PDF
    And the source should be attributed to "teams:Engineering/general/architecture-v2.pdf"

  Scenario: Process shared Word documents from Teams
    Given a Teams message contains a shared file "runbook-update.docx"
    When I run "ctx ingest"
    Then the shared Word document should be processed via the Word connector
    And the wiki should include content from the document

  Scenario: Process shared Excel files from Teams
    Given a Teams message contains a shared file "team-roster-updated.xlsx"
    When I run "ctx ingest"
    Then the shared Excel file should be processed via the Excel connector
    And the "wiki/people.md" page should be updated

  Scenario: Process shared PowerPoint from Teams
    Given a Teams message contains a shared file "quarterly-review.pptx"
    When I run "ctx ingest"
    Then the shared PPTX should be processed via the PPTX connector

  # ── Channel filtering ──────────────────────────────────────────

  Scenario: Filter messages by date range
    When I run "ctx sync --source teams --since 2026-04-01"
    Then only messages from April 1st onwards should be processed

  Scenario: Filter messages by author
    When I run "ctx sync --source teams --author 'Alice Chen'"
    Then only messages from Alice Chen should be processed

  # ── Edge cases ──────────────────────────────────────────────────

  Scenario: Teams channel with no messages
    Given the Teams channel "architecture" has no messages
    When I run "ctx ingest"
    Then the CLI should output "teams:Engineering/architecture — no messages found"
    And no wiki pages should be generated for that channel

  Scenario: Teams API rate limiting
    Given the Microsoft Graph API returns a 429 rate limit response
    When I run "ctx ingest"
    Then the CLI should retry with exponential backoff
    And the CLI should output "Rate limited by Teams API — retrying in 5s"
