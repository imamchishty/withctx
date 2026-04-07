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
  .version(pkg.version, "-v, --version");

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

program.parse(process.argv);
