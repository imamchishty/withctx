@changelog
Feature: Auto-generated release notes
  As an engineer
  I want to auto-generate release notes from git and wiki context
  So that I don't have to manually write changelogs

  Background:
    Given a withctx project with compiled wiki pages
    And a git repository with commit history
    And ANTHROPIC_API_KEY is set

  Scenario: Generate changelog since last tag
    Given the repository has a tag "v2.3.0"
    When I run "ctx changelog"
    Then I should see release notes since v2.3.0
    And the notes should include Features, Improvements, Bug Fixes sections

  Scenario: Generate changelog since specific tag
    When I run "ctx changelog --since v2.2.0"
    Then I should see release notes covering changes between v2.2.0 and HEAD

  Scenario: Generate changelog since date
    When I run "ctx changelog --since 2025-03-01"
    Then I should see release notes for changes after March 1st

  Scenario: Generate changelog since duration
    When I run "ctx changelog --since 7d"
    Then I should see release notes for the last 7 days

  Scenario: Changelog references commits and PRs
    Given commits mentioning PR numbers
    When I run "ctx changelog --since 7d"
    Then the notes should reference commit hashes or PR numbers

  Scenario: Changelog identifies breaking changes
    Given commits with breaking API changes
    When I run "ctx changelog --since v2.3.0"
    Then the notes should have a "Breaking Changes" section

  Scenario: Changelog as markdown
    When I run "ctx changelog --since 7d --format markdown"
    Then the output should be valid markdown

  Scenario: Changelog as JSON
    When I run "ctx changelog --since 7d --format json"
    Then the output should be valid JSON

  Scenario: Changelog written to file
    When I run "ctx changelog --since 7d --output CHANGELOG.md"
    Then CHANGELOG.md should contain the release notes

  Scenario: Changelog saved as wiki page
    When I run "ctx changelog --since 7d --save"
    Then a new wiki page should be created under manual/

  Scenario: Changelog with no changes
    Given no commits since the last tag
    When I run "ctx changelog"
    Then I should see "No changes found"
