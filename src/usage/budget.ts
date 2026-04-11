/**
 * Hard budget enforcement.
 *
 * The problem this solves: `costs.budget` in `ctx.yaml` was always
 * advisory — we printed an alert when spend crossed 80% of the budget,
 * but nothing actually stopped. A runaway `ctx sync` in CI could
 * quietly burn past the declared budget while the user slept.
 *
 * This module provides a single cheap function — `assertWithinBudget`
 * — that every long-running command calls RIGHT BEFORE it makes an
 * LLM call. The check sums the current calendar month's spend (from
 * .ctx/usage.jsonl) and throws a `BudgetExceededError` if adding the
 * estimated cost of the next call would blow past the budget.
 *
 * Why month-to-date and not lifetime?
 *
 *   - Budgets are almost always "$X / month" in the real world.
 *   - Rolling the budget each calendar month means users don't have
 *     to manually zero it, and CI doesn't grind to a halt forever
 *     after a one-off expensive run.
 *   - Users who want a rolling 30-day or lifetime budget can wrap
 *     this with a different summariser; the default is the common
 *     case.
 *
 * Why a SEPARATE error class and not a generic Error?
 *
 *   Callers need to distinguish "budget blown" from "API down" so
 *   they can render a helpful message and EXIT 78 (config error)
 *   rather than the generic 1.
 *
 * Env escape hatch:
 *
 *   `CTX_IGNORE_BUDGET=1` disables the check entirely. Deliberately
 *   named with "IGNORE" (not "SKIP") — we want the user to feel a
 *   small pang of guilt every time they set it, because the whole
 *   point of a hard budget is to be inconvenient when you're about
 *   to overspend.
 */

import type { CtxDirectory } from "../storage/ctx-dir.js";
import type { CtxConfig } from "../types/config.js";
import { readUsage, getCalls } from "./recorder.js";

export class BudgetExceededError extends Error {
  public readonly budget: number;
  public readonly monthSpend: number;
  public readonly estimatedCost: number;
  public readonly wouldSpend: number;

  constructor(opts: {
    budget: number;
    monthSpend: number;
    estimatedCost: number;
    operation: string;
  }) {
    const wouldSpend = opts.monthSpend + opts.estimatedCost;
    super(
      [
        `Monthly budget exceeded.`,
        `  Budget:           $${opts.budget.toFixed(2)} / month`,
        `  Spent so far:     $${opts.monthSpend.toFixed(4)}`,
        `  Next call (${opts.operation}): ~$${opts.estimatedCost.toFixed(4)}`,
        `  Would reach:      $${wouldSpend.toFixed(4)} (${((wouldSpend / opts.budget) * 100).toFixed(1)}% of budget)`,
        ``,
        `Options:`,
        `  1. Raise the budget in ctx.yaml (costs.budget: <amount>).`,
        `  2. Wait until next month — the meter rolls on the 1st.`,
        `  3. Skip the check for this run: CTX_IGNORE_BUDGET=1 ctx ...`,
      ].join("\n")
    );
    this.name = "BudgetExceededError";
    this.budget = opts.budget;
    this.monthSpend = opts.monthSpend;
    this.estimatedCost = opts.estimatedCost;
    this.wouldSpend = wouldSpend;
  }
}

/**
 * Sum call-record cost for the current calendar month.
 *
 * "Current calendar month" is defined in UTC. This is the same
 * convention Anthropic / OpenAI dashboards use, so users comparing
 * their withctx budget against the provider's bill see matching
 * numbers. Local-timezone month boundaries would introduce a ±24h
 * discrepancy with the provider dashboard at month-end that's more
 * confusing than helpful.
 */
export function currentMonthSpend(ctxDir: CtxDirectory, now: Date = new Date()): number {
  const records = readUsage(ctxDir);
  const calls = getCalls(records);

  // Month start in UTC.
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  let total = 0;
  for (const call of calls) {
    const ts = Date.parse(call.ts);
    if (!Number.isFinite(ts) || ts < monthStart) continue;
    total += call.cost;
  }
  return total;
}

