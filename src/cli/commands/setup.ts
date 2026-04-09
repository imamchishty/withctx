import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import type { CtxConfig } from "../../types/config.js";

// ---------------------------------------------------------------------------
// Readline prompt helper (no external deps — uses Node built-in readline)
// ---------------------------------------------------------------------------

function createPrompt(): {
  ask: (question: string, defaultValue?: string) => Promise<string>;
  confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
  choose: (question: string, options: string[]) => Promise<number>;
  close: () => void;
} {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question: string, defaultValue?: string): Promise<string> =>
    new Promise((res) => {
      const suffix = defaultValue ? chalk.dim(` (${defaultValue})`) : "";
      rl.question(`${chalk.cyan("?")} ${question}${suffix}: `, (answer) => {
        res(answer.trim() || defaultValue || "");
      });
    });

  const confirm = (question: string, defaultYes = false): Promise<boolean> =>
    new Promise((res) => {
      const hint = defaultYes ? chalk.dim(" (Y/n)") : chalk.dim(" (y/N)");
      rl.question(`${chalk.cyan("?")} ${question}${hint} `, (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === "") res(defaultYes);
        else res(a === "y" || a === "yes");
      });
    });

  const choose = (question: string, options: string[]): Promise<number> =>
    new Promise((res) => {
      console.log(`${chalk.cyan("?")} ${question}`);
      for (let i = 0; i < options.length; i++) {
        console.log(`  ${chalk.cyan(`(${i + 1})`)} ${options[i]}`);
      }
      rl.question(`${chalk.cyan(">")} `, (answer) => {
        const idx = parseInt(answer.trim(), 10) - 1;
        res(idx >= 0 && idx < options.length ? idx : 0);
      });
    });

  const close = () => rl.close();

  return { ask, confirm, choose, close };
}

// ---------------------------------------------------------------------------
// Local helpers (duplicated from init to avoid circular deps)
// ---------------------------------------------------------------------------

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
    // skip
  }
  return count;
}

function scanLocalSources(rootDir: string): { name: string; path: string; fileCount: number }[] {
  const sources: { name: string; path: string; fileCount: number }[] = [];

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

  const rootFiles = readdirSync(rootDir).filter((f) => {
    const ext = extname(f).toLowerCase();
    return SCANNABLE_EXTENSIONS.has(ext) && !f.startsWith(".");
  });

  if (rootFiles.length > 0) {
    sources.push({ name: "root-docs", path: ".", fileCount: rootFiles.length });
  }

  const srcPath = join(rootDir, "src");
  if (existsSync(srcPath) && statSync(srcPath).isDirectory()) {
    const count = countFiles(srcPath);
    if (count > 0) {
      sources.push({ name: "source-code", path: "./src", fileCount: count });
    }
  }

  return sources;
}

function detectProjectName(rootDir: string): string {
  const pkgPath = join(rootDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name) return pkg.name;
    } catch {
      // ignore
    }
  }
  return rootDir.split("/").pop() ?? "my-project";
}

// ---------------------------------------------------------------------------
// GitHub org repo discovery (lazy import of @octokit/rest)
// ---------------------------------------------------------------------------

interface OrgRepo {
  name: string;
  clone_url: string;
  default_branch: string;
}

async function discoverOrgRepos(org: string, token: string): Promise<OrgRepo[]> {
  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit({ auth: token });

  const repos: OrgRepo[] = [];
  let page = 1;

  while (true) {
    const { data } = await octokit.repos.listForOrg({
      org,
      type: "all",
      per_page: 100,
      page,
    });

    if (data.length === 0) break;

    for (const r of data) {
      repos.push({
        name: r.name,
        clone_url: r.clone_url ?? "",
        default_branch: r.default_branch ?? "main",
      });
    }

    if (data.length < 100) break;
    page++;
  }

  return repos;
}

