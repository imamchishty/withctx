import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { existsSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { findConfigFile } from "../../config/loader.js";
import type { CtxConfig } from "../../types/config.js";

const SCANNABLE_EXTENSIONS = new Set([
  ".md", ".txt", ".rst", ".adoc",
  ".ts", ".tsx", ".js", ".jsx",
  ".py", ".rb", ".go", ".rs", ".java",
  ".yaml", ".yml", ".json", ".toml",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next",
  "__pycache__", ".venv", "venv", "target",
  ".ctx", ".turbo", "coverage",
]);

interface InitOptions {
  with?: string[];
  name?: string;
}

function scanLocalSources(rootDir: string): { name: string; path: string; fileCount: number }[] {
  const sources: { name: string; path: string; fileCount: number }[] = [];

  // Check common documentation directories
  const docDirs = ["docs", "doc", "documentation", "wiki", "guides"];
  for (const dir of docDirs) {
    const fullPath = join(rootDir, dir);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      const count = countFiles(fullPath);
      if (count > 0) {
        sources.push({ name: dir, path: `./${dir}`, fileCount: count });
      }
    }
  }

  // Check for README and root-level docs
  const rootFiles = readdirSync(rootDir).filter((f) => {
    const ext = extname(f).toLowerCase();
    return SCANNABLE_EXTENSIONS.has(ext) && !f.startsWith(".");
  });

  if (rootFiles.length > 0) {
    sources.push({ name: "root-docs", path: ".", fileCount: rootFiles.length });
  }

  // Check for src directory
  const srcPath = join(rootDir, "src");
  if (existsSync(srcPath) && statSync(srcPath).isDirectory()) {
    const count = countFiles(srcPath);
    if (count > 0) {
      sources.push({ name: "source-code", path: "./src", fileCount: count });
    }
  }

  return sources;
}

function countFiles(dir: string, depth = 0): number {
  if (depth > 5) return 0;
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        count += countFiles(join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (SCANNABLE_EXTENSIONS.has(ext)) count++;
      }
    }
  } catch {
    // Permission error or similar — skip
  }
  return count;
}

