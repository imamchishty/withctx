@costs
Feature: Cost tracking and budget management
  As a developer managing AI usage costs
  I want to track token consumption and costs per operation
  So that I can optimize usage and stay within budget

  Background:
    Given a project initialized with "ctx init"
    And the wiki has been compiled with "ctx ingest"
    And cost tracking is enabled in "ctx.yaml"

  # ── Track tokens + cost per operation ───────────────────────────

  Scenario: Track cost of an ingest operation
    When I run "ctx ingest"
    Then the operation log should record:
      | field             | type    |
      | operation         | string  |
      | inputTokens       | number  |
      | outputTokens      | number  |
      | totalTokens       | number  |
      | cost              | number  |
      | model             | string  |
      | timestamp         | string  |
    And the CLI should output "Ingest complete — 45,200 tokens ($0.068)"

  Scenario: Track cost of a sync operation
    When I run "ctx sync"
    Then the operation log should record tokens and cost for the sync
    And the CLI should output the token count and cost

  Scenario: Track cost of a query operation
    When I run "ctx query 'How does authentication work?'"
    Then the operation log should record:
      | field             | value           |
      | operation         | query           |
      | inputTokens       | 8500            |
      | outputTokens      | 1200            |
    And the CLI should output the cost in the response footer

  Scenario: Track cost of a lint operation
    When I run "ctx lint"
    Then the operation log should record tokens and cost for the lint
    And the cost should be lower than an ingest (fewer tokens needed)

  Scenario: Track cost of an add operation
    When I run "ctx add --type decision 'Adopted Redis for caching'"
    Then the operation log should record a minimal cost for the add
    And the cost should reflect only the integration analysis tokens

  Scenario Outline: Each operation type is tracked
    When I run "<command>"
    Then the cost log should contain an entry for operation "<operation>"
    And the entry should include input tokens, output tokens, and cost

    Examples:
      | command                                         | operation |
      | ctx ingest                                      | ingest    |
      | ctx sync                                        | sync      |
      | ctx query 'How does auth work?'                 | query     |
      | ctx lint                                        | lint      |
      | ctx add 'New convention note'                   | add       |

  # ── Per-source cost breakdown ───────────────────────────────────

  Scenario: Cost report shows per-source breakdown
    Given the following operations have been performed:
      | operation | source       | tokens | cost   |
      | ingest    | local .      | 25000  | 0.0375 |
      | ingest    | jira ACME    | 15000  | 0.0225 |
      | ingest    | confluence   | 18000  | 0.0270 |
      | sync      | local .      | 5000   | 0.0075 |
      | sync      | jira ACME    | 3000   | 0.0045 |
    When I run "ctx costs --by-source"
    Then the output should show a per-source cost breakdown:
      | source         | total_tokens | total_cost |
      | local .        | 30000        | $0.045     |
      | confluence ENG | 18000        | $0.027     |
      | jira ACME      | 18000        | $0.027     |

  Scenario: Per-source breakdown shows percentage of total
    When I run "ctx costs --by-source"
    Then each source should show its percentage of total cost:
      | source         | percentage |
      | local .        | 45%        |
      | confluence ENG | 28%        |
      | jira ACME      | 27%        |

  # ── Monthly budget with alerts ──────────────────────────────────

  Scenario: Set a monthly cost budget
    When I run "ctx costs budget --set 5.00"
    Then the "ctx.yaml" should contain a cost budget of $5.00 per month
    And the CLI should output "Monthly budget set: $5.00"

  Scenario: Budget alert at 80% threshold
    Given a monthly budget of $5.00 is configured
    And $4.10 has been spent this month
    When I run "ctx ingest"
    Then the CLI should display a warning:
      """
      WARNING: 82% of monthly budget used ($4.10 / $5.00)
      """
    And the ingest should still proceed

  Scenario: Budget alert at 100% threshold
    Given a monthly budget of $5.00 is configured
    And $5.20 has been spent this month
    When I run "ctx ingest"
    Then the CLI should display an error:
      """
      BUDGET EXCEEDED: $5.20 / $5.00 (104%)
      Use --force to proceed anyway
      """
    And the ingest should not proceed
    And the exit code should be 1

  Scenario: Force operation when budget exceeded
    Given a monthly budget of $5.00 is configured and exceeded
    When I run "ctx ingest --force"
    Then the ingest should proceed despite the budget limit
    And the CLI should output a warning about the exceeded budget

  Scenario: Budget resets monthly
    Given a monthly budget of $5.00 is configured
    And $4.50 was spent in March 2026
    And it is now April 2026
    When I run "ctx costs"
    Then the current month's spend should be $0.00
    And the previous month's spend should show $4.50

  # ── Cost report command ─────────────────────────────────────────

  Scenario: View cost report summary
    When I run "ctx costs"
    Then the output should display:
      | metric                 | value       |
      | Total spend (all time) | $12.45      |
      | This month             | $3.20       |
      | Monthly budget         | $5.00       |
      | Budget remaining       | $1.80       |
      | Operations today       | 5           |
      | Tokens today           | 125,000     |

  Scenario: View cost report for a specific period
    When I run "ctx costs --period 2026-04"
    Then the output should show costs only for April 2026
    And the report should be broken down by day

  Scenario: View cost report by operation type
    When I run "ctx costs --by-operation"
    Then the output should show cost breakdown by operation:
      | operation | count | total_tokens | total_cost |
      | ingest    | 3     | 135000       | $0.203     |
      | sync      | 12    | 48000        | $0.072     |
      | query     | 25    | 62500        | $0.094     |
      | lint      | 5     | 15000        | $0.023     |
      | add       | 8     | 2400         | $0.004     |

  Scenario: Cost report in JSON format
    When I run "ctx costs --format json"
    Then the output should be valid JSON
    And the JSON should contain:
      | field          |
      | totalSpend     |
      | currentMonth   |
      | budget         |
      | byOperation    |
      | bySource       |
      | byDay          |

  Scenario: Cost report shows daily trend
    When I run "ctx costs --period 2026-04 --daily"
    Then the output should show a daily cost breakdown:
      | date       | tokens  | cost   |
      | 2026-04-01 | 45000   | $0.068 |
      | 2026-04-02 | 12000   | $0.018 |
      | 2026-04-03 | 0       | $0.000 |
      | 2026-04-04 | 28000   | $0.042 |
      | 2026-04-05 | 35000   | $0.053 |
      | 2026-04-06 | 22000   | $0.033 |
      | 2026-04-07 | 18000   | $0.027 |

  # ── Model selection for cost optimization ───────────────────────

  Scenario: Configure model for cost optimization
    When I run "ctx costs model --set claude-3-haiku"
    Then the "ctx.yaml" should set the default model to "claude-3-haiku"
    And the CLI should output "Default model set: claude-3-haiku"

  Scenario: Use different models for different operations
    Given the "ctx.yaml" contains model configuration:
      | operation | model              |
      | ingest    | claude-sonnet-4    |
      | sync      | claude-sonnet-4    |
      | query     | claude-sonnet-4    |
      | lint      | claude-3-haiku     |
      | add       | claude-3-haiku     |
    When I run "ctx costs model"
    Then the output should display the model configuration per operation

  Scenario: Estimate cost before running an operation
    When I run "ctx costs estimate ingest"
    Then the output should display:
      | metric           | value                   |
      | estimated tokens | ~45,000                 |
      | estimated cost   | ~$0.068                 |
      | model            | claude-sonnet-4         |
      | sources          | 5                       |

  Scenario: Compare model costs
    When I run "ctx costs compare"
    Then the output should show cost comparison across models:
      | model              | estimated_monthly | savings |
      | claude-sonnet-4    | $5.20             | -       |
      | claude-3-haiku     | $0.52             | 90%     |

  # ── Edge cases ──────────────────────────────────────────────────

  Scenario: Cost tracking with no operations
    Given no operations have been performed
    When I run "ctx costs"
    Then the output should show $0.00 for all metrics

  Scenario: Remove budget
    Given a monthly budget of $5.00 is configured
    When I run "ctx costs budget --remove"
    Then the budget should be removed from "ctx.yaml"
    And the CLI should output "Monthly budget removed"

  Scenario: Cost log persists across sessions
    Given operations were performed in previous sessions
    When I run "ctx costs"
    Then all historical costs should be included in the report
