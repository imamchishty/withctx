import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { existsSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { stringify as yamlStringify, parse as parseYaml } from "yaml";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { findConfigFile, loadConfig, getProjectRoot } from "../../config/loader.js";
import { PageManager } from "../../wiki/pages.js";
import { createLLMFromCtxConfig } from "../../llm/index.js";
import { LocalFilesConnector } from "../../connectors/local-files.js";
import type { RawDocument } from "../../types/source.js";
import type { CtxConfig } from "../../types/config.js";

// ---------------------------------------------------------------------------
// Shared helpers (same as init.ts — scanning logic)
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
    // Permission error — skip
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
// GitHub org repo discovery
// ---------------------------------------------------------------------------

interface OrgRepo {
  name: string;
  clone_url: string;
  default_branch: string;
  description: string | null;
}

async function discoverOrgRepos(org: string, token: string): Promise<OrgRepo[]> {
  // Dynamic import — @octokit/rest is used only when --org is supplied
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
        description: r.description ?? null,
      });
    }

    if (data.length < 100) break;
    page++;
  }

  return repos;
}

// ---------------------------------------------------------------------------
// Init step — create ctx.yaml and .ctx/
// ---------------------------------------------------------------------------

interface InitResult {
  projectName: string;
  sourceCount: number;
  configPath: string;
  rootDir: string;
  wasAlreadyInitialized: boolean;
}

