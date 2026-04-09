@multi-provider
Feature: Multi-provider AI support
  As an engineer
  I want to choose my LLM provider
  So that I am not locked into a single vendor

  Background:
    Given a withctx project

  Scenario: Default to Anthropic when ANTHROPIC_API_KEY is set
    Given ANTHROPIC_API_KEY is set
    When I run any LLM-powered command
    Then Anthropic Claude should be used as the provider

  Scenario: Auto-detect OpenAI when only OPENAI_API_KEY is set
    Given OPENAI_API_KEY is set
    And ANTHROPIC_API_KEY is not set
    When I run "ctx query 'test'"
    Then OpenAI GPT-4o should be used

  Scenario: Auto-detect Google when only GOOGLE_API_KEY is set
    Given GOOGLE_API_KEY is set
    And ANTHROPIC_API_KEY and OPENAI_API_KEY are not set
    When I run "ctx query 'test'"
    Then Google Gemini should be used

  Scenario: Fall back to Ollama when no API keys are set
    Given no API keys are set
    And Ollama is running locally
    When I run "ctx query 'test'"
    Then Ollama should be used with llama3

  Scenario: Configure provider in ctx.yaml
    Given ctx.yaml has ai.provider set to "openai"
    When I run "ctx query 'test'"
    Then OpenAI should be used regardless of env vars

  Scenario: Per-operation model override
    Given ctx.yaml has ai.models.ingest set to "gpt-4o-mini"
    When I run "ctx ingest"
    Then gpt-4o-mini should be used for ingestion

  Scenario: Cross-provider model override
    Given ctx.yaml has ai.provider set to "anthropic"
    And ai.models.ingest set to "gpt-4o-mini"
    When I run "ctx ingest"
    Then OpenAI should be used for ingest while Anthropic is used for other operations

  Scenario: Ollama custom base URL
    Given ctx.yaml has ai.base_url set to "http://remote-server:11434"
    When I run "ctx query 'test'"
    Then Ollama should connect to the remote server
