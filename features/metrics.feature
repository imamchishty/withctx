@metrics
Feature: Wiki health dashboard
  As a team lead
  I want to see a health dashboard for the wiki
  So that I know if the wiki is maintained and useful

  Background:
    Given a withctx project with compiled wiki pages

  Scenario: Show health dashboard
    When I run "ctx metrics"
    Then I should see a health score out of 100
    And I should see page counts
    And I should see freshness breakdown
    And I should see cross-reference stats

  Scenario: Health score reflects freshness
    Given all wiki pages were updated within the last 7 days
    When I run "ctx metrics"
    Then the freshness component should score full points

  Scenario: Health score penalizes stale pages
    Given 5 wiki pages have not been updated in 60 days
    When I run "ctx metrics"
    Then the freshness component should score low

  Scenario: Metrics shows source connectivity
    Given 3 of 4 sources are connected
    When I run "ctx metrics"
    Then I should see "Sources: 3/4 connected"

  Scenario: Metrics shows cost budget progress
    Given costs.json shows $8.40 used of $20 budget
    When I run "ctx metrics"
    Then I should see a progress bar at 42%

  Scenario: Metrics shows cross-reference health
    Given the wiki has 48 links and 0 broken
    When I run "ctx metrics"
    Then I should see "48 total, 0 broken"

  Scenario: Metrics shows orphan pages
    Given one wiki page has no incoming links
    When I run "ctx metrics"
    Then I should see "orphans: 1 page"

  Scenario: Metrics as JSON
    When I run "ctx metrics --json"
    Then the output should be valid JSON
    And it should include a "healthScore" field

  Scenario: Metrics with watch mode
    When I run "ctx metrics --watch"
    Then the dashboard should refresh every 30 seconds

  Scenario: Metrics is free
    When I run "ctx metrics"
    Then no Claude API call should be made

  Scenario: Metrics with empty wiki
    Given the wiki has no compiled pages
    When I run "ctx metrics"
    Then the health score should be 0
    And I should see "Run ctx ingest to compile wiki pages"
