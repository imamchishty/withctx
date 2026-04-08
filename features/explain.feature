@explain
Feature: Deep file explanation
  As an engineer
  I want to understand any file with full project context
  So that I know not just what it does but why it exists

  Background:
    Given a withctx project with compiled wiki pages
    And ANTHROPIC_API_KEY is set

  Scenario: Explain a source file
    Given a file at "src/middleware/auth.ts"
    When I run "ctx explain src/middleware/auth.ts"
    Then I should see sections for What, Why, Patterns, Connections, Gotchas
    And the explanation should reference wiki pages

  Scenario: Explain shows business context
    Given the wiki has decisions/jwt-migration.md explaining the auth decision
    When I run "ctx explain src/middleware/auth.ts"
    Then the explanation should reference the JWT migration decision

  Scenario: Explain references conventions
    Given the wiki has conventions.md with coding patterns
    When I run "ctx explain src/middleware/auth.ts"
    Then the explanation should identify which patterns the file follows

  Scenario: Explain shows connections to other services
    Given the wiki has cross-repo/dependencies.md
    When I run "ctx explain src/middleware/auth.ts"
    Then the explanation should describe how this file relates to other services

  Scenario: Brief explanation
    When I run "ctx explain src/middleware/auth.ts --depth brief"
    Then I should see a short 2-3 sentence explanation

  Scenario: Deep explanation
    When I run "ctx explain src/middleware/auth.ts --depth deep"
    Then I should see a comprehensive multi-section explanation
    And it should include code-level details

  Scenario: Explanation for new engineer
    When I run "ctx explain src/middleware/auth.ts --for new-engineer"
    Then the explanation should use simple language
    And avoid assumed knowledge

  Scenario: Explanation for AI agent
    When I run "ctx explain src/middleware/auth.ts --for agent"
    Then the explanation should focus on patterns, file paths, and conventions

  Scenario: Save explanation as wiki page
    When I run "ctx explain src/middleware/auth.ts --save"
    Then a new wiki page should be created under manual/
    And index.md should be updated

  Scenario: Explain a file that doesn't exist
    When I run "ctx explain nonexistent.ts"
    Then I should see an error "File not found: nonexistent.ts"

  Scenario: Explain tracks costs
    When I run "ctx explain src/middleware/auth.ts"
    Then I should see token usage and estimated cost
