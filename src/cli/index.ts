#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

program.parse(process.argv);
