import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import {
  readUsage,
  getCalls,
  getSnapshots,
  type CallRecord,
  type SnapshotRecord,
} from "../../usage/recorder.js";
import * as ui from "../utils/ui.js";

interface CostsOptions {
  json?: boolean;
  days?: string;
}

export function registerCostsCommand(program: Command): void {
  program
    .command("costs")
    .description("Token usage history, cost report and wiki growth")
    .option("--json", "Emit machine-readable JSON")
    .option("--days <n>", "Number of days for charts (default: 30)", "30")
    .action(async (options: CostsOptions) => {
      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          ui.error("No .ctx/ directory found.", "Run 'ctx setup' first.");
          process.exit(1);
        }

        const records = readUsage(ctxDir);
        const calls = getCalls(records);
        const snapshots = getSnapshots(records);
        const days = Math.max(1, parseInt(options.days ?? "30", 10) || 30);

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                summary: summariseCalls(calls),
                budget: budgetInfo(calls, config),
                operations: byOperation(calls),
                dailyCost: dailyCostSeries(calls, days),
                wikiGrowth: snapshots,
              },
              null,
              2
            )
          );
          return;
        }

        if (calls.length === 0 && snapshots.length === 0) {
          console.log();
          ui.info("No usage history yet.");
          console.log(
            chalk.dim(
              "  Token usage is recorded automatically once you run ingest, sync, query or any AI command."
            )
          );
          console.log();
          return;
        }

        renderTerminal(calls, snapshots, config, days);
      } catch (error) {
        ui.error(
          "Failed to load cost data",
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTerminal(
  calls: CallRecord[],
  snapshots: SnapshotRecord[],
  config: { costs?: { budget?: number; alert_at?: number } },
  days: number
): void {
  const summary = summariseCalls(calls);
  const monthCost = currentMonthCost(calls);
  const monthKey = new Date().toISOString().slice(0, 7);

  console.log();
  ui.heading("Cost Report");
  console.log();

  // ---- Summary block ------------------------------------------------------
  const summaryRows: Array<[string, string]> = [
    ["Lifetime spend", `$${summary.totalCost.toFixed(4)}`],
    ["This month", `$${monthCost.toFixed(4)}  ${chalk.dim(`(${monthKey})`)}`],
    ["Total calls", String(summary.totalCalls)],
    [
      "Total tokens",
      `${formatNumber(summary.totalIn + summary.totalOut)} ` +
        chalk.dim(
          `(${formatNumber(summary.totalIn)} in / ${formatNumber(summary.totalOut)} out)`
        ),
    ],
  ];
  if (summary.cacheRead > 0) {
    summaryRows.push([
      "Cache savings",
      `${formatNumber(summary.cacheRead)} cached tokens ` +
        chalk.dim(`(~$${summary.cacheSavings.toFixed(4)} saved)`),
    ]);
  }
  console.log(ui.keyValue(summaryRows));
  console.log();

  // ---- Budget bar ---------------------------------------------------------
  const budget = config.costs?.budget;
  if (budget) {
    const alertAt = config.costs?.alert_at ?? 80;
    const pct = Math.min(100, (monthCost / budget) * 100);
    const bar = renderBar(pct, 40);
    const colour = pct >= alertAt ? chalk.red : pct >= alertAt * 0.7 ? chalk.yellow : chalk.green;
    ui.subheading("Budget");
    console.log(
      `  ${colour(bar)} ${colour(`${pct.toFixed(1)}%`)}  ${chalk.dim(`$${monthCost.toFixed(2)} / $${budget}`)}`
    );
    if (pct >= alertAt) {
      console.log(
        chalk.red(`  Over alert threshold (${alertAt}%) — consider raising budget or running fewer ops.`)
      );
    }
    console.log();
  }

  // ---- Per-operation bars -------------------------------------------------
  const ops = byOperation(calls);
  if (ops.length > 0) {
    ui.subheading("By operation (lifetime)");
    const maxCost = Math.max(...ops.map((o) => o.cost));
    const nameWidth = Math.max(...ops.map((o) => o.op.length));
    for (const o of ops) {
      const bar = renderBar((o.cost / maxCost) * 100, 30);
      console.log(
        `  ${chalk.cyan(o.op.padEnd(nameWidth))}  ${bar}  ${chalk.bold(`$${o.cost.toFixed(4)}`)}  ${chalk.dim(`${o.count} call${o.count === 1 ? "" : "s"} · ${formatNumber(o.tokens)} tok`)}`
      );
    }
    console.log();
  }

  // ---- Cost sparkline (last N days) --------------------------------------
  const series = dailyCostSeries(calls, days);
  if (series.some((p) => p.cost > 0)) {
    ui.subheading(`Daily cost (last ${days} days)`);
    console.log("  " + sparkline(series.map((p) => p.cost)));
    const totalSpan = series.reduce((s, p) => s + p.cost, 0);
    const peak = series.reduce((m, p) => (p.cost > m.cost ? p : m));
    console.log(
      chalk.dim(
        `  span: $${totalSpan.toFixed(4)}  ·  peak day: ${peak.day} ($${peak.cost.toFixed(4)})`
      )
    );
    console.log();
  }

  // ---- Wiki growth (snapshots) -------------------------------------------
  if (snapshots.length >= 1) {
    ui.subheading("Wiki growth");
    const recent = snapshots.slice(-Math.min(snapshots.length, 8));
    const maxPages = Math.max(...recent.map((s) => s.wikiPages), 1);
    for (const s of recent) {
      const bar = renderBar((s.wikiPages / maxPages) * 100, 24);
      const date = s.ts.slice(0, 10);
      console.log(
        `  ${chalk.dim(date)}  ${bar}  ${chalk.bold(String(s.wikiPages))} pages  ${chalk.dim(`from ${s.sourceDocs} docs · ${formatBytes(s.bytes)}`)}`
      );
    }
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    if (first !== last) {
      const pageDelta = last.wikiPages - first.wikiPages;
      const docDelta = last.sourceDocs - first.sourceDocs;
      console.log(
        chalk.dim(
          `  growth: ${signed(pageDelta)} pages, ${signed(docDelta)} source docs since ${first.ts.slice(0, 10)}`
        )
      );
    }
    console.log();
  }

  // ---- Recent activity ---------------------------------------------------
  if (calls.length > 0) {
    ui.subheading("Recent activity");
    const recent = calls.slice(-8).reverse();
    for (const c of recent) {
      const time = new Date(c.ts).toLocaleString();
      const tokenStr = `${formatNumber(c.in + c.out)} tok`;
      console.log(
        `  ${chalk.dim(time)}  ${chalk.cyan(c.op.padEnd(10))}  ${tokenStr.padStart(10)}  ${chalk.dim(`$${c.cost.toFixed(4)}`)}`
      );
    }
    console.log();
  }

  console.log(chalk.dim(`  History file: .ctx/usage.jsonl  (${calls.length} calls, ${snapshots.length} snapshots)`));
  console.log();
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

function summariseCalls(calls: CallRecord[]): {
  totalCost: number;
  totalCalls: number;
  totalIn: number;
  totalOut: number;
  cacheRead: number;
  cacheSavings: number;
} {
  let totalCost = 0;
  let totalIn = 0;
  let totalOut = 0;
  let cacheRead = 0;
  for (const c of calls) {
    totalCost += c.cost;
    totalIn += c.in;
    totalOut += c.out;
    cacheRead += c.cacheRead ?? 0;
  }
  // Estimated savings: cached tokens billed at ~10% of fresh input rate
  // (3 - 0.3 = 2.7 / M for sonnet). Use a flat 2.7/M as a representative average.
  const cacheSavings = (cacheRead / 1_000_000) * 2.7;
  return { totalCost, totalCalls: calls.length, totalIn, totalOut, cacheRead, cacheSavings };
}

function currentMonthCost(calls: CallRecord[]): number {
  const m = new Date().toISOString().slice(0, 7);
  return calls.filter((c) => c.ts.startsWith(m)).reduce((s, c) => s + c.cost, 0);
}

function byOperation(
  calls: CallRecord[]
): Array<{ op: string; count: number; tokens: number; cost: number }> {
  const map = new Map<string, { count: number; tokens: number; cost: number }>();
  for (const c of calls) {
    const e = map.get(c.op) ?? { count: 0, tokens: 0, cost: 0 };
    e.count++;
    e.tokens += c.in + c.out;
    e.cost += c.cost;
    map.set(c.op, e);
  }
  return Array.from(map.entries())
    .map(([op, v]) => ({ op, ...v }))
    .sort((a, b) => b.cost - a.cost);
}

function dailyCostSeries(
  calls: CallRecord[],
  days: number
): Array<{ day: string; cost: number }> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const series: Array<{ day: string; cost: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    series.push({ day: d.toISOString().slice(0, 10), cost: 0 });
  }
  const idx = new Map(series.map((p, i) => [p.day, i]));
  for (const c of calls) {
    const day = c.ts.slice(0, 10);
    const i = idx.get(day);
    if (i !== undefined) series[i].cost += c.cost;
  }
  return series;
}

function budgetInfo(
  calls: CallRecord[],
  config: { costs?: { budget?: number; alert_at?: number } }
): { budget: number; spent: number; pct: number; alertAt: number } | null {
  const budget = config.costs?.budget;
  if (!budget) return null;
  const spent = currentMonthCost(calls);
  return {
    budget,
    spent,
    pct: (spent / budget) * 100,
    alertAt: config.costs?.alert_at ?? 80,
  };
}

// ---------------------------------------------------------------------------
// Visualisation primitives
// ---------------------------------------------------------------------------

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max === 0) return SPARK_CHARS[0].repeat(values.length);
  return values
    .map((v) => {
      const idx = Math.min(
        SPARK_CHARS.length - 1,
        Math.round((v / max) * (SPARK_CHARS.length - 1))
      );
      return v === 0 ? chalk.dim(SPARK_CHARS[0]) : chalk.cyan(SPARK_CHARS[idx]);
    })
    .join("");
}

function renderBar(pct: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return chalk.cyan("█".repeat(filled)) + chalk.dim("░".repeat(empty));
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}
