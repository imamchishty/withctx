@review
Feature: Context-aware PR review
  As an engineer
  I want to review PRs with project wiki context
  So that reviews catch convention violations and cross-repo impacts

  Background:
    Given a withctx project with compiled wiki pages
    And ANTHROPIC_API_KEY is set

  Scenario: Review a GitHub PR by URL
    Given a GitHub PR at "https://github.com/acme/api-service/pull/47"
    When I run "ctx review https://github.com/acme/api-service/pull/47"
    Then I should see a review with Summary, Issues, Suggestions sections
    And the review should reference wiki pages

  Scenario: Review staged git changes
    Given I have staged changes in git
    When I run "ctx review --staged"
    Then I should see a review of the staged diff
    And the review should check against conventions.md

  Scenario: Review a local diff file
    Given a diff file at "./changes.diff"
    When I run "ctx review --file changes.diff"
    Then I should see a review of that diff

  Scenario: Review detects convention violations
    Given the wiki has conventions.md requiring Zod validation
    And the PR adds a handler without Zod validation
    When I run "ctx review https://github.com/acme/api-service/pull/47"
    Then the review should flag the missing validation
    And reference conventions.md

  Scenario: Review identifies cross-repo impacts
    Given the wiki has cross-repo/dependencies.md
    And the PR changes a shared API contract
    When I run "ctx review https://github.com/acme/api-service/pull/47"
    Then the review should list affected downstream services

  Scenario: Review with strict severity
    When I run "ctx review --staged --severity strict"
    Then the review should flag more issues than normal severity

  Scenario: Review with lenient severity
    When I run "ctx review --staged --severity lenient"
    Then the review should only flag critical issues

  Scenario: Review with security focus
    When I run "ctx review --staged --focus security"
    Then the review should focus on authentication, authorization, and injection risks

  Scenario: Review with performance focus
    When I run "ctx review --staged --focus performance"
    Then the review should focus on N+1 queries, memory leaks, and caching

  Scenario: Review writes output to file
    When I run "ctx review --staged --output review.md"
    Then review.md should contain the full review in markdown

  Scenario: Review shows cost tracking
    When I run "ctx review --staged"
    Then I should see token usage and estimated cost at the end

  Scenario: Review with no wiki pages provides basic review
    Given the wiki has no compiled pages
    When I run "ctx review --staged"
    Then I should still see a basic code review
    And I should see a warning that wiki context is empty
