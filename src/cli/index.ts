#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import chalk from "chalk";

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

// Also show grouped help when invoked with no arguments
program.action(() => {
  printGroupedHelp();
});

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
