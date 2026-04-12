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
import { registerGlossaryCommand } from "./commands/glossary.js";
import { registerWhoCommand } from "./commands/who.js";
import { registerTodosCommand } from "./commands/todos.js";
import { registerPublishCommand } from "./commands/publish.js";
import { registerHistoryCommand } from "./commands/history.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerApproveCommand } from "./commands/approve.js";
import { registerWhyCommand } from "./commands/why.js";
import { registerVerifyCommand } from "./commands/verify.js";
import { registerTeachCommand } from "./commands/teach.js";
import { registerLlmCommand } from "./commands/llm.js";
import { applyAskRewrite } from "./ask-dispatcher.js";
import { initNetwork } from "../connectors/network-bootstrap.js";

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
// 12 canonical verbs — everything else is a hidden alias
// ---------------------------------------------------------------------------
//
// withctx has accumulated a lot of verbs over the years. Most are aliases
// of one of these twelve. Every command that doesn't appear below is still
// registered and still runs — they just don't show up in `ctx help` or
// `ctx help --all`, so new users aren't buried.
//
//   1.  setup    — bootstrap a project                 (aliases: init, go, reset)
//   2.  doctor   — diagnose environment
//   3.  sync     — refresh the wiki                    (aliases: ingest, watch)
//   4.  ask      — ask the wiki anything               (aliases: query, chat, search, grep, who, why, explain, faq, onboard)
//   5.  status   — wiki health dashboard               (absorbs: metrics, costs, history, todos, impact, timeline, changelog, diff)
//   6.  lint     — consistency + safety checks
//   7.  approve  — sign off on a page                  (alias: bless)
//   8.  verify   — check assertions against the tree
//   9.  review   — drift check / PR review
//   10. teach    — quiz on wiki content
//   11. pack     — emit bundles for agents / CI        (absorbs: export, publish, embed, snapshot, serve, mcp)
//   12. config   — view / edit configuration           (absorbs: sources, repos)
//
// Two help surfaces:
//
//   `ctx help`        → the CORE 12, one screen.
//   `ctx help --all`  → the 12 again, grouped by purpose, with a one-line
//                       note about which old verbs are now flags or aliases.

const CORE_HELP: Array<{ heading: string; commands: Array<[string, string]> }> = [
  {
    heading: "Start",
    commands: [
      ["ctx setup", "Detect sources, write ctx.yaml, compile the wiki"],
      ["ctx doctor", "Diagnose setup, credentials and dependencies"],
      ["ctx llm", "Check LLM connectivity (provider, model, latency)"],
      ["ctx config", "View or edit configuration (sources, repos, keys)"],
    ],
  },
  {
    heading: "Use",
    commands: [
      ["ctx sync", "Refresh the wiki from sources (incremental)"],
      ["ctx ask \"...\"", "Ask the wiki anything (--chat / --search / --who)"],
      ["ctx status", "Wiki health dashboard"],
      ["ctx lint", "Check the wiki for contradictions, drift, secrets"],
    ],
  },
  {
    heading: "Trust",
    commands: [
      ["ctx approve <page>", "Sign off on a page (human review)"],
      ["ctx verify [page]", "Check the page's claims against the live tree"],
      ["ctx review <pr>", "Drift check a PR against approved pages"],
      ["ctx teach [page]", "Drill yourself on the wiki's content"],
    ],
  },
  {
    heading: "Ship",
    commands: [
      ["ctx pack", "Pack the wiki for agents (--format, --mcp, --serve)"],
      ["ctx help --all", "Show the 12 verbs grouped by purpose"],
    ],
  },
];

const GROUPED_HELP: Array<{ heading: string; commands: Array<[string, string]> }> = [
  {
    heading: "Getting started",
    commands: [
      ["ctx setup", "Detect sources, write ctx.yaml, compile the wiki"],
      ["ctx doctor", "Diagnose setup, credentials and dependencies"],
      ["ctx llm", "Check LLM connectivity — one ping, clear yes/no"],
      ["ctx config", "View / edit configuration (absorbs sources, repos)"],
    ],
  },
  {
    heading: "Daily use",
    commands: [
      ["ctx sync", "Refresh from sources (--full, --watch, --note)"],
      ["ctx ask \"...\"", "Query the wiki (--chat, --search, --grep, --who, --why)"],
      ["ctx status", "Wiki health dashboard (--json, --todos, --impact, --metrics)"],
      ["ctx lint", "Consistency / safety checks (--fix, --verify, --redaction)"],
    ],
  },
  {
    heading: "Trust pipeline",
    commands: [
      ["ctx approve <page>", "Human review stamp (tier: manual → asserted)"],
      ["ctx verify [page]", "Assertion engine (tier: asserted → verified)"],
      ["ctx review <pr>", "Drift check a PR (--drift is zero-cost, CI-safe)"],
      ["ctx teach [page]", "LLM-free flashcard quiz on wiki content"],
    ],
  },
  {
    heading: "Ship to agents",
    commands: [
      ["ctx pack", "Emit CLAUDE.md / system-prompt / RAG JSONL / HTML / MCP"],
    ],
  },
];

function renderHelpGroups(
  groups: Array<{ heading: string; commands: Array<[string, string]> }>
): void {
  const COL_WIDTH = 24;
  for (const group of groups) {
    console.log(chalk.bold.underline(`  ${group.heading}`));
    for (const [cmd, desc] of group.commands) {
      const padding = Math.max(2, COL_WIDTH - cmd.length);
      console.log(`    ${chalk.cyan(cmd)}${" ".repeat(padding)}${chalk.dim(desc)}`);
    }
    console.log();
  }
}

