import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";

interface SyncState {
  sources: Record<string, { lastSyncAt: string; itemCount: number }>;
}

function loadSyncState(ctxDir: CtxDirectory): SyncState | null {
  const statePath = join(ctxDir.path, "sync-state.json");
  if (existsSync(statePath)) {
    return JSON.parse(readFileSync(statePath, "utf-8")) as SyncState;
  }
  return null;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show wiki health: page counts, source freshness, and overall status")
    .action(async () => {
      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          console.error(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);
        const allPages = pageManager.list();
        const syncState = loadSyncState(ctxDir);

        // Header
        console.log();
        console.log(chalk.bold.cyan(`withctx status — ${config.project}`));
        console.log(chalk.dim("─".repeat(50)));

        // Page catalog
        console.log();
        console.log(chalk.bold("Pages:"));

        const categories: Record<string, string[]> = {};
        for (const page of allPages) {
          const parts = page.split("/");
          const category = parts.length > 1 ? parts[0] : "root";
          if (!categories[category]) categories[category] = [];
          categories[category].push(page);
        }

        let totalPages = 0;
        for (const [category, pages] of Object.entries(categories)) {
          console.log(
            `  ${chalk.cyan(category)}: ${chalk.bold(String(pages.length))} page(s)`
          );
          totalPages += pages.length;
        }
        console.log(chalk.dim(`  Total: ${totalPages} pages`));

        // Source freshness
        console.log();
        console.log(chalk.bold("Sources:"));

        const sources: Array<{ name: string; type: string }> = [];
        if (config.sources?.local) {
          for (const s of config.sources.local) sources.push({ name: s.name, type: "local" });
        }
        if (config.sources?.jira) {
          for (const s of config.sources.jira) sources.push({ name: s.name, type: "jira" });
        }
        if (config.sources?.confluence) {
          for (const s of config.sources.confluence) sources.push({ name: s.name, type: "confluence" });
        }
        if (config.sources?.github) {
          for (const s of config.sources.github) sources.push({ name: s.name, type: "github" });
        }
        if (config.sources?.teams) {
          for (const s of config.sources.teams) sources.push({ name: s.name, type: "teams" });
        }

        if (sources.length === 0) {
          console.log(chalk.dim("  No sources configured"));
        } else {
          for (const source of sources) {
            const state = syncState?.sources[source.name];
            const lastSync = state
              ? chalk.green(formatRelativeTime(state.lastSyncAt))
              : chalk.yellow("never synced");
            const items = state ? chalk.dim(`(${state.itemCount} items)`) : "";

            console.log(
              `  ${chalk.cyan(source.name)} [${source.type}] — last sync: ${lastSync} ${items}`
            );
          }
        }

        // Costs
        const costs = ctxDir.readCosts();
        if (costs) {
          console.log();
          console.log(chalk.bold("Costs:"));
          const totalTokens = (costs as Record<string, unknown>)["totalTokens"] as number ?? 0;
          const totalCost = (costs as Record<string, unknown>)["totalCostUsd"] as number ?? 0;
          const budget = config.costs?.budget;

          console.log(`  Tokens used:  ${chalk.cyan(totalTokens.toLocaleString())}`);
          console.log(`  Estimated:    ${chalk.cyan(`$${totalCost.toFixed(4)}`)}`);

          if (budget) {
            const percentage = (totalCost / budget) * 100;
            const budgetColor = percentage > 80 ? chalk.red : percentage > 50 ? chalk.yellow : chalk.green;
            console.log(
              `  Budget:       ${budgetColor(`$${totalCost.toFixed(2)} / $${budget}`)} (${budgetColor(`${percentage.toFixed(1)}%`)})`
            );
          }
        }

        // Health summary
        console.log();
        console.log(chalk.bold("Health:"));

        const healthChecks: Array<{ label: string; ok: boolean; detail: string }> = [];

        // Check: has pages
        healthChecks.push({
          label: "Wiki pages",
          ok: totalPages > 1,
          detail: totalPages > 1 ? `${totalPages} pages` : "No content — run 'ctx ingest'",
        });

        // Check: has been synced recently
        const hasRecentSync = syncState
          ? Object.values(syncState.sources).some((s) => {
              const diff = Date.now() - new Date(s.lastSyncAt).getTime();
              return diff < 7 * 86_400_000; // 7 days
            })
          : false;
        healthChecks.push({
          label: "Recent sync",
          ok: hasRecentSync,
          detail: hasRecentSync ? "Synced within 7 days" : "No recent sync — run 'ctx sync'",
        });

        // Check: index exists and is non-trivial
        const indexContent = ctxDir.readPage("index.md") ?? "";
        const hasGoodIndex = indexContent.length > 100;
        healthChecks.push({
          label: "Index",
          ok: hasGoodIndex,
          detail: hasGoodIndex ? "Index is populated" : "Index is sparse — run 'ctx ingest'",
        });

        for (const check of healthChecks) {
          const icon = check.ok ? chalk.green("ok") : chalk.yellow("--");
          console.log(`  [${icon}] ${check.label}: ${chalk.dim(check.detail)}`);
        }

        console.log();
      } catch (error) {
        console.error(chalk.red("Status check failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
