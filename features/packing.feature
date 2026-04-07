@pack
Feature: LLM-ready context packing
  As a developer preparing context for LLM consumption
  I want to pack the compiled wiki into various output formats
  So that I can feed project context to Claude, OpenAI, or other LLM tools

  Background:
    Given a project initialized with "ctx init"
    And the wiki has been compiled with "ctx ingest"
    And the wiki contains pages for "api-service", "auth-service", "payment-service", "conventions", and "people"

  # ── CLAUDE.md format ────────────────────────────────────────────

  Scenario: Pack as CLAUDE.md format
    When I run "ctx pack --format claude"
    Then the output should be in CLAUDE.md format
    And the output should begin with a project summary section
    And the output should contain wiki content organized by section
    And the output should include code conventions
    And the output should include key architectural decisions

  Scenario: CLAUDE.md format includes structured sections
    When I run "ctx pack --format claude"
    Then the output should contain the following sections:
      | section              |
      | Project Overview     |
      | Architecture         |
      | Services             |
      | Conventions          |
      | Key Decisions        |
      | Cross-References     |

  Scenario: CLAUDE.md format is the default
    When I run "ctx pack"
    Then the output format should default to "claude"

  # ── OpenAI system prompt format ─────────────────────────────────

  Scenario: Pack as OpenAI system prompt
    When I run "ctx pack --format openai"
    Then the output should be formatted as a system prompt
    And the output should begin with "You are an assistant with knowledge of the following project:"
    And the output should contain the wiki content in a flat structure

  Scenario: OpenAI format is concise for token efficiency
    When I run "ctx pack --format openai --max-tokens 4000"
    Then the output should prioritize high-level architecture
    And the output should use compact formatting

  # ── Generic markdown format ─────────────────────────────────────

  Scenario: Pack as generic markdown
    When I run "ctx pack --format markdown"
    Then the output should be standard Markdown
    And the output should contain all wiki pages concatenated with headings
    And each section should include a page separator

  # ── Token budget enforcement ────────────────────────────────────

  Scenario Outline: Pack with token budget
    When I run "ctx pack --max-tokens <budget>"
    Then the output should not exceed <budget> tokens
    And the output should prioritize the most important content
    And the output should include a "truncated" indicator if content was cut

    Examples:
      | budget  |
      | 2000    |
      | 4000    |
      | 8000    |
      | 16000   |
      | 32000   |

  Scenario: Token budget prioritizes core architecture
    When I run "ctx pack --max-tokens 2000"
    Then the output should include:
      | content_type   |
      | overview       |
      | architecture   |
      | conventions    |
    And detailed service pages should be summarized or omitted

  Scenario: Pack without token budget includes all content
    When I run "ctx pack"
    Then the output should include all wiki content
    And no content should be truncated

  # ── Scoped packing ─────────────────────────────────────────────

  Scenario: Pack scoped to a single repo
    Given the workspace contains repos "api-service" and "auth-service"
    When I run "ctx pack --scope api-service"
    Then the output should only include wiki pages related to "api-service"
    And cross-references to other repos should be included as brief summaries

  Scenario: Pack scoped to a wiki section
    When I run "ctx pack --scope conventions"
    Then the output should primarily include content from "wiki/conventions.md"
    And related content should be included for context

  Scenario: Pack scoped to multiple sections
    When I run "ctx pack --scope api-service,auth-service"
    Then the output should include wiki pages for both services
    And shared dependencies should be included

  # ── Query-focused packing ───────────────────────────────────────

  Scenario: Pack focused on a specific query
    When I run "ctx pack --query 'How does authentication work?'"
    Then the output should prioritize auth-related wiki content
    And less relevant pages should be summarized or omitted
    And the output should be optimized for answering the query

  Scenario: Query-focused pack with token budget
    When I run "ctx pack --query 'What are the API conventions?' --max-tokens 4000"
    Then the output should prioritize "wiki/conventions.md" and "wiki/api-service.md"
    And the output should not exceed 4000 tokens

  # ── Write to file ───────────────────────────────────────────────

  Scenario: Pack output to a file
    When I run "ctx pack --output context.md"
    Then the file "context.md" should be created in the current directory
    And the file should contain the packed context
    And the CLI should output "Packed context written to context.md"

  Scenario: Pack CLAUDE.md to project root
    When I run "ctx pack --output CLAUDE.md"
    Then "CLAUDE.md" should be created in the project root
    And the file should be in CLAUDE.md format

  Scenario: Pack to stdout by default
    When I run "ctx pack"
    Then the packed context should be written to stdout
    And no file should be created

  # ── Format comparison ───────────────────────────────────────────

  Scenario: Same content packed in different formats
    When I run "ctx pack --format claude" and capture the output as "claude_output"
    And I run "ctx pack --format openai" and capture the output as "openai_output"
    And I run "ctx pack --format markdown" and capture the output as "markdown_output"
    Then all three outputs should contain the same core project information
    And the formatting should differ between each output

  # ── Token counting ─────────────────────────────────────────────

  Scenario: Pack reports token count
    When I run "ctx pack --format claude"
    Then the CLI should output the total token count to stderr
    And the format should be "Packed: 12,345 tokens (claude format)"

  # ── Edge cases ──────────────────────────────────────────────────

  Scenario: Pack with empty wiki
    Given the wiki has not been compiled yet
    When I run "ctx pack"
    Then the CLI should output "Wiki is empty. Run 'ctx ingest' first."
    And the exit code should be 1

  Scenario: Pack with token budget of zero
    When I run "ctx pack --max-tokens 0"
    Then the CLI should exit with error code 1
    And the error message should contain "Token budget must be greater than 0"

  Scenario: Pack with unsupported format
    When I run "ctx pack --format xml"
    Then the CLI should exit with error code 1
    And the error message should contain "Unsupported format: xml. Use claude, openai, or markdown."
