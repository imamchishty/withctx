#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";

import { findConfigFile } from "../config/loader.js";
import { CtxDirectory } from "../storage/ctx-dir.js";
import { PageManager } from "../wiki/pages.js";
import { scoreWikiFreshness } from "../quality/freshness.js";
import type { WikiPage } from "../types/page.js";

import { registerInitCommand } from "./commands/init.js";
import { registerIngestCommand } from "./commands/ingest.js";
import { registerSyncCommand } from "./commands/sync.js";
import { registerAddCommand } from "./commands/add.js";
import { registerQueryCommand } from "./commands/query.js";
import { registerChatCommand } from "./commands/chat.js";
import { registerLintCommand } from "./commands/lint.js";
import { registerPackCommand } from "./commands/pack.js";
import { registerExportCommand } from "./commands/export.js";
import { registerDiffCommand } from "./commands/diff.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSourcesCommand } from "./commands/sources.js";
import { registerReposCommand } from "./commands/repos.js";
import { registerOnboardCommand } from "./commands/onboard.js";
import { registerCostsCommand } from "./commands/costs.js";
import { registerServeCommand } from "./commands/serve.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerResetCommand } from "./commands/reset.js";
import { registerImportCommand } from "./commands/import.js";
import { registerGraphCommand } from "./commands/graph.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerImpactCommand } from "./commands/impact.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerExplainCommand } from "./commands/explain.js";
import { registerChangelogCommand } from "./commands/changelog.js";
import { registerTimelineCommand } from "./commands/timeline.js";
import { registerMetricsCommand } from "./commands/metrics.js";
import { registerFaqCommand } from "./commands/faq.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerEmbedCommand } from "./commands/embed.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerGoCommand } from "./commands/go.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerGlossaryCommand } from "./commands/glossary.js";
import { registerWhoCommand } from "./commands/who.js";

// Global verbosity state — commands can import and check this
export const globalState = {
  verbose: false,
  quiet: false,
};

// Resolve package.json for version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

// ---------------------------------------------------------------------------
// Smart grouped help — replaces Commander's wall-of-text default
// ---------------------------------------------------------------------------

const GROUPED_HELP: Array<{ heading: string; commands: Array<[string, string]> }> = [
  {
    heading: "Getting Started",
    commands: [
      ["ctx go", "One command: init + ingest your project"],
      ["ctx setup", "Interactive setup wizard"],
      ["ctx init", "Initialize a new .ctx directory"],
      ["ctx add <source>", "Add a source (github, jira, confluence...)"],
    ],
  },
  {
    heading: "Daily Use",
    commands: [
      ["ctx sync", "Re-sync sources and update wiki"],
      ["ctx query <question>", "Ask a question about your project"],
      ["ctx chat", "Interactive chat with your wiki"],
      ["ctx search <term>", "Search across all wiki pages"],
      ["ctx status", "Wiki health dashboard"],
    ],
  },
  {
    heading: "For New Team Members",
    commands: [
      ["ctx onboard", "Generate a personalised onboarding guide"],
      ["ctx glossary", "Auto-generate project glossary"],
      ["ctx who [area]", "Show who owns what"],
      ["ctx faq", "Auto-generate FAQ from project knowledge"],
    ],
  },
  {
    heading: "Code Intelligence",
    commands: [
      ["ctx review [pr]", "AI-powered code review"],
      ["ctx explain <file>", "Explain any file or function"],
      ["ctx impact <file>", "Analyse blast radius of changes"],
      ["ctx diff", "Show what changed since last sync"],
      ["ctx graph", "Visualise dependency graph"],
      ["ctx metrics", "Project health metrics"],
    ],
  },
  {
    heading: "Exports & Integration",
    commands: [
      ["ctx export", "Export wiki in various formats"],
      ["ctx pack", "Pack context for AI agents"],
      ["ctx mcp", "Start MCP server for AI tools"],
      ["ctx embed", "Generate vector embeddings"],
      ["ctx import", "Import external docs into the wiki"],
      ["ctx serve", "Start a local web server for the wiki"],
    ],
  },
  {
    heading: "Admin",
    commands: [
      ["ctx config", "View/edit configuration"],
      ["ctx costs", "Show API usage and costs"],
      ["ctx doctor", "Diagnose setup issues"],
      ["ctx reset", "Reset wiki and re-compile"],
      ["ctx sources", "List configured sources"],
      ["ctx repos", "List configured repositories"],
      ["ctx lint", "Lint wiki pages for quality"],
      ["ctx watch", "Watch for file changes and auto-sync"],
      ["ctx changelog", "Generate changelog from git history"],
      ["ctx timeline", "Show project activity timeline"],
      ["ctx ingest", "Ingest sources into wiki (low-level)"],
    ],
  },
];