async function runInit(
  rootDir: string,
  connectors: string[],
  org: string | undefined,
  token: string | undefined,
  spinner: ReturnType<typeof ora>,
): Promise<InitResult> {
  const existingConfig = findConfigFile(rootDir);
  const wasAlreadyInitialized = existingConfig !== null;

  if (wasAlreadyInitialized) {
    spinner.succeed(chalk.dim("Already initialized — skipping init step"));
    const projectName = detectProjectName(rootDir);
    const localSources = scanLocalSources(rootDir);
    return {
      projectName,
      sourceCount: localSources.length,
      configPath: existingConfig!,
      rootDir,
      wasAlreadyInitialized: true,
    };
  }

  spinner.text = "Scanning project structure...";

  const projectName = detectProjectName(rootDir);
  const localSources = scanLocalSources(rootDir);

  spinner.text = `Found ${localSources.length} local source(s)...`;

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

  // Add connectors
  for (const connector of connectors) {
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
    }
  }

  // Multi-repo: discover and add org repos
  if (org && token) {
    spinner.text = `Discovering repos in ${org}...`;
    try {
      const orgRepos = await discoverOrgRepos(org, token);
      spinner.text = `Found ${orgRepos.length} repos in ${org}`;

      if (!config.repos) config.repos = [];
      for (const repo of orgRepos) {
        (config.repos as Array<{ name: string; github: string; branch?: string }>).push({
          name: repo.name,
          github: repo.clone_url,
          branch: repo.default_branch,
        });
      }
    } catch (error) {
      spinner.warn(
        chalk.yellow(
          `Could not discover repos from org '${org}': ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  // Write ctx.yaml
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

  spinner.succeed(chalk.green("Initialized project"));

  return {
    projectName,
    sourceCount: localSources.length,
    configPath,
    rootDir,
    wasAlreadyInitialized: false,
  };
}

// ---------------------------------------------------------------------------
// Ingest step — compile the wiki using Claude
// ---------------------------------------------------------------------------

async function runIngest(
  rootDir: string,
  spinner: ReturnType<typeof ora>,
): Promise<{ pageCount: number; tokenCount: number }> {
  spinner.text = "Loading config...";

  const config = loadConfig();
  const projectRoot = getProjectRoot();
  const ctxDir = new CtxDirectory(projectRoot);
  const pageManager = new PageManager(ctxDir);

  // Collect documents from local sources
  const allDocs: RawDocument[] = [];

  if (config.sources?.local) {
    for (const source of config.sources.local) {
      spinner.text = `Scanning ${source.name}...`;
      try {
        const connector = new LocalFilesConnector(source.name, join(projectRoot, source.path));
        for await (const doc of connector.fetch()) {
          allDocs.push(doc);
        }
      } catch {
        // Skip sources that fail
      }
    }
  }

  if (allDocs.length === 0) {
    spinner.warn(chalk.yellow("No documents found to ingest"));
    return { pageCount: 0, tokenCount: 0 };
  }

  spinner.text = `Compiling ${allDocs.length} documents into wiki...`;

  const claude = createLLMFromCtxConfig(config, "go");
  let pageCount = 0;
  let tokenCount = 0;

  // Combine documents for Claude
  const combined = allDocs
    .map((doc) => `## ${doc.title}\n\n${doc.content}`)
    .join("\n\n---\n\n");

  const estimatedTokens = Math.ceil(combined.length / 4);
  tokenCount = estimatedTokens;

  spinner.text = `Generating wiki from ${allDocs.length} docs (~${(estimatedTokens / 1000).toFixed(0)}k tokens)...`;

  try {
    const response = await claude.prompt(
      `Compile these ${allDocs.length} documents into wiki pages for the "${config.project}" project.\n\nFor each page output:\n---PAGE: <filename.md>---\n<content>\n---END PAGE---\n\nCreate: overview.md, architecture.md, conventions.md, and any other relevant pages.\n\n${combined}`,
      {
        systemPrompt: "You are a wiki compiler. Read the source documents and generate organized, cross-referenced markdown wiki pages.",
        maxTokens: 8192,
      }
    );

    // Parse pages from response
    const pagePattern = /---PAGE:\s*(.+?)---\n([\s\S]*?)---END PAGE---/g;
    let match;
    while ((match = pagePattern.exec(response.content)) !== null) {
      const pagePath = match[1].trim();
      const pageContent = match[2].trim();
      pageManager.write(pagePath, pageContent);
      pageCount++;
    }

    if (response.tokensUsed) {
      tokenCount = (response.tokensUsed.input ?? 0) + (response.tokensUsed.output ?? 0);
    }
  } catch (error) {
    spinner.warn(
      chalk.yellow(`Wiki generation encountered an issue: ${error instanceof Error ? error.message : String(error)}`)
    );
  }

  return { pageCount, tokenCount };
}

// ---------------------------------------------------------------------------
// The "go" command
// ---------------------------------------------------------------------------

interface GoOptions {
  org?: string;
  token?: string;
  with?: string[];
}

export function registerGoCommand(program: Command): void {
  program
    .command("go")
    .description("One command to start — init, ingest, and go")
    .option("--org <org>", "GitHub organization to discover repos from")
    .option("--token <token>", "GitHub token for org discovery (or set GITHUB_TOKEN)")
    .option("--with <connectors...>", "Add external connectors (jira, confluence, teams, github)")
    .action(async (options: GoOptions) => {
      const rootDir = resolve(process.cwd());

      console.log();
      console.log(chalk.bold.cyan("  ctx go") + chalk.dim(" — let's get you set up"));
      console.log();

      // ---------------------------------------------------------------
      // Step 1: Init
      // ---------------------------------------------------------------
      const initSpinner = ora("Initializing project...").start();

      const githubToken = options.token ?? process.env.GITHUB_TOKEN;
      const connectors = options.with ?? [];

      let initResult: InitResult;
      try {
        initResult = await runInit(
          rootDir,
          connectors,
          options.org,
          githubToken,
          initSpinner,
        );
      } catch (error) {
        initSpinner.fail(chalk.red("Initialization failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }

      // ---------------------------------------------------------------
      // Step 2: Ingest (only if API key is available)
      // ---------------------------------------------------------------
      const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

      if (hasApiKey) {
        const ingestSpinner = ora("Compiling wiki with Claude...").start();

        try {
          const { pageCount, tokenCount } = await runIngest(rootDir, ingestSpinner);

          if (pageCount > 0) {
            ingestSpinner.succeed(
              chalk.green(`Compiled ${pageCount} wiki page(s) (~${(tokenCount / 1000).toFixed(0)}k tokens)`)
            );
          } else {
            ingestSpinner.warn(chalk.yellow("No wiki pages generated — try adding more sources"));
          }
        } catch (error) {
          ingestSpinner.fail(chalk.yellow("Wiki compilation skipped"));
          if (error instanceof Error) {
            console.error(chalk.dim(`  ${error.message}`));
          }
        }
      } else {
        const keySpinner = ora("Checking for ANTHROPIC_API_KEY...").start();
        keySpinner.warn(
          chalk.yellow("ANTHROPIC_API_KEY not set — skipping wiki compilation")
        );
        console.log(
          chalk.dim("  Set your key and run ") +
            chalk.bold("ctx ingest") +
            chalk.dim(" to compile the wiki")
        );
      }

      // ---------------------------------------------------------------
      // Summary
      // ---------------------------------------------------------------
      console.log();
      console.log(chalk.bold.green("  Done!") + chalk.dim(` Project: ${initResult.projectName}`));
      console.log();
      console.log(chalk.dim("  Config:  ") + initResult.configPath);
      console.log(chalk.dim("  Wiki:    ") + join(initResult.rootDir, ".ctx", "context"));
      console.log(chalk.dim("  Sources: ") + `${initResult.sourceCount} detected`);

      if (options.org) {
        const configPath = findConfigFile(rootDir);
        if (configPath) {
          try {
            const raw = readFileSync(configPath, "utf-8");
            const configData = parseYaml(raw) as Record<string, unknown>;
            const repos = (configData.repos ?? []) as unknown[];
            if (repos.length > 0) {
              console.log(chalk.dim("  Repos:   ") + `${repos.length} from ${options.org}`);
            }
          } catch {
            // ignore
          }
        }
      }

      // ---------------------------------------------------------------
      // What's next?
      // ---------------------------------------------------------------
      console.log();
      console.log(chalk.bold("  What's next?"));
      console.log();

      if (!hasApiKey) {
        console.log(
          `  ${chalk.cyan("1.")} Set your API key:  ${chalk.bold("export ANTHROPIC_API_KEY=sk-...")}`
        );
        console.log(
          `  ${chalk.cyan("2.")} Compile the wiki:  ${chalk.bold("ctx ingest")}`
        );
        console.log(
          `  ${chalk.cyan("3.")} Chat with your codebase: ${chalk.bold("ctx chat")}`
        );
      } else {
        console.log(
          `  ${chalk.cyan("1.")} Explore your wiki: ${chalk.bold("ctx status")}`
        );
        console.log(
          `  ${chalk.cyan("2.")} Chat with your codebase: ${chalk.bold("ctx chat")}`
        );
        console.log(
          `  ${chalk.cyan("3.")} Keep it fresh:     ${chalk.bold("ctx sync")}`
        );
      }

      if (connectors.length > 0) {
        console.log();
        console.log(
          chalk.yellow("  Connectors added — update ctx.yaml with your credentials")
        );
      }

      console.log();
    });
}
