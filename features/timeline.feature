@timeline
Feature: Project timeline
  As an engineer
  I want to see a chronological history of project events
  So that I understand what happened and when

  Background:
    Given a withctx project with compiled wiki pages
    And log.md has entries

  Scenario: Show full timeline
    When I run "ctx timeline"
    Then I should see events sorted by date
    And each event should have a date, icon, and description

  Scenario: Timeline includes syncs
    Given log.md has sync entries
    When I run "ctx timeline"
    Then I should see sync events with page counts

  Scenario: Timeline includes decisions
    Given the wiki has decision pages with dates
    When I run "ctx timeline"
    Then I should see decision events marked with a diamond icon

  Scenario: Timeline includes manual additions
    Given log.md has manual add entries
    When I run "ctx timeline"
    Then I should see manual add events marked with a circle icon

  Scenario: Timeline filtered by date
    When I run "ctx timeline --since 30d"
    Then I should only see events from the last 30 days

  Scenario: Timeline limited by count
    When I run "ctx timeline --limit 10"
    Then I should see at most 10 events

  Scenario: Timeline filtered by type
    When I run "ctx timeline --type decisions"
    Then I should only see decision events

  Scenario: Timeline as markdown
    When I run "ctx timeline --format markdown"
    Then the output should be valid markdown with a table

  Scenario: Timeline is free
    When I run "ctx timeline"
    Then no Claude API call should be made
    And no cost should be tracked

  Scenario: Timeline with empty log
    Given log.md has no entries
    When I run "ctx timeline"
    Then I should see "No events found"
