import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { loadConfig, findConfigFile, getProjectRoot } from "../../config/loader.js";
import { LocalFilesConnector } from "../../connectors/local-files.js";

interface SourceAddOptions {
  type?: string;
  path?: string;
  url?: string;
  token?: string;
  project?: string;
  space?: string;
  owner?: string;
}

export function registerSourcesCommand(program: Command): void {
  const sourcesCmd = program
    .command("sources")
    .description("Manage source connectors");

  // ctx sources list
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
            console.log(
              `    ${chalk.white(source.name)} — ${chalk.dim(source.base_url)}${source.space ? ` [${source.space}]` : ""}`
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

  // ctx sources add <name>
  sourcesCmd
    .command("add <name>")
    .description("Add a new source connector")
    .option("--type <type>", "Source type: local, jira, confluence, github, teams", "local")
    .option("--path <path>", "Path for local sources")
    .option("--url <url>", "Base URL for Jira/Confluence")
    .option("--token <token>", "API token (or env var reference like ${TOKEN})")
    .option("--project <project>", "Jira project key")
    .option("--space <space>", "Confluence space key")
    .option("--owner <owner>", "GitHub owner/org")
    .action(async (name: string, options: SourceAddOptions) => {
      const spinner = ora(`Adding source '${name}'...`).start();

      try {
        const configPath = findConfigFile();
        if (!configPath) {
          spinner.fail(chalk.red("No ctx.yaml found. Run 'ctx init' first."));
          process.exit(1);
        }

        const raw = readFileSync(configPath, "utf-8");
        const configData = parseYaml(raw) as Record<string, unknown>;

        if (!configData.sources) {
          configData.sources = {};
        }
        const sources = configData.sources as Record<string, unknown[]>;

        const type = options.type ?? "local";

        switch (type) {
          case "local": {
            const path = options.path ?? `./${name}`;
            if (!sources.local) sources.local = [];
            (sources.local as Array<{ name: string; path: string }>).push({ name, path });

            // Validate
            const connector = new LocalFilesConnector(name, path);
            const valid = await connector.validate();
            if (!valid) {
              spinner.warn(chalk.yellow(`Path '${path}' does not exist yet — source added anyway.`));
            }
            break;
          }

          case "jira": {
            if (!options.url) {
              spinner.fail(chalk.red("--url is required for Jira sources"));
              process.exit(1);
            }
            if (!sources.jira) sources.jira = [];
            (sources.jira as Array<Record<string, unknown>>).push({
              name,
              base_url: options.url,
              token: options.token ?? "${JIRA_TOKEN}",
              project: options.project,
            });
            break;
          }

          case "confluence": {
            if (!options.url) {
              spinner.fail(chalk.red("--url is required for Confluence sources"));
              process.exit(1);
            }
            if (!sources.confluence) sources.confluence = [];
            (sources.confluence as Array<Record<string, unknown>>).push({
              name,
              base_url: options.url,
              token: options.token ?? "${CONFLUENCE_TOKEN}",
              space: options.space,
            });
            break;
          }

          case "github": {
            if (!options.owner) {
              spinner.fail(chalk.red("--owner is required for GitHub sources"));
              process.exit(1);
            }
            if (!sources.github) sources.github = [];
            (sources.github as Array<Record<string, unknown>>).push({
              name,
              token: options.token ?? "${GITHUB_TOKEN}",
              owner: options.owner,
            });
            break;
          }

          case "teams": {
            if (!sources.teams) sources.teams = [];
            (sources.teams as Array<Record<string, unknown>>).push({
              name,
              tenant_id: "${TEAMS_TENANT_ID}",
              client_id: "${TEAMS_CLIENT_ID}",
              client_secret: "${TEAMS_CLIENT_SECRET}",
              channels: [],
            });
            spinner.info("Teams source added — update ctx.yaml with tenant credentials and channels.");
            break;
          }

          default:
            spinner.fail(chalk.red(`Unknown source type: ${type}`));
            process.exit(1);
        }

        // Write back
        writeFileSync(configPath, yamlStringify(configData, { lineWidth: 120 }));

        spinner.succeed(chalk.green(`Source '${name}' (${type}) added to ctx.yaml`));
      } catch (error) {
        spinner.fail(chalk.red("Failed to add source"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });

  // ctx sources remove <name>
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

        const raw = readFileSync(configPath, "utf-8");
        const configData = parseYaml(raw) as Record<string, unknown>;

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
            // Clean up empty arrays
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

        writeFileSync(configPath, yamlStringify(configData, { lineWidth: 120 }));
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
