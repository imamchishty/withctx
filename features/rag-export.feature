@rag @export
Feature: RAG-ready exports
  As an engineer building RAG pipelines
  I want to export wiki content in LangChain, LlamaIndex, and chunked JSON formats
  So that I can feed the wiki into any vector database or RAG framework

  Background:
    Given a withctx project with compiled wiki pages

  Scenario: Export as RAG JSON chunks
    When I run "ctx export --format rag-json"
    Then a JSON file with chunked wiki content should be saved
    And each chunk should have id, content, and metadata

  Scenario: Export as LangChain Documents
    When I run "ctx export --format langchain"
    Then a JSON file with LangChain Document objects should be saved
    And each document should have page_content and metadata

  Scenario: Export as LlamaIndex TextNodes
    When I run "ctx export --format llamaindex"
    Then a JSON file with LlamaIndex TextNode objects should be saved
    And nodes should have relationships linking to source and neighbors

  Scenario: Custom chunk size
    When I run "ctx export --format rag-json --chunk-size 256"
    Then chunks should be approximately 256 words each

  Scenario: RAG export with scope
    When I run "ctx export --format langchain --scope repos/api-service"
    Then only api-service pages should be included

  Scenario: RAG export with budget
    When I run "ctx export --format rag-json --budget 50000"
    Then chunks should not exceed 50000 tokens total

  Scenario: RAG export is free
    When I run "ctx export --format langchain"
    Then no Claude API call should be made

  Scenario: Snapshot RAG export
    When I run "ctx export --format rag-json --snapshot"
    Then a timestamped file should be saved in .ctx/exports/snapshots/