// ---------------------------------------------------------------------------
// The "setup" command — interactive wizard
// ---------------------------------------------------------------------------

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Interactive wizard to configure your project")
    .action(async () => {
      const rootDir = resolve(process.cwd());

      console.log();
      console.log(chalk.bold.cyan("  ctx setup") + chalk.dim(" — interactive project wizard"));
      console.log();

      const prompt = createPrompt();

      try {
        // ---------------------------------------------------------------
        // Project name
        // ---------------------------------------------------------------
        const defaultName = detectProjectName(rootDir);
        const projectName = await prompt.ask("Project name", defaultName);

        // ---------------------------------------------------------------
        // Setup type
        // ---------------------------------------------------------------
        const setupType = await prompt.choose("Setup type", [
          "Single repo",
          "Multi-repo",
          "Monorepo",
        ]);

        const config: CtxConfig = {
          project: projectName,
          sources: {
            local: [],
          },
          costs: {
            budget: 10,
            alert_at: 80,
            model: "claude-sonnet-4",
          },
        };

        let repoCount = 0;

        // ---------------------------------------------------------------
        // Multi-repo: discover from GitHub org
        // ---------------------------------------------------------------
        if (setupType === 1) {
          const org = await prompt.ask("GitHub org");

          if (org) {
            const token = process.env.GITHUB_TOKEN ?? await prompt.ask("GitHub token (or set GITHUB_TOKEN env var)");

            if (token) {
              console.log(chalk.dim("  Discovering repos..."));

              try {
                const repos = await discoverOrgRepos(org, token);
                console.log(`  Found ${chalk.bold(String(repos.length))} repos.`);

                const includeAll = await prompt.confirm(`Include all ${repos.length} repos?`, true);

                if (!config.repos) config.repos = [];

                if (includeAll) {
                  for (const repo of repos) {
                    (config.repos as Array<{ name: string; github: string; branch?: string }>).push({
                      name: repo.name,
                      github: repo.clone_url,
                      branch: repo.default_branch,
                    });
                  }
                  repoCount = repos.length;
                } else {
                  for (const repo of repos) {
                    const include = await prompt.confirm(`  Include ${repo.name}?`, true);
                    if (include) {
                      (config.repos as Array<{ name: string; github: string; branch?: string }>).push({
                        name: repo.name,
                        github: repo.clone_url,
                        branch: repo.default_branch,
                      });
                      repoCount++;
                    }
                  }
                }
              } catch (error) {
                console.log(
                  chalk.yellow(`  Could not discover repos: ${error instanceof Error ? error.message : String(error)}`)
                );
              }
            }
          }
        }

        // ---------------------------------------------------------------
        // Single repo / Monorepo: scan local sources
        // ---------------------------------------------------------------
        if (setupType === 0 || setupType === 2) {
          const localSources = scanLocalSources(rootDir);
          if (localSources.length > 0) {
            config.sources!.local = localSources.map((s) => ({
              name: s.name,
              path: s.path,
            }));
            console.log(chalk.dim(`  Auto-detected ${localSources.length} local source(s)`));
          }
        }

        // ---------------------------------------------------------------
        // Connectors: Jira
        // ---------------------------------------------------------------
        const addJira = await prompt.confirm("Add Jira?", false);
        if (addJira) {
          const baseUrl = await prompt.ask("  Jira base URL", "https://yourorg.atlassian.net");
          const project = await prompt.ask("  Jira project key", "");

          config.sources!.jira = [
            {
              name: "jira",
              base_url: baseUrl || "${JIRA_BASE_URL}",
              email: "${JIRA_EMAIL}",
              token: "${JIRA_TOKEN}",
              project: project || "${JIRA_PROJECT}",
            },
          ];
        }

        // ---------------------------------------------------------------
        // Connectors: Confluence
        // ---------------------------------------------------------------
        const addConfluence = await prompt.confirm("Add Confluence?", false);
        if (addConfluence) {
          const space = await prompt.ask("  Confluence space key", "");

          config.sources!.confluence = [
            {
              name: "confluence",
              base_url: "${CONFLUENCE_BASE_URL}",
              email: "${CONFLUENCE_EMAIL}",
              token: "${CONFLUENCE_TOKEN}",
              space: space || "${CONFLUENCE_SPACE}",
            },
          ];
        }

        // ---------------------------------------------------------------
        // Connectors: Slack
        // ---------------------------------------------------------------
        const addSlack = await prompt.confirm("Add Slack?", false);
        if (addSlack) {
          console.log(
            chalk.dim("  Slack support coming soon — add manually to ctx.yaml when available")
          );
        }

        // ---------------------------------------------------------------
        // Connectors: Teams
        // ---------------------------------------------------------------
        const addTeams = await prompt.confirm("Add Teams?", false);
        if (addTeams) {
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
        }

        // ---------------------------------------------------------------
        // Write config
        // ---------------------------------------------------------------
        const configPath = join(rootDir, "ctx.yaml");
        writeFileSync(configPath, yamlStringify(config, { lineWidth: 120 }));

        // Create .ctx/ directory
        const ctxDir = new CtxDirectory(rootDir);
        ctxDir.initialize();

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

        if (existsSync(gitignorePath)) {
          const gitignoreContent = readFileSync(gitignorePath, "utf-8");
          const missingEntries: string[] = [];

          for (const entry of gitignoreEntries) {
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
          }
        } else {
          const section = [
            "# withctx — cached sources, costs, and exports (wiki context/ is tracked)",
            ...gitignoreEntries,
            "",
          ].join("\n");
          writeFileSync(gitignorePath, section);
        }

        // ---------------------------------------------------------------
        // Summary
        // ---------------------------------------------------------------
        console.log();

        const parts: string[] = [];
        if (repoCount > 0) parts.push(`${repoCount} repos`);
        if (addJira) parts.push("Jira");
        if (addConfluence) parts.push("Confluence");
        if (addTeams) parts.push("Teams");

        const suffix = parts.length > 0 ? ` with ${parts.join(", ")}` : "";

        console.log(chalk.green(`  ${chalk.bold("\u2713")} Created ctx.yaml${suffix}`));
        console.log(chalk.green(`  ${chalk.bold("\u2713")} Run ${chalk.bold("'ctx go'")} to compile your wiki`));
        console.log();
      } catch (error) {
        console.log();
        console.error(chalk.red("Setup failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      } finally {
        prompt.close();
      }
    });
}
