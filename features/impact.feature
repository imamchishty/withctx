@impact
Feature: Impact analysis
  As an architect
  I want to analyze the impact of proposed changes
  So that I understand the blast radius before making decisions

  Background:
    Given a withctx project with compiled wiki pages
    And the wiki includes cross-repo/dependencies.md
    And ANTHROPIC_API_KEY is set

  Scenario: Analyze database migration impact
    When I run "ctx impact 'migrate from MongoDB to PostgreSQL'"
    Then I should see affected services and repos
    And I should see key risks with severity levels
    And I should see an estimated effort

  Scenario: Analyze service removal impact
    When I run "ctx impact 'remove auth-service and merge into api-service'"
    Then I should see which services depend on auth-service
    And I should see deployment order changes

  Scenario: Analyze version upgrade impact
    When I run "ctx impact 'upgrade to Node.js 22'"
    Then I should see which repos would need changes

  Scenario: Impact shows affected wiki pages
    When I run "ctx impact 'switch from REST to gRPC'"
    Then I should see a list of wiki pages that describe affected areas

  Scenario: Impact estimates effort
    When I run "ctx impact 'add a new payment provider'"
    Then I should see a T-shirt size estimate (Small/Medium/Large/XL)
    And an explanation of why

  Scenario: Impact recommends approach
    When I run "ctx impact 'migrate from MongoDB to PostgreSQL'"
    Then I should see a recommended step-by-step approach

  Scenario: Impact references existing decisions
    Given the wiki has decisions.md with past ADRs
    When I run "ctx impact 'revert the JWT migration'"
    Then the analysis should reference the original JWT decision

  Scenario: Impact scoped to specific repos
    When I run "ctx impact 'upgrade Express to v5' --scope api-service"
    Then the analysis should focus only on api-service

  Scenario: Impact saved as wiki page
    When I run "ctx impact 'migrate to PostgreSQL' --save manual/impact-postgres.md"
    Then the file manual/impact-postgres.md should be created
    And index.md should be updated

  Scenario: Impact as JSON
    When I run "ctx impact 'add caching layer' --format json"
    Then the output should be valid JSON

  Scenario: Impact as markdown
    When I run "ctx impact 'add caching layer' --format markdown"
    Then the output should be valid markdown

  Scenario: Impact tracks costs
    When I run "ctx impact 'migrate to PostgreSQL'"
    Then I should see token usage and estimated cost
