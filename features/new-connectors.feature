@connectors
Feature: OpenAPI, Notion, and Slack connectors
  As an engineer
  I want to ingest API specs, Notion pages, and Slack threads
  So that API docs, team knowledge, and discussions are in the wiki

  # --- OpenAPI Connector ---

  Scenario: Connect OpenAPI spec from local file
    Given a ctx.yaml with an OpenAPI source pointing to "api-spec.yaml"
    When I run "ctx doctor"
    Then I should see the OpenAPI source as connected

  Scenario: Connect OpenAPI spec from URL
    Given a ctx.yaml with an OpenAPI source pointing to a URL
    When I run "ctx doctor"
    Then I should see the OpenAPI source as connected

  Scenario: Ingest OpenAPI 3.x spec
    Given an OpenAPI 3.0 spec with 25 endpoints
    When I run "ctx ingest"
    Then the wiki should contain API overview, per-tag endpoint docs, and data models

  Scenario: Ingest Swagger 2.0 spec
    Given a Swagger 2.0 spec
    When I run "ctx ingest"
    Then the wiki should contain the same structured API documentation

  Scenario: OpenAPI generates endpoint tables
    Given an OpenAPI spec with parameters, request bodies, and responses
    When I run "ctx ingest"
    Then each endpoint should have parameter tables and example JSON

  Scenario: OpenAPI incremental sync
    Given a previous sync of the API spec
    And the spec file has not been modified
    When I run "ctx sync"
    Then the OpenAPI source should be skipped

  # --- Notion Connector ---

  Scenario: Connect Notion database
    Given a ctx.yaml with a Notion source and NOTION_TOKEN is set
    When I run "ctx doctor"
    Then I should see the Notion source as connected

  Scenario: Ingest Notion database pages
    Given a Notion database with 15 pages
    When I run "ctx ingest"
    Then all 15 pages should be converted to markdown in the wiki

  Scenario: Notion page properties as metadata
    Given a Notion page with select, date, and text properties
    When I run "ctx ingest"
    Then the properties should appear as metadata in the wiki page

  Scenario: Notion incremental sync
    Given a previous sync fetched 10 Notion pages
    And 3 pages have been edited since
    When I run "ctx sync"
    Then only the 3 edited pages should be re-fetched

  Scenario: Missing Notion token
    Given NOTION_TOKEN is not set
    When I run "ctx doctor"
    Then I should see an error for the Notion source

  # --- Slack Connector ---

  Scenario: Connect Slack channels
    Given a ctx.yaml with a Slack source and SLACK_TOKEN is set
    When I run "ctx doctor"
    Then I should see the Slack source as connected

  Scenario: Ingest Slack messages with noise filtering
    Given a Slack channel with 200 messages
    And 50 are greetings, reactions, or bot messages
    When I run "ctx ingest"
    Then only substantive messages should appear in the wiki

  Scenario: Slack threads become documents
    Given a Slack thread with 5+ replies
    When I run "ctx ingest"
    Then the thread should become a standalone wiki document

  Scenario: Slack channel summary
    Given a Slack channel with discussions
    When I run "ctx ingest"
    Then a channel summary page should be created

  Scenario: Slack since filter
    Given ctx.yaml has slack with since "7d"
    When I run "ctx ingest"
    Then only messages from the last 7 days should be fetched

  Scenario: Missing Slack token
    Given SLACK_TOKEN is not set
    When I run "ctx doctor"
    Then I should see an error for the Slack source
