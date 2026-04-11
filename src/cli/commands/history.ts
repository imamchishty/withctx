import { Command } from "commander";
import chalk from "chalk";
import { getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { readUsage, getRefreshes, type RefreshRecord } from "../../usage/recorder.js";

/**
 * `ctx history` — show the refresh journal.
 *
 * Answers "who refreshed the wiki, when, and how much did it cost?".
 * Reads append-only `.ctx/usage.jsonl` records of kind `refresh` — one
 * per `ctx sync` / `ctx setup` run — and renders them as a table or JSON.
 *
 * This is the audit trail for CI-managed wikis. If your `refreshed_by: ci`
 * wiki suddenly goes stale, `ctx history` is the first place to look:
 * you'll see the failed runs (`success: false`) alongside the successful
 * ones, who triggered them, and how much budget each one ate.
 */
export function registerHistoryCommand(program: Command): void {
  program
    .command("history")
    .description("Show refresh journal — who refreshed the wiki, when, and at what cost")
    .option("-n, --limit <n>", "Show only the last N entries", "20")
    .option("--json", "Emit JSON instead of a table (for scripts)")
    .option("--failed", "Only show failed refreshes")
    .action((options: { limit?: string; json?: boolean; failed?: boolean }) => {
      const projectRoot = getProjectRoot();
      const ctxDir = new CtxDirectory(projectRoot);

      if (!ctxDir.exists()) {
        console.error(chalk.red("No .ctx/ directory found. Run 'ctx setup' first."));
        process.exit(1);
      }

      const records = readUsage(ctxDir);
      let refreshes = getRefreshes(records);

      if (options.failed) {
        refreshes = refreshes.filter((r) => !r.success);
      }

      const limit = Math.max(1, parseInt(options.limit ?? "20", 10) || 20);
      const shown = refreshes.slice(-limit);

      if (options.json) {
        console.log(JSON.stringify(shown, null, 2));
        return;
      }

      if (shown.length === 0) {
        console.log();
        console.log(chalk.dim("  No refresh history yet."));
        console.log(chalk.dim("  Run 'ctx sync' to create the first entry."));
        console.log();
        return;
      }

      printRefreshTable(shown);
      printTotals(refreshes);
    });
}

function printRefreshTable(rows: RefreshRecord[]): void {
  console.log();
  console.log(chalk.bold("Refresh History"));
  console.log();

  // Column widths chosen to fit a standard 120-col terminal. The "actor"
  // column is the most variable so it gets the most slack.
  const header = [
    pad("When", 17),
    pad("Actor", 26),
    pad("Trigger", 10),
    pad("Model", 22),
    pad("Tokens", 10),
    pad("Cost", 8),
    pad("Pages (+/~/-)", 14),
    "Status",
  ].join("  ");
  console.log(chalk.dim(header));
  console.log(chalk.dim("-".repeat(header.length + 5)));

  for (const r of rows) {
    const when = formatLocalTs(r.ts);
    const tokens = (r.tokens.input + r.tokens.output).toLocaleString();
    const cost = "$" + r.cost.toFixed(2);
    const pages = `${r.pages.added}/${r.pages.changed}/${r.pages.removed}`;
    const status = r.success
      ? chalk.green("ok")
      : chalk.red(`fail: ${truncate(r.error ?? "unknown", 40)}`);
    const trigger = r.forced ? chalk.yellow("force") : r.trigger;

    console.log(
      [
        pad(when, 17),
        pad(truncate(r.actor, 26), 26),
        pad(trigger, 10),
        pad(truncate(r.model, 22), 22),
        pad(tokens, 10),
        pad(cost, 8),
        pad(pages, 14),
        status,
      ].join("  ")
    );
  }
  console.log();
}

function printTotals(all: RefreshRecord[]): void {
  let totalCost = 0;
  let totalTokens = 0;
  let failures = 0;
  for (const r of all) {
    totalCost += r.cost;
    totalTokens += r.tokens.input + r.tokens.output;
    if (!r.success) failures++;
  }

  console.log(
    chalk.dim(
      `  ${all.length} refresh${all.length === 1 ? "" : "es"} total · ` +
        `${totalTokens.toLocaleString()} tokens · ` +
        `$${totalCost.toFixed(2)} total cost` +
        (failures > 0 ? ` · ${chalk.red(`${failures} failed`)}` : "")
    )
  );
  console.log();
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function formatLocalTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