function detectProjectName(rootDir: string): string {
  // Try package.json
  const pkgPath = join(rootDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name) return pkg.name;
    } catch {
      // ignore
    }
  }

  // Fall back to directory name
  return rootDir.split("/").pop() ?? "my-project";
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize a withctx project — auto-detect sources and create ctx.yaml")
    .option("--with <connectors...>", "Add external connectors (jira, confluence, teams, github)")
    .option("--name <name>", "Project name")
    .action(async (options: InitOptions) => {
      const rootDir = resolve(process.cwd());
      const spinner = ora("Scanning project structure...").start();

      try {
        // Check if already initialized
        const existingConfig = findConfigFile(rootDir);
        const isReInit = existingConfig !== null;

        if (isReInit) {
          spinner.info("Existing ctx.yaml found — re-initializing with preserved wiki pages.");
        }

        // Detect project name
        const projectName = options.name ?? detectProjectName(rootDir);

        // Scan for local sources
        const localSources = scanLocalSources(rootDir);
        spinner.text = `Found ${localSources.length} local source(s)...`;

        // Build config
        const config: CtxConfig = {
          project: projectName,
          sources: {
            local: localSources.map((s) => ({
              name: s.name,
              path: s.path,
            })),
          },
          costs: {
            budget: 10,
            alert_at: 80,
            model: "claude-sonnet-4",
          },
        };

        // Add external connectors if requested
        if (options.with) {
          for (const connector of options.with) {
            switch (connector.toLowerCase()) {
              case "jira":
                config.sources!.jira = [
                  {
                    name: "jira",
                    base_url: "${JIRA_BASE_URL}",
                    email: "${JIRA_EMAIL}",
                    token: "${JIRA_TOKEN}",
                    project: "${JIRA_PROJECT}",
                  },
                ];
                break;
              case "confluence":
                config.sources!.confluence = [
                  {
                    name: "confluence",
                    base_url: "${CONFLUENCE_BASE_URL}",
                    email: "${CONFLUENCE_EMAIL}",
                    token: "${CONFLUENCE_TOKEN}",
                    space: "${CONFLUENCE_SPACE}",
                  },
                ];
                break;
              case "github":
                config.sources!.github = [
                  {
                    name: "github",
                    token: "${GITHUB_TOKEN}",
                    owner: "${GITHUB_OWNER}",
                  },
                ];
                break;
              case "teams":
                config.sources!.teams = [
                  {
                    name: "teams",
                    tenant_id: "${TEAMS_TENANT_ID}",
                    client_id: "${TEAMS_CLIENT_ID}",
                    client_secret: "${TEAMS_CLIENT_SECRET}",
                    channels: [
                      {
                        team: "${TEAMS_TEAM_NAME}",
                        channel: "${TEAMS_CHANNEL_NAME}",
                      },
                    ],
                  },
                ];
                break;
              default:
                spinner.warn(`Unknown connector: ${connector}`);
            }
          }
        }

        // Write ctx.yaml
        const configPath = join(rootDir, "ctx.yaml");
        const yamlContent = yamlStringify(config, { lineWidth: 120 });
        writeFileSync(configPath, yamlContent);

        // Create .ctx/ directory structure (preserves existing pages)
        const ctxDir = new CtxDirectory(rootDir);
        ctxDir.initialize();

        // Initialize costs.json if it doesn't exist
        if (!ctxDir.readCosts()) {
          ctxDir.writeCosts({
            totalTokens: 0,
            totalCostUsd: 0,
            operations: [],
          });
        }

        // Smart .gitignore handling
        const gitignorePath = join(rootDir, ".gitignore");
        const gitignoreEntries = [
          ".ctx/sources/",
          ".ctx/costs.json",
          ".ctx/exports/",
          ".ctx/sync-state.json",
          ".env",
        ];
        // NOTE: .ctx/context/ is intentionally NOT gitignored — it's the wiki to share

        if (existsSync(gitignorePath)) {
          const gitignoreContent = readFileSync(gitignorePath, "utf-8");
          const missingEntries: string[] = [];

          for (const entry of gitignoreEntries) {
            // Check if already present (exact line match or with trailing whitespace)
            const lines = gitignoreContent.split("\n").map((l) => l.trim());
            if (!lines.includes(entry)) {
              missingEntries.push(entry);
            }
          }

          if (missingEntries.length > 0) {
            const section = [
              "",
              "# withctx — cached sources, costs, and exports (wiki context/ is tracked)",
              ...missingEntries,
              "",
            ].join("\n");

            writeFileSync(gitignorePath, gitignoreContent.trimEnd() + "\n" + section);

            spinner.info(
              chalk.dim(`Added to .gitignore: ${missingEntries.join(", ")}`)
            );
          }
        } else {
          // Create .gitignore with the entries
          const section = [
            "# withctx — cached sources, costs, and exports (wiki context/ is tracked)",
            ...gitignoreEntries,
            "",
          ].join("\n");
          writeFileSync(gitignorePath, section);
          spinner.info(chalk.dim("Created .gitignore with withctx entries"));
        }

        spinner.succeed(chalk.green("Project initialized successfully!"));

        // Print summary
        console.log();
        console.log(chalk.bold("  Project:"), projectName);
        console.log(chalk.bold("  Config: "), chalk.dim(configPath));
        console.log(chalk.bold("  Wiki:   "), chalk.dim(join(rootDir, ".ctx", "context")));
        console.log();

        if (localSources.length > 0) {
          console.log(chalk.bold("  Detected sources:"));
          for (const source of localSources) {
            console.log(
              `    ${chalk.cyan(source.name)} ${chalk.dim(`(${source.path})`)} — ${source.fileCount} files`
            );
          }
          console.log();
        }

        if (options.with && options.with.length > 0) {
          console.log(
            chalk.yellow("  External connectors added — update ctx.yaml with your credentials")
          );
          console.log(
            chalk.dim("  Tip: Use environment variables like ${JIRA_TOKEN} for secrets")
          );
          console.log();
        }

        if (isReInit) {
          console.log(chalk.dim("  Existing wiki pages preserved."));
        }

        console.log(
          chalk.dim("  Next step: run ") +
            chalk.bold("ctx ingest") +
            chalk.dim(" to compile your context wiki")
        );
      } catch (error) {
        spinner.fail(chalk.red("Initialization failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