/**
 * The result of a budget pre-check. Used by callers that want to
 * surface the number in a UI (cost preview, doctor report) without
 * having to throw/catch.
 */
export interface BudgetStatus {
  /** Configured budget in USD. `null` when no budget is set. */
  budget: number | null;
  /** Month-to-date spend in USD. */
  monthSpend: number;
  /** 0..1 (can exceed 1 if already over). Null when no budget set. */
  fraction: number | null;
  /** Human-readable one-liner for status / doctor output. */
  summary: string;
}

/**
 * Compute current status WITHOUT throwing. Useful for `ctx status`,
 * `ctx costs`, `ctx doctor`, etc.
 */
export function getBudgetStatus(
  ctxDir: CtxDirectory,
  config: CtxConfig,
  now: Date = new Date()
): BudgetStatus {
  const budget = config.costs?.budget ?? null;
  const monthSpend = currentMonthSpend(ctxDir, now);
  if (budget === null) {
    return {
      budget: null,
      monthSpend,
      fraction: null,
      summary: `$${monthSpend.toFixed(2)} month-to-date (no budget set)`,
    };
  }
  const fraction = monthSpend / budget;
  const pct = (fraction * 100).toFixed(1);
  const summary = `$${monthSpend.toFixed(2)} / $${budget.toFixed(2)} (${pct}%) month-to-date`;
  return { budget, monthSpend, fraction, summary };
}

/**
 * The hard check. Call this immediately before issuing an LLM
 * request. Throws `BudgetExceededError` if the estimated call cost
 * would push month-to-date spend past the configured budget.
 *
 * No-op when:
 *   - `costs.budget` is not set in ctx.yaml (users opt in).
 *   - The `CTX_IGNORE_BUDGET=1` environment variable is set (escape
 *     hatch for one-off high-cost refreshes — deliberately ugly to
 *     type).
 *
 * `operation` is used only to improve the error message; pass
 * whatever makes sense at the call site (`"ctx sync"`, `"query"`,
 * etc.). It never drives policy.
 */
export function assertWithinBudget(
  ctxDir: CtxDirectory,
  config: CtxConfig,
  estimatedCost: number,
  operation: string
): void {
  if (process.env.CTX_IGNORE_BUDGET === "1") return;
  const budget = config.costs?.budget;
  if (budget === undefined || budget === null) return;

  const monthSpend = currentMonthSpend(ctxDir);
  if (monthSpend + estimatedCost > budget) {
    throw new BudgetExceededError({
      budget,
      monthSpend,
      estimatedCost,
      operation,
    });
  }
}

/**
 * Softer variant — returns a warning string when the upcoming call
 * would push spend past the `alert_at` threshold (default 80% of
 * budget), but DOES NOT throw. Useful for long runs that want to
 * emit a single "you're close" warning without blocking.
 *
 * Returns null when:
 *   - No budget is set.
 *   - Spend after the call would still be under the alert threshold.
 *   - `assertWithinBudget` would have already thrown (caller should
 *     run that one first if they want hard enforcement).
 */
export function checkBudgetWarning(
  ctxDir: CtxDirectory,
  config: CtxConfig,
  estimatedCost: number
): string | null {
  const budget = config.costs?.budget;
  if (budget === undefined || budget === null) return null;
  const alertAt = (config.costs?.alert_at ?? 80) / 100;
  const monthSpend = currentMonthSpend(ctxDir);
  const wouldSpend = monthSpend + estimatedCost;
  if (wouldSpend / budget < alertAt) return null;
  const pct = ((wouldSpend / budget) * 100).toFixed(0);
  return `Heads up: this call brings month-to-date spend to $${wouldSpend.toFixed(2)} (${pct}% of $${budget.toFixed(2)} budget).`;
}
