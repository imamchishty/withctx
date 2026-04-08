import chalk from "chalk";
import type { CostTracker, OperationType } from "./tracker.js";

/**
 * Format cost data as a terminal table.
 */
export function formatCostReport(tracker: CostTracker): string {
  const lines: string[] = [];
  const breakdown = tracker.getOperationBreakdown();
  const budgetInfo = tracker.checkBudget();
  const monthCost = tracker.getCurrentMonthCost();
  const monthKey = new Date().toISOString().slice(0, 7);

  lines.push(chalk.bold(`\n=== Cost Report (${monthKey}) ===\n`));

  // Per-operation breakdown table
  lines.push(
    chalk.dim(
      "  Operation    | Calls | Tokens      | Cost"
    )
  );
  lines.push(
    chalk.dim(
      "  -------------|-------|-------------|--------"
    )
  );

  const operations: OperationType[] = [
    "ingest",
    "sync",
    "query",
    "add",
    "lint",
    "chat",
    "faq",
  ];

  for (const op of operations) {
    const data = breakdown[op];
    if (data.count === 0) continue;

    const name = op.padEnd(12);
    const calls = String(data.count).padStart(5);
    const tokens = formatNumber(data.tokens).padStart(11);
    const cost = formatDollars(data.cost).padStart(6);

    lines.push(`  ${name} | ${calls} | ${tokens} | ${cost}`);
  }

  lines.push(
    chalk.dim(
      "  -------------|-------|-------------|--------"
    )
  );

  // Total row
  const totalCalls = Object.values(breakdown).reduce(
    (sum, d) => sum + d.count,
    0
  );
  const totalTokens = Object.values(breakdown).reduce(
    (sum, d) => sum + d.tokens,
    0
  );

  lines.push(
    chalk.bold(
      `  ${"Total".padEnd(12)} | ${String(totalCalls).padStart(5)} | ${formatNumber(totalTokens).padStart(11)} | ${formatDollars(monthCost).padStart(6)}`
    )
  );
  lines.push("");

  // Budget info
  if (budgetInfo) {
    const data = tracker.getData();
    const budget = data.budget ?? 0;
    const percentStr = budgetInfo.percentUsed.toFixed(1);
    const remaining = Math.max(0, budget - monthCost);

    if (budgetInfo.alert) {
      lines.push(
        chalk.red.bold(
          `  Budget Alert: ${percentStr}% used (${formatDollars(monthCost)} / ${formatDollars(budget)})`
        )
      );
    } else {
      lines.push(
        chalk.green(
          `  Budget: ${percentStr}% used (${formatDollars(monthCost)} / ${formatDollars(budget)})`
        )
      );
    }

    lines.push(
      chalk.dim(`  Remaining: ${formatDollars(remaining)}`)
    );

    // Progress bar
    const barWidth = 30;
    const filled = Math.round((budgetInfo.percentUsed / 100) * barWidth);
    const empty = barWidth - filled;
    const barColor = budgetInfo.alert ? chalk.red : chalk.green;
    const bar = barColor("\u2588".repeat(filled)) + chalk.dim("\u2591".repeat(empty));
    lines.push(`  [${bar}] ${percentStr}%`);
  } else {
    lines.push(chalk.dim("  No budget configured."));
  }

  lines.push("");

  return lines.join("\n");
}

function formatDollars(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
