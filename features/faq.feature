@faq
Feature: Auto-generated FAQ
  As an engineer
  I want an auto-generated FAQ from the wiki
  So that common questions are answered before anyone has to ask

  Background:
    Given a withctx project with compiled wiki pages
    And ANTHROPIC_API_KEY is set

  Scenario: Generate FAQ with default 20 questions
    When I run "ctx faq"
    Then I should see 20 questions with answers
    And each answer should reference wiki pages
    And faq.md should be saved in .ctx/context/

  Scenario: FAQ is cached on second run
    Given faq.md already exists in .ctx/context/
    When I run "ctx faq"
    Then it should display the cached FAQ
    And no Claude API call should be made

  Scenario: Regenerate FAQ
    Given faq.md already exists
    When I run "ctx faq --regenerate"
    Then a new FAQ should be generated
    And faq.md should be overwritten

  Scenario: FAQ with custom question count
    When I run "ctx faq --count 30"
    Then I should see 30 questions with answers

  Scenario: FAQ for new engineers
    When I run "ctx faq --for new-engineer"
    Then the FAQ should focus on setup, basics, and getting started
    And use simple language

  Scenario: FAQ for AI agents
    When I run "ctx faq --for agent"
    Then the FAQ should focus on patterns, conventions, and file paths

  Scenario: FAQ for senior engineers
    When I run "ctx faq --for senior"
    Then the FAQ should focus on architecture decisions and trade-offs

  Scenario: FAQ scoped to specific area
    When I run "ctx faq --scope repos/api-service"
    Then the FAQ should only cover api-service topics

  Scenario: FAQ written to custom file
    When I run "ctx faq --output faq-output.md"
    Then faq-output.md should contain the FAQ

  Scenario: FAQ updates index.md
    When I run "ctx faq"
    Then index.md should include a link to faq.md

  Scenario: FAQ tracks costs
    When I run "ctx faq --regenerate"
    Then I should see token usage and estimated cost