/**
 * Print the compact core help — 12 commands, one screen, no overwhelm.
 * Shown by `ctx help` with no flags, and by `ctx <no-args>` for first-time users.
 */
function printCoreHelp(): void {
  console.log();
  console.log(chalk.bold(`withctx v${pkg.version}`) + chalk.dim(" — AI-compiled project wiki"));
  console.log();
  renderHelpGroups(CORE_HELP);
  console.log(chalk.dim(`  Run 'ctx <command> --help' for detailed usage.`));
  console.log(chalk.dim(`  Run 'ctx help --all' to see the 12 verbs grouped by purpose.`));
  console.log(chalk.dim(`  Docs: https://github.com/imamchishty/withctx`));
  console.log();
}

/**
 * Print the full grouped help — every registered command. Behind
 * `--all` so it doesn't ambush new users.
 */
function printFullHelp(): void {
  console.log();
  console.log(
    chalk.bold(`withctx v${pkg.version}`) +
      chalk.dim(" — every command, grouped by purpose")
  );
  console.log();
  renderHelpGroups(GROUPED_HELP);
  console.log(chalk.dim(`  Run 'ctx <command> --help' for detailed usage.`));
  console.log(chalk.dim(`  Run 'ctx help' for the short list.`));
  console.log(chalk.dim(`  Docs: https://github.com/imamchishty/withctx`));
  console.log();
}

/**
 * Legacy entry point kept for back-compat with any internal callers.
 * Prefer `printCoreHelp` / `printFullHelp`.
 */
function printGroupedHelp(): void {
  printCoreHelp();
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
  printCoreHelp();
  return "";
});

// Smart default — detect user's state and show most relevant next action
program.action(() => {
  printSmartDefault();
});

// `ctx help` → compact core set.
// `ctx help --all` → full grouped list of every command.
program
  .command("help")
  .description("Show the core commands. Use --all for the full list.")
  .option("--all", "Show every command, grouped by purpose")
  .action((opts: { all?: boolean }) => {
    if (opts.all) {
      printFullHelp();
    } else {
      printCoreHelp();
    }
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
    console.log(`    ${chalk.cyan("ctx setup")}           ${chalk.dim("Detect sources, write ctx.yaml, compile the wiki")}`);
    console.log(`    ${chalk.cyan("ctx doctor")}          ${chalk.dim("Check Node version, API keys, dependencies")}`);
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
  console.log(`    ${chalk.cyan('ctx ask "..."')}      ${chalk.dim("Ask the wiki a question")}`);
  console.log(`    ${chalk.cyan("ctx status")}         ${chalk.dim("Full dashboard")}`);
  console.log(`    ${chalk.cyan("ctx sync")}           ${chalk.dim("Refresh from sources")}`);
  console.log(`    ${chalk.cyan("ctx teach")}          ${chalk.dim("Drill yourself on the wiki")}`);
  console.log(`    ${chalk.cyan("ctx help")}           ${chalk.dim("All 12 verbs")}`);
  console.log();
}

// Register all subcommands.
// `ctx setup` (with `init` and `go` as aliases) is registered by
// registerGoCommand — the three names all hit the same action.
registerGoCommand(program);
registerPublishCommand(program);
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
registerGlossaryCommand(program);
registerWhoCommand(program);
registerTodosCommand(program);
registerHistoryCommand(program);
registerCompletionCommand(program);
registerApproveCommand(program);
registerWhyCommand(program);
registerVerifyCommand(program);
registerTeachCommand(program);
registerLlmCommand(program);

// ── Global error handling ────────────────────────────────────────────
//
// Every CtxError thrown from a command lands here. We render it using
// the standard "Error (CODE): ... To fix: ..." block so users never
// see a raw stack trace for a recoverable problem. Non-CtxErrors
// fall through to Commander's default behaviour (stderr + exit 1).
//
// IMPORTANT: rejectionHandler has to live here, BEFORE program.parse(),
// because Commander wraps async actions in promises that reject on
// throw, and without this handler Node prints the default
// "UnhandledPromiseRejection" warning before our nice error block.
// Renders a CtxError + exits with the right sysexits code. Shared by
// the sync and async handlers so both code paths produce identical
// output for a given error.
async function renderErrorAndExit(reason: unknown): Promise<never> {
  const { isCtxError, formatCtxError, EXIT_CODES } = await import("../errors.js");
  if (isCtxError(reason)) {
    const colour = process.stderr.isTTY === true;
    process.stderr.write(formatCtxError(reason, { colour }) + "\n");
    process.exit(EXIT_CODES[reason.code] ?? 1);
  }
  // Non-CtxError: preserve the stack so crashes remain debuggable,
  // but prefix so users know it came from withctx.
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  process.stderr.write(`withctx crashed: ${msg}\n`);
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  void renderErrorAndExit(reason);
});
process.on("uncaughtException", (reason) => {
  void renderErrorAndExit(reason);
});

// Rewrite `ctx ask ...` to the appropriate legacy verb before
// Commander parses argv. A no-op for every other invocation.
applyAskRewrite(process.argv);

// Initialise global fetch dispatcher (proxy + TLS) before any command
// constructs a connector. We await the init so undici's dispatcher is
// installed before the first connector awaits fetch(). If it fails we
// still let the CLI run — the diagnostic will surface in `ctx doctor`.
try {
  await initNetwork();
} catch (err) {
  process.stderr.write(
    `[withctx] network bootstrap failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
}

try {
  program.parse(process.argv);
} catch (err) {
  void renderErrorAndExit(err);
}