function printGroupedHelp(): void {
  const COL_WIDTH = 26;

  console.log();
  console.log(chalk.bold(`withctx v${pkg.version}`) + chalk.dim(" — AI-compiled project wiki"));
  console.log();

  for (const group of GROUPED_HELP) {
    console.log(chalk.bold.underline(`  ${group.heading}`));
    for (const [cmd, desc] of group.commands) {
      const padding = Math.max(2, COL_WIDTH - cmd.length);
      console.log(`    ${chalk.cyan(cmd)}${" ".repeat(padding)}${chalk.dim(desc)}`);
    }
    console.log();
  }

  console.log(chalk.dim(`  Run 'ctx <command> --help' for detailed usage.`));
  console.log(chalk.dim(`  Docs: https://github.com/imamchishty/withctx`));
  console.log();
}

// ---------------------------------------------------------------------------
// Program setup
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("ctx")
  .description(
    "Compiled context layer for AI agents — Claude compiles your project knowledge into a living wiki"
  )
  .version(pkg.version, "-v, --version")
  .option("--verbose", "Show detailed output for all commands")
  .option("--quiet", "Suppress non-essential output")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) globalState.verbose = true;
    if (opts.quiet) globalState.quiet = true;
  });

// Override the default help command so `ctx` and `ctx help` show grouped output
program.configureHelp({
  formatHelp: () => "",            // suppress Commander's default help text
});
program.addHelpText("beforeAll", () => {
  printGroupedHelp();
  return "";
});

// Smart default — detect user's state and show most relevant next action
program.action(() => {
  printSmartDefault();
});

// Explicit `ctx help` subcommand — always shows the full grouped help
program
  .command("help")
  .description("Show all commands grouped by purpose")
  .action(() => {
    printGroupedHelp();
  });

// ---------------------------------------------------------------------------
// Smart default — state detection for `ctx` with no arguments
// ---------------------------------------------------------------------------

type CtxState = "fresh" | "initialised" | "wiki";

interface WikiStats {
  pageCount: number;
  lastSyncMs: number | null;
  fresh: number;
  aging: number;
  stale: number;
}

function detectState(): { state: CtxState; configPath: string | null; projectRoot: string | null; stats: WikiStats | null } {
  const configPath = findConfigFile();

  if (!configPath) {
    return { state: "fresh", configPath: null, projectRoot: null, stats: null };
  }

  const projectRoot = resolve(configPath, "..");
  const ctxDir = new CtxDirectory(projectRoot);

  if (!ctxDir.exists()) {
    return { state: "initialised", configPath, projectRoot, stats: null };
  }

  const stats = collectWikiStats(ctxDir);
  if (stats.pageCount === 0) {
    return { state: "initialised", configPath, projectRoot, stats: null };
  }

  return { state: "wiki", configPath, projectRoot, stats };
}

function collectWikiStats(ctxDir: CtxDirectory): WikiStats {
  const pageManager = new PageManager(ctxDir);

  // Count pages — exclude index.md, log.md, and glossary.md
  const allPagePaths = pageManager.list();
  const contentPagePaths = allPagePaths.filter((p) => {
    const base = p.split("/").pop() ?? p;
    return base !== "index.md" && base !== "log.md" && base !== "glossary.md";
  });

  let lastSyncMs: number | null = null;
  const pages: WikiPage[] = [];

  for (const pagePath of contentPagePaths) {
    const full = join(ctxDir.contextPath, pagePath);
    try {
      const stat = statSync(full);
      const mtime = stat.mtimeMs;
      if (lastSyncMs === null || mtime > lastSyncMs) {
        lastSyncMs = mtime;
      }
      const page = pageManager.read(pagePath);
      if (page) pages.push(page);
    } catch {
      // ignore stat errors
    }
  }

  const freshnessScores = scoreWikiFreshness(pages);
  let fresh = 0;
  let aging = 0;
  let stale = 0;
  for (const s of freshnessScores) {
    if (s.score === "fresh") fresh++;
    else if (s.score === "aging") aging++;
    else if (s.score === "stale") stale++;
  }

  return {
    pageCount: contentPagePaths.length,
    lastSyncMs,
    fresh,
    aging,
    stale,
  };
}

