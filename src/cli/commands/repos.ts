import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { findConfigFile, getProjectRoot } from "../../config/loader.js";

interface RepoAddOptions {
  branch?: string;
  name?: string;
}

export function registerReposCommand(program: Command): void {
  const reposCmd = program
    .command("repos")
    .description("Manage repository registrations");

  // ctx repos list
  reposCmd
    .command("list")
    .description("List all registered repositories")
    .action(async () => {
      try {
        const configPath = findConfigFile();
        if (!configPath) {
          console.error(chalk.red("No ctx.yaml found. Run 'ctx init' first."));
          process.exit(1);
        }

        const raw = readFileSync(configPath, "utf-8");
        const configData = parseYaml(raw) as Record<string, unknown>;
        const repos = (configData.repos ?? []) as Array<{
          name: string;
          github: string;
          branch?: string;
        }>;

        console.log();
        console.log(chalk.bold("Registered repositories:"));
        console.log();

        if (repos.length === 0) {
          console.log(chalk.dim("  No repositories registered. Run 'ctx repos add <github-url>' to add one."));
        } else {
          for (const repo of repos) {
            console.log(
              `  ${chalk.cyan(repo.name)} — ${chalk.dim(repo.github)}${repo.branch ? chalk.dim(` (${repo.branch})`) : ""}`
            );
          }
        }

        console.log();
        console.log(chalk.dim(`  Total: ${repos.length} repo(s)`));
        console.log();
      } catch (error) {
        console.error(chalk.red("Failed to list repos"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });

  // ctx repos add <github-url>
  reposCmd
    .command("add <url>")
    .description("Clone a repo and register it as a source")
    .option("--branch <branch>", "Branch to track")
    .option("--name <name>", "Custom name for the repo")
    .action(async (url: string, options: RepoAddOptions) => {
      const spinner = ora("Adding repository...").start();

      try {
        const configPath = findConfigFile();
        if (!configPath) {
          spinner.fail(chalk.red("No ctx.yaml found. Run 'ctx init' first."));
          process.exit(1);
        }

        const projectRoot = getProjectRoot();

        // Derive repo name from URL
        const repoName =
          options.name ??
          basename(url.replace(/\.git$/, ""))
            .replace(/[^a-zA-Z0-9-_]/g, "-")
            .toLowerCase();

        // Clone the repo into .ctx/sources/
        const clonePath = join(projectRoot, ".ctx", "sources", repoName);

        if (existsSync(clonePath)) {
          spinner.text = `Repo directory exists — pulling latest...`;
          try {
            execSync(`git -C "${clonePath}" pull --ff-only`, {
              stdio: "pipe",
              timeout: 60_000,
            });
          } catch {
            spinner.warn(chalk.yellow(`Could not pull latest for ${repoName}`));
          }
        } else {
          spinner.text = `Cloning ${url}...`;
          const branchArg = options.branch ? `--branch ${options.branch}` : "";
          try {
            execSync(
              `git clone --depth 1 ${branchArg} "${url}" "${clonePath}"`,
              {
                stdio: "pipe",
                timeout: 120_000,
              }
            );
          } catch (error) {
            spinner.fail(chalk.red(`Failed to clone: ${error instanceof Error ? error.message : String(error)}`));
            process.exit(1);
          }
        }

        // Update ctx.yaml — add to repos array and add as local source
        const raw = readFileSync(configPath, "utf-8");
        const configData = parseYaml(raw) as Record<string, unknown>;

        // Add to repos
        if (!configData.repos) configData.repos = [];
        const repos = configData.repos as Array<{
          name: string;
          github: string;
          branch?: string;
        }>;

        // Check if already registered
        const existing = repos.find((r) => r.github === url);
        if (!existing) {
          const repoEntry: { name: string; github: string; branch?: string } = {
            name: repoName,
            github: url,
          };
          if (options.branch) repoEntry.branch = options.branch;
          repos.push(repoEntry);
        }

        // Add as local source
        if (!configData.sources) configData.sources = {};
        const sources = configData.sources as Record<string, unknown[]>;
        if (!sources.local) sources.local = [];
        const localSources = sources.local as Array<{ name: string; path: string }>;

        const alreadySource = localSources.find((s) => s.name === `repo-${repoName}`);
        if (!alreadySource) {
          localSources.push({
            name: `repo-${repoName}`,
            path: `.ctx/sources/${repoName}`,
          });
        }

        writeFileSync(configPath, yamlStringify(configData, { lineWidth: 120 }));

        spinner.succeed(chalk.green(`Repository '${repoName}' cloned and registered`));
        console.log();
        console.log(`  ${chalk.bold("Location:")} ${chalk.dim(clonePath)}`);
        console.log(`  ${chalk.bold("Source:")}   ${chalk.dim(`repo-${repoName}`)}`);
        console.log();
        console.log(chalk.dim("  Run 'ctx ingest' or 'ctx sync' to include this repo's content."));
        console.log();
      } catch (error) {
        spinner.fail(chalk.red("Failed to add repo"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });

  // ctx repos remove <name>
  reposCmd
    .command("remove <name>")
    .description("Unregister a repository (does not delete cloned files)")
    .action(async (name: string) => {
      const spinner = ora(`Removing repo '${name}'...`).start();

      try {
        const configPath = findConfigFile();
        if (!configPath) {
          spinner.fail(chalk.red("No ctx.yaml found."));
          process.exit(1);
        }

        const raw = readFileSync(configPath, "utf-8");
        const configData = parseYaml(raw) as Record<string, unknown>;

        // Remove from repos
        const repos = (configData.repos ?? []) as Array<{ name: string }>;
        const repoIdx = repos.findIndex((r) => r.name === name);
        if (repoIdx === -1) {
          spinner.fail(chalk.red(`Repo '${name}' not found.`));
          process.exit(1);
        }
        repos.splice(repoIdx, 1);

        // Remove from local sources
        if (configData.sources) {
          const sources = configData.sources as Record<string, Array<{ name: string }>>;
          if (sources.local) {
            const sourceIdx = sources.local.findIndex((s) => s.name === `repo-${name}`);
            if (sourceIdx !== -1) {
              sources.local.splice(sourceIdx, 1);
            }
          }
        }

        writeFileSync(configPath, yamlStringify(configData, { lineWidth: 120 }));
        spinner.succeed(chalk.green(`Repo '${name}' unregistered`));
        console.log(chalk.dim("  Cloned files in .ctx/sources/ were not deleted."));
      } catch (error) {
        spinner.fail(chalk.red("Failed to remove repo"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
