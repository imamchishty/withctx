import { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CtxConfigSchema } from "../../types/config.js";
import { findConfigFile, loadConfig, getProjectRoot } from "../../config/loader.js";
import { ConnectorRegistry } from "../../connectors/registry.js";
import { LocalFilesConnector } from "../../connectors/local-files.js";

/**
 * Get a nested value from an object using dot notation.
 * e.g., getDeep({ costs: { budget: 10 } }, "costs.budget") => 10
 */
function getDeep(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Set a nested value in an object using dot notation.
 * e.g., setDeep({}, "costs.budget", 10) => { costs: { budget: 10 } }
 */
function setDeep(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * Parse a string value to its appropriate type.
 */
function parseValue(value: string): unknown {
  // Boolean
  if (value === "true") return true;
  if (value === "false") return false;

  // Number
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== "") return num;

  // String
  return value;
}

function showConfigSummary(config: ReturnType<typeof loadConfig>): void {
  console.log();
  console.log(chalk.bold("Current Configuration"));
  console.log(chalk.dim("─".repeat(40)));
  console.log();

  console.log(`  ${chalk.bold("Project:")}   ${chalk.cyan(config.project)}`);
  console.log();

  // Sources
  console.log(chalk.bold("  Sources:"));
  const localSources = config.sources?.local ?? [];
  if (localSources.length > 0) {
    for (const source of localSources) {
      console.log(`    ${chalk.cyan("local")} / ${source.name} ${chalk.dim(`(${source.path})`)}`);
    }
  }
  const jiraSources = config.sources?.jira ?? [];
  for (const source of jiraSources) {
    console.log(`    ${chalk.cyan("jira")} / ${source.name} ${chalk.dim(`(${source.base_url})`)}`);
  }
  const confluenceSources = config.sources?.confluence ?? [];
  for (const source of confluenceSources) {
    console.log(`    ${chalk.cyan("confluence")} / ${source.name} ${chalk.dim(`(${source.base_url})`)}`);
  }
  const githubSources = config.sources?.github ?? [];
  for (const source of githubSources) {
    console.log(`    ${chalk.cyan("github")} / ${source.name} ${chalk.dim(`(${source.owner})`)}`);
  }
  const teamsSources = config.sources?.teams ?? [];
  for (const source of teamsSources) {
    console.log(`    ${chalk.cyan("teams")} / ${source.name} ${chalk.dim(`(${source.tenant_id})`)}`);
  }

  const totalSources =
    localSources.length + jiraSources.length + confluenceSources.length + githubSources.length + teamsSources.length;
  if (totalSources === 0) {
    console.log(chalk.dim("    (none configured)"));
  }
  console.log();

  // Costs
  console.log(chalk.bold("  Costs:"));
  console.log(`    Budget:    ${chalk.cyan(`$${config.costs?.budget ?? "not set"}`)}`);
  console.log(`    Alert at:  ${chalk.cyan(`${config.costs?.alert_at ?? 80}%`)}`);
  console.log(`    Model:     ${chalk.cyan(config.costs?.model ?? "claude-sonnet-4")}`);
  console.log();

  // Repos
  if (config.repos && config.repos.length > 0) {
    console.log(chalk.bold("  Repos:"));
    for (const repo of config.repos) {
      console.log(`    ${repo.name} ${chalk.dim(`(${repo.github})`)}`);
    }
    console.log();
  }
}

async function showSourceStatus(config: ReturnType<typeof loadConfig>, projectRoot: string): Promise<void> {
  console.log();
  console.log(chalk.bold("Source Connection Status"));
  console.log(chalk.dim("─".repeat(40)));
  console.log();

  const registry = new ConnectorRegistry();

  // Register local sources
  if (config.sources?.local) {
    for (const source of config.sources.local) {
      const resolvedPath = source.path.startsWith(".")
        ? `${projectRoot}/${source.path}`
        : source.path;
      registry.register(new LocalFilesConnector(source.name, resolvedPath));
    }
  }

  const connectors = registry.getAll();
  if (connectors.length === 0) {
    console.log(chalk.dim("  No local sources configured."));
  }

  for (const connector of connectors) {
    const valid = await connector.validate();
    const status = connector.getStatus();
    const icon = valid ? chalk.green("OK") : chalk.red("FAIL");
    console.log(
      `  ${icon}  ${chalk.cyan(connector.name)} (${connector.type})${!valid ? chalk.dim(` — ${status.error}`) : ""}`
    );
  }

  // Show external sources that would need validation
  const externalTypes: Array<{ type: string; sources: Array<{ name: string }> }> = [];
  if (config.sources?.jira?.length) externalTypes.push({ type: "jira", sources: config.sources.jira });
  if (config.sources?.confluence?.length) externalTypes.push({ type: "confluence", sources: config.sources.confluence });
  if (config.sources?.github?.length) externalTypes.push({ type: "github", sources: config.sources.github });
  if (config.sources?.teams?.length) externalTypes.push({ type: "teams", sources: config.sources.teams });

  for (const ext of externalTypes) {
    for (const source of ext.sources) {
      console.log(
        `  ${chalk.yellow("?")}  ${chalk.cyan(source.name)} (${ext.type}) ${chalk.dim("— connector not yet implemented")}`
      );
    }
  }

  console.log();
}

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command("config")
    .description("View and manage ctx.yaml configuration");

  // Default action: show summary
  configCmd.action(async () => {
    try {
      const config = loadConfig();
      showConfigSummary(config);
    } catch (error) {
      console.error(chalk.red("Failed to load config"));
      if (error instanceof Error) {
        console.error(chalk.red(`  ${error.message}`));
      }
      process.exit(1);
    }
  });

  // ctx config get <key>
  configCmd
    .command("get <key>")
    .description("Get a specific config value (e.g., costs.budget)")
    .action(async (key: string) => {
      try {
        const configPath = findConfigFile();
        if (!configPath) {
          console.error(chalk.red("No ctx.yaml found. Run 'ctx setup' first."));
          process.exit(1);
        }

        const raw = readFileSync(configPath, "utf-8");
        const parsed = parseYaml(raw) as Record<string, unknown>;
        const value = getDeep(parsed, key);

        if (value === undefined) {
          console.error(chalk.yellow(`Key '${key}' not found in config.`));
          process.exit(1);
        }

        if (typeof value === "object" && value !== null) {
          console.log(stringifyYaml(value as Record<string, unknown>).trim());
        } else {
          console.log(String(value));
        }
      } catch (error) {
        console.error(chalk.red("Failed to get config value"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });

  // ctx config set <key> <value>
  configCmd
    .command("set <key> <value>")
    .description("Set a specific config value (e.g., costs.budget 20)")
    .action(async (key: string, value: string) => {
      try {
        const configPath = findConfigFile();
        if (!configPath) {
          console.error(chalk.red("No ctx.yaml found. Run 'ctx setup' first."));
          process.exit(1);
        }

        const raw = readFileSync(configPath, "utf-8");
        const parsed = parseYaml(raw) as Record<string, unknown>;

        const parsedValue = parseValue(value);
        setDeep(parsed, key, parsedValue);

        // Validate the updated config
        const validationResult = CtxConfigSchema.safeParse(parsed);
        if (!validationResult.success) {
          console.error(chalk.red("Invalid configuration after change:"));
          for (const issue of validationResult.error.issues) {
            console.error(chalk.red(`  ${issue.path.join(".")}: ${issue.message}`));
          }
          process.exit(1);
        }

        // Write back
        const yamlContent = stringifyYaml(parsed, { lineWidth: 120 });
        writeFileSync(configPath, yamlContent);

        console.log(chalk.green(`Set ${chalk.bold(key)} = ${chalk.cyan(String(parsedValue))}`));
      } catch (error) {
        console.error(chalk.red("Failed to set config value"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });

  // ctx config sources
  configCmd
    .command("sources")
    .description("List all configured sources with connection status")
    .action(async () => {
      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        await showSourceStatus(config, projectRoot);
      } catch (error) {
        console.error(chalk.red("Failed to check sources"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
