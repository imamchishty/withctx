import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";

interface CostOperation {
  operation: string;
  timestamp: string;
  tokensUsed: number;
  costUsd: number;
}

interface CostData {
  totalTokens: number;
  totalCostUsd: number;
  operations: CostOperation[];
}

export function registerCostsCommand(program: Command): void {
  program
    .command("costs")
    .description("Display token usage and cost report")
    .action(async () => {
      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          console.error(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        const rawCosts = ctxDir.readCosts();
        if (!rawCosts) {
          console.log();
          console.log(chalk.dim("  No cost data yet. Costs are tracked after running ingest, sync, query, etc."));
          console.log();
          return;
        }

        const costs = rawCosts as unknown as CostData;
        const budget = config.costs?.budget;
        const alertAt = config.costs?.alert_at ?? 80;

        console.log();
        console.log(chalk.bold.cyan("Cost Report"));
        console.log(chalk.dim("─".repeat(50)));
        console.log();

        // Summary
        console.log(chalk.bold("  Summary:"));
        console.log(`    Total tokens:  ${chalk.cyan(costs.totalTokens.toLocaleString())}`);
        console.log(`    Total cost:    ${chalk.cyan(`$${costs.totalCostUsd.toFixed(4)}`)}`);
        console.log(`    Model:         ${chalk.dim(config.costs?.model ?? "claude-sonnet-4")}`);

        if (budget) {
          const percentage = (costs.totalCostUsd / budget) * 100;
          const barWidth = 30;
          const filled = Math.min(Math.round((percentage / 100) * barWidth), barWidth);
          const bar = "=".repeat(filled) + "-".repeat(barWidth - filled);

          let budgetColor: typeof chalk.green;
          if (percentage >= alertAt) {
            budgetColor = chalk.red;
          } else if (percentage >= alertAt * 0.7) {
            budgetColor = chalk.yellow;
          } else {
            budgetColor = chalk.green;
          }

          console.log(
            `    Budget:        ${budgetColor(`$${costs.totalCostUsd.toFixed(2)} / $${budget}`)} (${budgetColor(`${percentage.toFixed(1)}%`)})`
          );
          console.log(`    Progress:      [${budgetColor(bar)}]`);

          if (percentage >= alertAt) {
            console.log();
            console.log(
              chalk.red.bold(`    WARNING: Budget usage at ${percentage.toFixed(1)}% (alert threshold: ${alertAt}%)`)
            );
          }
        }

        // Per-operation breakdown
        if (costs.operations && costs.operations.length > 0) {
          console.log();
          console.log(chalk.bold("  Operations (recent):"));

          // Group by operation type
          const byType: Record<string, { count: number; tokens: number; cost: number }> = {};
          for (const op of costs.operations) {
            if (!byType[op.operation]) {
              byType[op.operation] = { count: 0, tokens: 0, cost: 0 };
            }
            byType[op.operation].count++;
            byType[op.operation].tokens += op.tokensUsed;
            byType[op.operation].cost += op.costUsd;
          }

          console.log();
          console.log(
            chalk.dim("    Operation         Count     Tokens         Cost")
          );
          console.log(chalk.dim("    " + "-".repeat(55)));

          for (const [operation, stats] of Object.entries(byType)) {
            const opName = operation.padEnd(18);
            const count = String(stats.count).padStart(5);
            const tokens = stats.tokens.toLocaleString().padStart(10);
            const cost = `$${stats.cost.toFixed(4)}`.padStart(12);
            console.log(`    ${chalk.white(opName)} ${count} ${tokens} ${cost}`);
          }

          // Show last 10 individual operations
          console.log();
          console.log(chalk.bold("  Recent activity:"));
          const recent = costs.operations.slice(-10).reverse();

          for (const op of recent) {
            const time = new Date(op.timestamp).toLocaleString();
            console.log(
              `    ${chalk.dim(time)} ${chalk.cyan(op.operation.padEnd(10))} ${op.tokensUsed.toLocaleString()} tokens ${chalk.dim(`$${op.costUsd.toFixed(4)}`)}`
            );
          }
        }

        console.log();
      } catch (error) {
        console.error(chalk.red("Failed to load cost data"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