function formatRelativeTime(ms: number): string {
  const diffMs = Date.now() - ms;
  if (diffMs < 0) return "just now";

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (diffMs < minute) return "just now";
  if (diffMs < hour) {
    const mins = Math.floor(diffMs / minute);
    return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  }
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (diffMs < week) {
    const days = Math.floor(diffMs / day);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  const weeks = Math.floor(diffMs / week);
  return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
}

function printSmartDefault(): void {
  const { state, stats } = detectState();

  console.log();

  if (state === "fresh") {
    console.log(chalk.bold(`Welcome to withctx!`));
    console.log();
    console.log(chalk.dim("  withctx compiles your project knowledge (code, Jira, Confluence, Slack, ...)"));
    console.log(chalk.dim("  into a maintained wiki for your team and AI agents."));
    console.log();
    console.log("  Get started:");
    console.log();
    console.log(`    ${chalk.cyan("ctx go")}              ${chalk.dim("One command: init + ingest your project")}`);
    console.log(`    ${chalk.cyan("ctx setup")}           ${chalk.dim("Interactive setup wizard")}`);
    console.log(`    ${chalk.cyan("ctx init")}            ${chalk.dim("Manual init (creates ctx.yaml)")}`);
    console.log();
    console.log(`  ${chalk.dim("Learn more:")}  ${chalk.cyan("ctx help")}`);
    console.log(`  ${chalk.dim("Docs:")}        ${chalk.dim("https://github.com/imamchishty/withctx")}`);
    console.log();
    return;
  }

  if (state === "initialised") {
    console.log(chalk.bold("withctx is set up but your wiki is empty."));
    console.log();
    console.log("  Next step:");
    console.log();
    console.log(`    ${chalk.cyan("ctx sync")}           ${chalk.dim("Fetch sources and compile the wiki")}`);
    console.log(`    ${chalk.cyan("ctx doctor")}         ${chalk.dim("Check your configuration")}`);
    console.log();
    console.log(chalk.dim("  Tip: Run 'ctx status' after sync to see your wiki health."));
    console.log();
    return;
  }

  // state === "wiki"
  const s = stats!;
  console.log(chalk.bold("withctx") + chalk.dim(" — your project wiki"));
  console.log();

  const lastSync = s.lastSyncMs !== null ? formatRelativeTime(s.lastSyncMs) : "never";

  console.log(`  ${chalk.dim("Pages:")}        ${chalk.bold(String(s.pageCount))}`);
  console.log(`  ${chalk.dim("Last sync:")}    ${lastSync}`);
  console.log(
    `  ${chalk.dim("Freshness:")}    ${chalk.green(`${s.fresh} fresh`)}, ${chalk.yellow(`${s.aging} aging`)}, ${chalk.red(`${s.stale} stale`)}`
  );
  console.log();
  console.log("  What now?");
  console.log();
  console.log(`    ${chalk.cyan('ctx query "..."')}    ${chalk.dim("Ask a question")}`);
  console.log(`    ${chalk.cyan("ctx status")}         ${chalk.dim("Full dashboard")}`);
  console.log(`    ${chalk.cyan("ctx sync")}           ${chalk.dim("Refresh from sources")}`);
  console.log(`    ${chalk.cyan("ctx onboard")}        ${chalk.dim("Personalised onboarding guide")}`);
  console.log(`    ${chalk.cyan("ctx help")}           ${chalk.dim("All commands")}`);
  console.log();
}

// Register all subcommands
registerInitCommand(program);
registerIngestCommand(program);
registerSyncCommand(program);
registerAddCommand(program);
registerQueryCommand(program);
registerChatCommand(program);
registerLintCommand(program);
registerPackCommand(program);
registerExportCommand(program);
registerDiffCommand(program);
registerStatusCommand(program);
registerSourcesCommand(program);
registerReposCommand(program);
registerOnboardCommand(program);
registerCostsCommand(program);
registerServeCommand(program);
registerDoctorCommand(program);
registerWatchCommand(program);
registerResetCommand(program);
registerImportCommand(program);
registerGraphCommand(program);
registerConfigCommand(program);
registerImpactCommand(program);
registerReviewCommand(program);
registerExplainCommand(program);
registerChangelogCommand(program);
registerTimelineCommand(program);
registerMetricsCommand(program);
registerFaqCommand(program);
registerMcpCommand(program);
registerEmbedCommand(program);
registerSearchCommand(program);
registerGoCommand(program);
registerSetupCommand(program);
registerGlossaryCommand(program);
registerWhoCommand(program);

program.parse(process.argv);
