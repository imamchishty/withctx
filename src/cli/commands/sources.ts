import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { loadConfig, findConfigFile } from "../../config/loader.js";
import { runInteractiveSourceAdd } from "./sources-interactive.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function readRawConfig(configPath: string): Record<string, unknown> {
  const raw = readFileSync(configPath, "utf-8");
  return (parseYaml(raw) as Record<string, unknown>) ?? {};
}

function writeRawConfig(configPath: string, data: Record<string, unknown>): void {
  writeFileSync(configPath, yamlStringify(data, { lineWidth: 120 }));
}

// ---------------------------------------------------------------------------
// The "sources" command group
// ---------------------------------------------------------------------------

export function registerSourcesCommand(program: Command): void {
  const sourcesCmd = program
    .command("sources")
    .description("Manage source connectors");

  // -------------------------------------------------------------------------
  // ctx sources list
  // -------------------------------------------------------------------------
  sourcesCmd
    .command("list")
    .description("List all configured sources")
    .action(async () => {
      try {
        const config = loadConfig();

        console.log();
        console.log(chalk.bold("Configured sources:"));
        console.log();

        let total = 0;

        if (config.sources?.local && config.sources.local.length > 0) {
          console.log(chalk.bold.cyan("  Local:"));
          for (const source of config.sources.local) {
            console.log(`    ${chalk.white(source.name)} — ${chalk.dim(source.path)}`);
            total++;
          }
        }

        if (config.sources?.jira && config.sources.jira.length > 0) {
          console.log(chalk.bold.cyan("  Jira:"));
          for (const source of config.sources.jira) {
            console.log(
              `    ${chalk.white(source.name)} — ${chalk.dim(source.base_url)}${source.project ? ` [${source.project}]` : ""}`
            );
            total++;
          }
        }

        if (config.sources?.confluence && config.sources.confluence.length > 0) {
          console.log(chalk.bold.cyan("  Confluence:"));
          for (const source of config.sources.confluence) {
            const spaceLabel = source.space
              ? Array.isArray(source.space) ? source.space.join(", ") : source.space
              : "";
            console.log(
              `    ${chalk.white(source.name)} — ${chalk.dim(source.base_url)}${spaceLabel ? ` [${spaceLabel}]` : ""}`
            );
            total++;
          }
        }

        if (config.sources?.github && config.sources.github.length > 0) {
          console.log(chalk.bold.cyan("  GitHub:"));
          for (const source of config.sources.github) {
            console.log(
              `    ${chalk.white(source.name)} — ${chalk.dim(source.owner)}${source.repo ? `/${source.repo}` : ""}`
            );
            total++;
          }
        }

        if (config.sources?.slack && config.sources.slack.length > 0) {
          console.log(chalk.bold.cyan("  Slack:"));
          for (const source of config.sources.slack) {
            console.log(
              `    ${chalk.white(source.name)} — ${chalk.dim(source.channels.join(", "))}`
            );
            total++;
          }
        }

        if (config.sources?.notion && config.sources.notion.length > 0) {
          console.log(chalk.bold.cyan("  Notion:"));
          for (const source of config.sources.notion) {
            const dbCount = source.database_ids?.length ?? 0;
            const pageCount = source.page_ids?.length ?? 0;
            const desc = dbCount > 0 ? `${dbCount} database(s)` : pageCount > 0 ? `${pageCount} page(s)` : "all shared";
            console.log(
              `    ${chalk.white(source.name)} — ${chalk.dim(desc)}`
            );
            total++;
          }
        }

        if (config.sources?.teams && config.sources.teams.length > 0) {
          console.log(chalk.bold.cyan("  Teams:"));
          for (const source of config.sources.teams) {
            const channels = source.channels.map((c) => `${c.team}/${c.channel}`).join(", ");
            console.log(
              `    ${chalk.white(source.name)} — ${chalk.dim(channels)}`
            );
            total++;
          }
        }

        if (total === 0) {
          console.log(chalk.dim("  No sources configured. Run 'ctx sources add' to add one."));
        }

        console.log();
        console.log(chalk.dim(`  Total: ${total} source(s)`));
        console.log();
      } catch (error) {
        console.error(chalk.red("Failed to list sources"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // ctx sources add [type] [path]
  // -------------------------------------------------------------------------
  sourcesCmd
    .command("add [type] [path]")
    .description(
      "Interactively add a source (confluence, jira, github, slack, notion, local)"
    )
    .action(async (typeArg?: string, pathArg?: string) => {
      await runInteractiveSourceAdd(typeArg, pathArg);
    });

  // -------------------------------------------------------------------------
  // ctx sources remove <name>
  // -------------------------------------------------------------------------
  sourcesCmd
    .command("remove <name>")
    .description("Remove a source connector")
    .action(async (name: string) => {
      const spinner = ora(`Removing source '${name}'...`).start();

      try {
        const configPath = findConfigFile();
        if (!configPath) {
          spinner.fail(chalk.red("No ctx.yaml found."));
          process.exit(1);
        }

        const configData = readRawConfig(configPath);

        if (!configData.sources) {
          spinner.fail(chalk.red(`Source '${name}' not found.`));
          process.exit(1);
        }

        const sources = configData.sources as Record<string, Array<{ name: string }>>;
        let found = false;

        for (const [type, list] of Object.entries(sources)) {
          if (!Array.isArray(list)) continue;
          const idx = list.findIndex((s) => s.name === name);
          if (idx !== -1) {
            list.splice(idx, 1);
            found = true;
            if (list.length === 0) {
              delete sources[type];
            }
            break;
          }
        }

        if (!found) {
          spinner.fail(chalk.red(`Source '${name}' not found in any source type.`));
          process.exit(1);
        }

        writeRawConfig(configPath, configData);
        spinner.succeed(chalk.green(`Source '${name}' removed from ctx.yaml`));
      } catch (error) {
        spinner.fail(chalk.red("Failed to remove source"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
