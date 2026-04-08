@connectors @engineering
Feature: Engineering data connectors
  As an engineer
  I want to ingest CI/CD, coverage, and PR data into the wiki
  So that the wiki reflects build health, test quality, and recent changes

  # --- CI/CD Connector ---

  Scenario: Connect CI/CD source for GitHub Actions
    Given a ctx.yaml with a CI/CD source for "acme/api-service"
    And GITHUB_TOKEN is set
    When I run "ctx doctor"
    Then I should see the CI/CD source as connected

  Scenario: Fetch workflow runs
    Given the GitHub Actions API returns 50 workflow runs
    When I run "ctx ingest"
    Then the wiki should contain CI build data

  Scenario: CI/CD generates summary statistics
    Given workflow runs with 46 successes and 4 failures
    When I run "ctx ingest"
    Then the wiki should include a success rate of 92%
    And average build time

  Scenario: CI/CD captures failure details
    Given a workflow run that failed at the "test" step
    When I run "ctx ingest"
    Then the wiki should include the failure details

  Scenario: CI/CD incremental sync
    Given a previous sync fetched runs up to yesterday
    When I run "ctx sync"
    Then only new runs since yesterday should be fetched

  # --- Coverage Connector ---

  Scenario: Connect coverage source with lcov format
    Given a ctx.yaml with a coverage source pointing to "coverage/lcov.info"
    And the file exists
    When I run "ctx doctor"
    Then I should see the coverage source as connected

  Scenario: Parse lcov coverage report
    Given an lcov.info file with line and branch coverage data
    When I run "ctx ingest"
    Then the wiki should include overall coverage percentages

  Scenario: Coverage shows per-directory breakdown
    Given coverage data spanning multiple directories
    When I run "ctx ingest"
    Then the wiki should include coverage by directory as a table

  Scenario: Coverage shows bottom and top files
    Given coverage data for 50 files
    When I run "ctx ingest"
    Then the wiki should list the 10 files with lowest coverage
    And the 10 files with highest coverage

  Scenario: Parse istanbul JSON coverage
    Given a ctx.yaml with coverage format "istanbul-json"
    And a coverage-summary.json file exists
    When I run "ctx ingest"
    Then the wiki should include coverage from the istanbul report

  Scenario: Parse cobertura XML coverage
    Given a ctx.yaml with coverage format "cobertura"
    And a coverage.xml file exists
    When I run "ctx ingest"
    Then the wiki should include coverage from the cobertura report

  # --- Pull Requests Connector ---

  Scenario: Connect pull-requests source
    Given a ctx.yaml with a pull-requests source for "acme/api-service"
    And GITHUB_TOKEN is set
    When I run "ctx doctor"
    Then I should see the pull-requests source as connected

  Scenario: Fetch merged PRs
    Given the repo has 20 merged PRs in the last 30 days
    When I run "ctx ingest"
    Then the wiki should contain PR summaries

  Scenario: PR data includes reviewers and files changed
    Given a merged PR with 2 reviewers and 5 files changed
    When I run "ctx ingest"
    Then the wiki should list the reviewers and changed files

  Scenario: PR connector generates activity summary
    Given 30 merged PRs over the last month
    When I run "ctx ingest"
    Then the wiki should include PRs per week and average review time

  Scenario: PR connector generates recent changes page
    Given 20 merged PRs
    When I run "ctx ingest"
    Then the wiki should have a "Recent Changes" page with PR summaries

  Scenario: PR connector respects since filter
    Given ctx.yaml has pull-requests with since "7d"
    When I run "ctx ingest"
    Then only PRs from the last 7 days should be fetched

  Scenario: PR connector incremental sync
    Given a previous sync fetched PRs up to yesterday
    When I run "ctx sync"
    Then only new PRs since yesterday should be fetched
