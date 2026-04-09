@vector
Feature: Vector embeddings and semantic search
  As an engineer
  I want to search the wiki semantically
  So that I can find relevant context even with different wording

  Background:
    Given a withctx project with compiled wiki pages

  Scenario: Embed all wiki pages
    When I run "ctx embed"
    Then all wiki pages should be chunked and embedded
    And I should see the number of chunks created

  Scenario: Embed uses local TF-IDF by default
    Given no OPENAI_API_KEY is set
    When I run "ctx embed"
    Then local TF-IDF embeddings should be used
    And no external API call should be made

  Scenario: Embed with OpenAI provider
    Given OPENAI_API_KEY is set
    When I run "ctx embed --provider openai"
    Then OpenAI text-embedding-3-small should be used

  Scenario: Embed with in-memory store
    When I run "ctx embed --store memory"
    Then embeddings should be stored in .ctx/vector/index.json

  Scenario: Embed with ChromaDB
    Given a Chroma instance is running on localhost:8000
    When I run "ctx embed --store chroma"
    Then embeddings should be stored in ChromaDB

  Scenario: Search by natural language
    Given the wiki has been embedded
    When I run "ctx search 'how does authentication work'"
    Then I should see relevant wiki chunks ranked by similarity

  Scenario: Search with limit
    Given the wiki has been embedded
    When I run "ctx search 'deployment' --limit 3"
    Then I should see at most 3 results

  Scenario: Search with source filter
    Given the wiki has been embedded
    When I run "ctx search 'API endpoints' --source repos/api-service"
    Then results should only come from repos/api-service pages

  Scenario: Search is free when using local embeddings
    Given local TF-IDF embeddings are configured
    When I run "ctx search 'anything'"
    Then no external API call should be made

  Scenario: Incremental embedding on sync
    Given the wiki has been embedded
    And 2 wiki pages have been updated
    When I run "ctx embed"
    Then only the 2 updated pages should be re-embedded
