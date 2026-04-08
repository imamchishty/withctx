@management
Feature: Management commands
  As an engineer
  I want management commands for watching, resetting, importing, graphing, and configuring
  So that I can manage my withctx project effectively

  # --- ctx watch ---

  Scenario: Watch monitors file changes
    Given a withctx project with local sources configured
    When I run "ctx watch"
    Then it should start watching the configured paths
    And display "Watching ... for changes"

  Scenario: Watch auto-syncs on change
    Given ctx watch is running
    When a file in a watched directory changes
    Then a sync should trigger after a 2-second debounce

  Scenario: Watch ignores non-content files
    Given ctx watch is running
    When a file in node_modules changes
    Then no sync should trigger

  Scenario: Watch graceful shutdown
    Given ctx watch is running
    When I press Ctrl+C
    Then it should stop watching and exit cleanly

  # --- ctx reset ---

  Scenario: Reset prompts for confirmation
    Given a withctx project with 12 wiki pages
    When I run "ctx reset"
    Then I should see "This will delete all wiki pages"
    And I should be prompted for confirmation

  Scenario: Reset with force skips confirmation
    Given a withctx project with 12 wiki pages
    When I run "ctx reset --force"
    Then all wiki pages should be deleted
    And log.md should record the reset

  Scenario: Reset preserves directory structure
    When I run "ctx reset --force"
    Then .ctx/context/ directories should still exist
    But all .md files except index.md and log.md should be deleted

  Scenario: Reset with reingest
    When I run "ctx reset --force --reingest"
    Then the wiki should be wiped
    And a full ingest should run immediately

  # --- ctx import ---

  Scenario: Import a markdown file
    Given a file "CLAUDE.md" with project documentation
    When I run "ctx import CLAUDE.md"
    Then Claude should split it into appropriate wiki pages
    And index.md should be updated

  Scenario: Import as specific page
    Given a file "notes.md"
    When I run "ctx import notes.md --as api-design"
    Then the content should be saved as a single wiki page named "api-design"

  Scenario: Import a file that doesn't exist
    When I run "ctx import nonexistent.md"
    Then I should see an error "File not found"

  # --- ctx graph ---

  Scenario: Generate mermaid graph
    Given a withctx project with cross-referenced wiki pages
    When I run "ctx graph"
    Then a mermaid diagram should be generated
    And saved to .ctx/exports/graph.mermaid

  Scenario: Generate DOT graph
    When I run "ctx graph --format dot"
    Then a Graphviz DOT file should be generated

  Scenario: Generate text graph
    When I run "ctx graph --format text"
    Then an ASCII text graph should be displayed

  Scenario: Graph shows orphan pages
    Given a wiki page with no incoming links
    When I run "ctx graph"
    Then the output should indicate orphan pages

  Scenario: Graph is free
    When I run "ctx graph"
    Then no Claude API call should be made

  # --- ctx config ---

  Scenario: Show full config
    Given a ctx.yaml exists
    When I run "ctx config"
    Then I should see the project name, sources, and cost settings

  Scenario: Get a specific value
    Given ctx.yaml has costs.budget set to 20
    When I run "ctx config get costs.budget"
    Then I should see "20"

  Scenario: Set a value
    When I run "ctx config set costs.budget 50"
    Then ctx.yaml should have costs.budget set to 50

  Scenario: Set validates with Zod
    When I run "ctx config set costs.budget not-a-number"
    Then I should see a validation error

  Scenario: Show sources with status
    Given ctx.yaml has 3 sources configured
    When I run "ctx config sources"
    Then I should see each source with its connection status
