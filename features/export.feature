@export
Feature: Wiki file export
  As a developer needing context files in my project or CI pipeline
  I want to export the compiled wiki in various formats and configurations
  So that I can integrate project context into my development workflow

  Background:
    Given a project initialized with "ctx init"
    And the wiki has been compiled with "ctx ingest"
    And the wiki contains pages for "api-service", "auth-service", "payment-service", "conventions", and "people"

  # ── Export CLAUDE.md to project root ────────────────────────────

  Scenario: Export CLAUDE.md to project root
    When I run "ctx export claude"
    Then a "CLAUDE.md" file should be created in the project root
    And the file should contain compiled project context in CLAUDE.md format
    And the CLI should output "Exported: CLAUDE.md (12,345 tokens)"

  Scenario: CLAUDE.md contains structured project context
    When I run "ctx export claude"
    Then "CLAUDE.md" should contain sections:
      | section              |
      | Project Overview     |
      | Architecture         |
      | Services             |
      | Conventions          |
      | Key Decisions        |

  Scenario: Export CLAUDE.md overwrites existing file
    Given a "CLAUDE.md" file already exists in the project root
    When I run "ctx export claude"
    Then the existing "CLAUDE.md" should be replaced with updated content
    And the CLI should output "Exported: CLAUDE.md (updated)"

  Scenario: Export CLAUDE.md to a custom path
    When I run "ctx export claude --output ./docs/CLAUDE.md"
    Then "docs/CLAUDE.md" should be created with the context

  # ── Export all formats at once ──────────────────────────────────

  Scenario: Export all formats simultaneously
    When I run "ctx export --all"
    Then the following files should be created:
      | file                      | format   |
      | CLAUDE.md                 | claude   |
      | context-openai.md         | openai   |
      | context-markdown.md       | markdown |
    And the CLI should output:
      """
      Exported 3 files:
        CLAUDE.md (12,345 tokens)
        context-openai.md (11,890 tokens)
        context-markdown.md (13,100 tokens)
      """

  Scenario: Export all formats to a custom directory
    When I run "ctx export --all --output-dir ./exports"
    Then the following files should be created in "./exports/":
      | file                      |
      | CLAUDE.md                 |
      | context-openai.md         |
      | context-markdown.md       |

  # ── Export individual formats ───────────────────────────────────

  Scenario Outline: Export a specific format
    When I run "ctx export <format>"
    Then a file should be created with the name "<filename>"
    And the file content should be in "<format>" format
    And the CLI should output "Exported: <filename>"

    Examples:
      | format   | filename             |
      | claude   | CLAUDE.md            |
      | openai   | context-openai.md    |
      | markdown | context-markdown.md  |

  # ── Export snapshots ────────────────────────────────────────────

  Scenario: Export a timestamped snapshot
    When I run "ctx export --snapshot"
    Then a snapshot archive should be created at ".ctx/snapshots/2026-04-07T100000Z/"
    And the snapshot should contain:
      | file                      |
      | CLAUDE.md                 |
      | context-openai.md         |
      | context-markdown.md       |
      | metadata.json             |
    And the CLI should output "Snapshot created: .ctx/snapshots/2026-04-07T100000Z/"

  Scenario: Snapshot metadata includes context about the export
    When I run "ctx export --snapshot"
    Then the "metadata.json" in the snapshot should contain:
      | field            | type    |
      | timestamp        | string  |
      | wikiPages        | number  |
      | sourcesCount     | number  |
      | totalTokens      | number  |
      | version          | string  |

  Scenario: List existing snapshots
    Given 3 snapshots have been created previously
    When I run "ctx export --list-snapshots"
    Then the output should list all 3 snapshots:
      | snapshot                        | pages | tokens |
      | 2026-04-05T090000Z             | 10    | 11200  |
      | 2026-04-06T140000Z             | 11    | 12100  |
      | 2026-04-07T100000Z             | 12    | 12345  |

  Scenario: Restore a snapshot
    When I run "ctx export --restore 2026-04-06T140000Z"
    Then the CLAUDE.md in the project root should be replaced with the snapshot version
    And the CLI should output "Restored snapshot: 2026-04-06T140000Z"

  # ── Scoped export ───────────────────────────────────────────────

  Scenario: Export scoped to a specific repo
    Given the workspace contains repos "api-service" and "auth-service"
    When I run "ctx export claude --scope api-service"
    Then the exported "CLAUDE.md" should only contain context for "api-service"
    And cross-references should be included as brief summaries

  Scenario: Export scoped to multiple repos
    When I run "ctx export claude --scope api-service,auth-service"
    Then the exported file should contain context for both services
    And shared dependencies should be included

  # ── Budget-limited export ───────────────────────────────────────

  Scenario Outline: Export with token budget
    When I run "ctx export claude --max-tokens <budget>"
    Then the exported "CLAUDE.md" should not exceed <budget> tokens
    And the CLI should output "Exported: CLAUDE.md (<actual> tokens, budget: <budget>)"

    Examples:
      | budget  |
      | 4000    |
      | 8000    |
      | 16000   |
      | 32000   |

  Scenario: Budget-limited export prioritizes core content
    When I run "ctx export claude --max-tokens 4000"
    Then the export should include:
      | content_type   | priority |
      | overview       | high     |
      | architecture   | high     |
      | conventions    | medium   |
      | services       | medium   |
      | people         | low      |
    And lower priority content should be summarized or omitted first

  # ── Scoped + budget combined ────────────────────────────────────

  Scenario: Export with both scope and budget
    When I run "ctx export claude --scope api-service --max-tokens 4000"
    Then the export should contain only "api-service" context
    And the export should not exceed 4000 tokens
    And the most important content should be preserved

  # ── Edge cases ──────────────────────────────────────────────────

  Scenario: Export with empty wiki
    Given the wiki has not been compiled yet
    When I run "ctx export claude"
    Then the CLI should output "Wiki is empty. Run 'ctx ingest' first."
    And the exit code should be 1

  Scenario: Export with unsupported format
    When I run "ctx export xml"
    Then the CLI should exit with error code 1
    And the error message should contain "Unsupported format: xml. Use claude, openai, or markdown."

  Scenario: Export does not overwrite without confirmation when content differs significantly
    Given a "CLAUDE.md" exists with 10,000 tokens of content
    And the new export would contain only 2,000 tokens
    When I run "ctx export claude"
    Then the CLI should warn "New export is 80% smaller than existing file. Overwrite? [y/N]"
