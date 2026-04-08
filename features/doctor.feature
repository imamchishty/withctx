@doctor
Feature: Pre-flight diagnostics
  As an engineer setting up withctx
  I want to verify my environment is correct
  So that I can fix issues before running ingest

  Background:
    Given a project directory with ctx.yaml

  Scenario: All checks pass
    Given ANTHROPIC_API_KEY is set
    And all source credentials are configured
    When I run "ctx doctor"
    Then I should see all green checkmarks
    And the exit code should be 0

  Scenario: Missing API key
    Given ANTHROPIC_API_KEY is not set
    When I run "ctx doctor"
    Then I should see a red cross for "ANTHROPIC_API_KEY"
    And I should see instructions to set the key
    And the exit code should be 1

  Scenario: Missing ctx.yaml
    Given no ctx.yaml exists in the directory
    When I run "ctx doctor"
    Then I should see a red cross for "ctx.yaml"
    And I should see "Run ctx init to create one"

  Scenario: Uninitialized .ctx directory
    Given ctx.yaml exists
    But .ctx/ directory does not exist
    When I run "ctx doctor"
    Then I should see a warning for ".ctx/ directory"
    And I should see "Run ctx init to initialize"

  Scenario: Jira configured with missing token
    Given ctx.yaml has a Jira source
    And JIRA_URL is set
    But JIRA_TOKEN is not set
    When I run "ctx doctor"
    Then I should see a warning for "jira"
    And I should see "JIRA_TOKEN missing"
    And I should see a link to Atlassian API token page

  Scenario: Confluence with no credentials
    Given ctx.yaml has a Confluence source
    And CONFLUENCE_URL is not set
    When I run "ctx doctor"
    Then I should see a red cross for "confluence"

  Scenario: Teams with missing credentials
    Given ctx.yaml has a Teams source
    And TEAMS_CLIENT_ID is not set
    When I run "ctx doctor"
    Then I should see a red cross for "teams"
    And I should see instructions for Azure AD app registration

  Scenario: Local source path doesn't exist
    Given ctx.yaml has a local source pointing to "./nonexistent"
    When I run "ctx doctor"
    Then I should see a warning for that source
    And I should see "path does not exist"

  Scenario: API connection fails
    Given ANTHROPIC_API_KEY is set to an invalid value
    When I run "ctx doctor"
    Then I should see a red cross for "API connection"
    And the exit code should be 1

  Scenario: Only warnings, no critical failures
    Given ANTHROPIC_API_KEY is set and valid
    And ctx.yaml exists with one misconfigured optional source
    When I run "ctx doctor"
    Then the exit code should be 0
    And I should see warnings but no critical failures
