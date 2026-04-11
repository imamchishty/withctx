import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { existsSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { stringify as yamlStringify, parse as parseYaml } from "yaml";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { findConfigFile, loadConfig, getProjectRoot } from "../../config/loader.js";
import { checkRefreshPolicy } from "../../config/refresh-policy.js";
import { PageManager } from "../../wiki/pages.js";
import { createLLMFromCtxConfig } from "../../llm/index.js";
import { LocalFilesConnector } from "../../connectors/local-files.js";
import { safeResolve } from "../../security/paths.js";
import { writeSecretFile, readSecretFile } from "../../security/fs-modes.js";
import {
  scanForRepos,
  readReposFromPaths,
  parseReposFile,
  type DetectedRepo,
} from "../../setup/scan-repos.js";
import { createInterface } from "node:readline";
import type { RawDocument } from "../../types/source.js";
import type { CtxConfig } from "../../types/config.js";
import { recordRefresh, resolvePricing } from "../../usage/recorder.js";
import { detectActor, detectTrigger } from "../../usage/refresh-context.js";
import { previewCost } from "../../setup/cost-preview.js";
import { probeOllama, pickOllamaModel } from "../../setup/ollama-detect.js";
import { scaffoldDemo } from "../../setup/demo-mode.js";
import { CURRENT_VERSION as CTX_SCHEMA_VERSION } from "../../config/migrate.js";
import {
  detectRunbook,
  renderRunbookPageWithFreshness,
  hasRunbookContent,
} from "../../wiki/runbook.js";

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
  detectedSources: { name: string; path: string; fileCount: number }[];
}

interface RunInitArgs {
  rootDir: string;
  connectors: string[];
  org: string | undefined;
  token: string | undefined;
  spinner: ReturnType<typeof ora>;
  projectNameOverride?: string;
  siblingRepos?: DetectedRepo[];
}

/**
 * Minimal Y/n prompt. Returns the default if stdin is not a TTY (so
 * the command stays usable from scripts and CI), honours --yes via
 * the caller. Intentionally not using inquirer — we only need one
 * question here and pulling in a dep for it is over-kill.
 */
function confirmPrompt(question: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return Promise.resolve(defaultYes);
  }
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") {
        resolvePromise(defaultYes);
      } else {
        resolvePromise(trimmed === "y" || trimmed === "yes");
      }
    });
  });
}

async function runInit(args: RunInitArgs): Promise<InitResult> {
  const { rootDir, connectors, org, token, spinner, projectNameOverride, siblingRepos } = args;
  const existingConfig = findConfigFile(rootDir);
  const wasAlreadyInitialized = existingConfig !== null;

  if (wasAlreadyInitialized) {
    spinner.succeed(chalk.dim("Already initialized — skipping init step"));
    const projectName = projectNameOverride ?? detectProjectName(rootDir);
    const localSources = scanLocalSources(rootDir);
    return {
      projectName,
      sourceCount: localSources.length,
      configPath: existingConfig!,
      rootDir,
      wasAlreadyInitialized: true,
      detectedSources: localSources,
    };
  }

  spinner.text = "Scanning project structure...";

  const projectName = projectNameOverride ?? detectProjectName(rootDir);
  const localSources = scanLocalSources(rootDir);

  // Fold in sibling repos as additional local sources. Each detected
  // repo becomes one local source pointing at its folder, so the
  // ingest pipeline will walk and compile the code inside it.
  // We also record them in `repos:` so future commands know the
  // github URL + branch for each one.
  if (siblingRepos && siblingRepos.length > 0) {
    for (const repo of siblingRepos) {
      // Avoid duplicates if a sibling repo name collides with an
      // already-detected local source (e.g. "docs").
      if (!localSources.some((s) => s.name === repo.name)) {
        localSources.push({
          name: repo.name,
          path: repo.path,
          fileCount: 0, // unknown until ingest — harmless for config
        });
      }
    }
  }

  spinner.text = `Found ${localSources.length} local source(s)...`;

  const config: CtxConfig = {
    version: CTX_SCHEMA_VERSION,
    project: projectName,
    sources: {
      local: localSources.map((s) => ({
        name: s.name,
        path: s.path,
      })),
    },
    // Scaffold the `ai:` block with the api_key field present but set
    // to an env var interpolation. Resolution order at runtime (see
    // createLLMFromCtxConfig):
    //   1. ANTHROPIC_API_KEY env var  — always wins if set
    //   2. config.ai.api_key          — falls through (the ${VAR} below
    //                                    gets interpolated from env if
    //                                    present, or left as a literal
    //                                    placeholder so the user can
    //                                    paste a real key in its place)
    //   3. nothing                    — requests fail as "unauthorized"
    //
    // We scaffold this explicitly so users discover the field exists
    // without having to read the docs. The env var reference keeps
    // ctx.yaml safe to commit by default.
    ai: {
      provider: "anthropic",
      api_key: "${ANTHROPIC_API_KEY}",
    },
    costs: {
      budget: 10,
      alert_at: 80,
      model: "claude-sonnet-4",
    },
  };

  // Sibling repos with a known github URL go into `repos:` so
  // multi-repo tooling knows the remote + branch for each one. Repos
  // without an origin remote stay as local-only sources (already
  // added above) — we'd rather write no entry than an invalid one.
  if (siblingRepos && siblingRepos.length > 0) {
    const withRemotes = siblingRepos.filter((r) => r.github !== null);
    if (withRemotes.length > 0) {
      if (!config.repos) config.repos = [];
      for (const repo of withRemotes) {
        const entry: { name: string; github: string; branch?: string } = {
          name: repo.name,
          github: repo.github!,
        };
        if (repo.branch) entry.branch = repo.branch;
        (config.repos as Array<typeof entry>).push(entry);
      }
    }
  }

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

  // Write ctx.yaml with owner-only permissions — the file may
  // contain `${VAR}` references that resolve to secrets, and on a
  // shared machine we don't want group/world read access.
  const configPath = join(rootDir, "ctx.yaml");
  writeSecretFile(configPath, yamlStringify(config, { lineWidth: 120 }));

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
    detectedSources: localSources,
  };
}

// ---------------------------------------------------------------------------
// Ingest step — compile the wiki using Claude
// ---------------------------------------------------------------------------

async function runIngest(
  rootDir: string,
  spinner: ReturnType<typeof ora>,
  options: { skipCostPreview?: boolean } = {}
): Promise<{ pageCount: number; tokenCount: number; blocked?: boolean; cancelled?: boolean }> {
  spinner.text = "Loading config...";

  const config = loadConfig();

  // Guardrail: if the config says this wiki is CI-refreshed, don't
  // automatically ingest as part of setup. The user likely re-ran
  // `ctx setup` against an already-published repo and doesn't want
  // to burn budget on a rebuild.
  const guard = checkRefreshPolicy(config, "ingest");
  if (!guard.allowed) {
    spinner.warn(
      chalk.yellow("Skipping ingest — this wiki is refreshed by CI")
    );
    return { pageCount: 0, tokenCount: 0, blocked: true };
  }

  const projectRoot = getProjectRoot();
  const ctxDir = new CtxDirectory(projectRoot);
  const pageManager = new PageManager(ctxDir);
  const ingestStart = Date.now();
  const model = config.ai?.model ?? config.costs?.model ?? "claude-sonnet-4";

  // Collect documents from local sources
  const allDocs: RawDocument[] = [];

  if (config.sources?.local) {
    for (const source of config.sources.local) {
      spinner.text = `Scanning ${source.name}...`;
      // Resolve through the safety helper so a malicious ctx.yaml
      // can't point us at `/etc/passwd` or `../../other-repo`.
      const resolvedPath = safeResolve(source.path, projectRoot);
      if (resolvedPath === null) continue;
      try {
        const connector = new LocalFilesConnector(source.name, resolvedPath);
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

  // ── Cost preview (Setup-axis guarantee: no surprise spend) ───────
  //
  // Before the first Claude call, print a tight summary of what's
  // about to be sent and what it will roughly cost. Honours `-y` by
  // skipping the prompt but STILL printing the summary — users who
  // automated the setup still want to see what was spent.
  spinner.stop();
  const preview = await previewCost({
    operation: "ctx setup — wiki compile",
    documentCount: allDocs.length,
    totalChars: combined.length,
    model,
    maxOutputTokens: 8192,
    skipPrompt: options.skipCostPreview === true,
  });
  if (!preview.approved) {
    return { pageCount: 0, tokenCount: 0, cancelled: true };
  }
  spinner.start(`Generating wiki from ${allDocs.length} docs (~${(estimatedTokens / 1000).toFixed(0)}k tokens)...`);

  const refreshTokens = { input: 0, output: 0 };
  let refreshCost = 0;
  let refreshSuccess = true;
  let refreshError: string | null = null;

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
      refreshTokens.input = response.tokensUsed.input ?? 0;
      refreshTokens.output = response.tokensUsed.output ?? 0;
      const pricing = resolvePricing(model) ?? resolvePricing("claude-sonnet-4")!;
      refreshCost =
        (refreshTokens.input / 1_000_000) * pricing.input +
        (refreshTokens.output / 1_000_000) * pricing.output;
    }
  } catch (error) {
    refreshSuccess = false;
    refreshError = error instanceof Error ? error.message : String(error);
    spinner.warn(
      chalk.yellow(`Wiki generation encountered an issue: ${refreshError}`)
    );
  }

  // ── Runbook auto-detection ───────────────────────────────────────
  //
  // Deterministic, zero-LLM, <10ms. Scans package.json scripts, the
  // Makefile / justfile, Dockerfile + compose, .env.example, CI
  // workflows, README. Produces a single `runbook.md` page with the
  // "how do I actually run this thing" answer that new engineers
  // and onboarding agents both need. Runs AFTER the LLM compile so
  // it never gets clobbered by a stale Claude hallucination about
  // run commands.
  try {
    const runbookData = detectRunbook(projectRoot);
    if (hasRunbookContent(runbookData)) {
      // renderRunbookPageWithFreshness stamps a hidden ctx:freshness
      // marker into the page with the git SHA of every source file.
      // `ctx status` / `ctx lint` can later diff this against current
      // git to flag drift without mtime guesswork.
      const runbookMd = renderRunbookPageWithFreshness(
        runbookData,
        config.project,
        projectRoot
      );
      pageManager.write("runbook.md", runbookMd);
      pageCount++;
    }
  } catch {
    // Runbook detection is best-effort. A malformed Makefile or
    // unusual compose file should never break setup.
  }

  // Append a single refresh-journal entry for this setup-ingest run.
  // `ctx history` reads these back, and the cost-warning prompt in
  // `ctx sync --allow-local-refresh` keys off the most-recent record.
  try {
    recordRefresh(ctxDir, {
      actor: detectActor(),
      trigger: detectTrigger("setup", false),
      forced: false,
      model,
      tokens: refreshTokens,
      cost: refreshCost,
      pages: { added: pageCount, changed: 0, removed: 0 },
      duration_ms: Date.now() - ingestStart,
      success: refreshSuccess,
      error: refreshError,
    });
  } catch {
    // best-effort — journal write must never break setup
  }

  return { pageCount, tokenCount };
}

// ---------------------------------------------------------------------------
// The "go" command
// ---------------------------------------------------------------------------

interface GoOptions {
  org?: string;
  token?: string;
  tokenFile?: string;
  with?: string[];
  name?: string;
  ingest?: boolean;
  scan?: boolean;
  yes?: boolean;
  repo?: string[];
  reposFile?: string;
  demo?: boolean;
}

export function registerGoCommand(program: Command): void {
  program
    .command("setup")
    .aliases(["init", "go"])
    .description(
      "Set up a withctx project — detect sources, write ctx.yaml, compile wiki"
    )
    .option("--name <name>", "Project name (defaults to package.json name or folder name)")
    .option("--org <org>", "GitHub organization to discover repos from")
    .option(
      "--token <token>",
      "GitHub token for org discovery (INSECURE: ends up in shell history — prefer GITHUB_TOKEN env var or --token-file)"
    )
    .option(
      "--token-file <path>",
      "Path to a file containing the GitHub token (one line, file must be owner-readable only)"
    )
    .option("--with <connectors...>", "Add external connectors (jira, confluence, teams, github)")
    .option(
      "--no-ingest",
      "Write ctx.yaml only — skip the wiki compilation step"
    )
    .option(
      "--scan",
      "Force scan of sibling folders for git repos (auto-on when current dir has no .git)"
    )
    .option(
      "--no-scan",
      "Never scan sibling folders for git repos (useful in CI)"
    )
    .option(
      "--repo <paths...>",
      "Explicit repo path(s) anywhere on disk — absolute or relative, repeatable. Skips sibling auto-scan."
    )
    .option(
      "--repos-file <path>",
      "Read repo paths from a text file (one per line, # for comments). Skips sibling auto-scan."
    )
    .option("-y, --yes", "Skip all prompts (assume yes)")
    .option(
      "--demo",
      "Scaffold a zero-cost demo project (no API key, no LLM calls)"
    )
    .action(async (options: GoOptions) => {
      const rootDir = resolve(process.cwd());

      console.log();
      console.log(chalk.bold.cyan("  ctx setup") + chalk.dim(" — let's get you set up"));
      console.log();

      // ---------------------------------------------------------------
      // Demo mode: scaffold a complete fake project with a pre-built
      // wiki and exit. No sources, no Claude, no cost.
      // ---------------------------------------------------------------
      if (options.demo) {
        try {
          const result = scaffoldDemo(rootDir);
          console.log(
            chalk.bold.green("  Demo scaffolded!") +
              chalk.dim(` — project: ${result.projectName}`)
          );
          console.log();
          console.log(chalk.dim("  Config:  ") + result.configPath);
          console.log(chalk.dim("  Wiki:    ") + result.ctxPath + "/context");
          console.log(chalk.dim("  Pages:   ") + `${result.pageCount} pre-built`);
          console.log(chalk.dim("  Cost:    ") + "$0.00 (no LLM calls)");
          console.log();
          console.log(chalk.bold("  Next:"));
          console.log(
            `    ${chalk.cyan("ctx status")}        ${chalk.dim("see wiki health")}`
          );
          console.log(
            `    ${chalk.cyan("ctx chat")}          ${chalk.dim("ask the demo wiki questions (needs an API key)")}`
          );
          console.log(
            `    ${chalk.cyan("ctx history")}       ${chalk.dim("show the seeded refresh journal")}`
          );
          console.log();
          console.log(
            chalk.dim(
              "  When you're ready for your real project: delete ctx.yaml and .ctx/, then run 'ctx setup' in a real repo."
            )
          );
          console.log();
          return;
        } catch (error) {
          console.error(chalk.red("  Demo scaffold failed"));
          if (error instanceof Error) {
            console.error(chalk.dim(`    ${error.message}`));
          }
          process.exit(1);
        }
      }

      // ---------------------------------------------------------------
      // Offline provider detection — if `ollama serve` is running, tell
      // the user they have a zero-cost alternative. We ONLY mention it
      // (no auto-switching) — offering it as a prompt in the middle of
      // setup would slow down the 99% case where users want Anthropic.
      // Future work: an interactive prompt under `-i / --interactive`.
      // ---------------------------------------------------------------
      if (!process.env.ANTHROPIC_API_KEY && !options.yes) {
        const probe = await probeOllama();
        if (probe.available) {
          const model = pickOllamaModel(probe);
          console.log(
            chalk.dim("  Tip: ") +
              chalk.cyan("Ollama") +
              chalk.dim(` detected at ${probe.baseUrl}`) +
              (model ? chalk.dim(` (${model})`) : "")
          );
          console.log(
            chalk.dim(
              "       Set `ai.provider: ollama` in ctx.yaml to run offline (free)."
            )
          );
          console.log();
        }
      }

      // ---------------------------------------------------------------
      // Step 0: Discover additional repos
      // ---------------------------------------------------------------
      // Three ways to pick up repos beyond the current folder:
      //   a) --repo <path...>    explicit path(s), scattered anywhere
      //   b) --repos-file <file> newline-delimited list (for teams)
      //   c) sibling auto-scan   if cwd has no .git and isn't opted out
      //
      // (a) and (b) win over (c) — if the user is explicit, don't
      // second-guess with auto-detection. They can still be combined
      // with --scan to also fold in siblings on top of explicit paths.
      let siblingRepos: DetectedRepo[] = [];
      let explicitPathsUsed = false;

      // ---- (a) + (b): explicit paths ----
      const explicitPaths: string[] = [];
      if (options.repo && options.repo.length > 0) {
        explicitPaths.push(...options.repo);
      }
      if (options.reposFile) {
        try {
          const filePaths = parseReposFile(resolve(rootDir, options.reposFile));
          explicitPaths.push(...filePaths);
        } catch (err) {
          console.error(
            chalk.red(`  Could not read --repos-file: ${options.reposFile}`)
          );
          if (err instanceof Error) {
            console.error(chalk.dim(`    ${err.message}`));
          }
          process.exit(1);
        }
      }

      if (explicitPaths.length > 0) {
        explicitPathsUsed = true;
        const { repos: found, missing } = readReposFromPaths(
          explicitPaths,
          rootDir,
          rootDir
        );

        if (missing.length > 0) {
          console.log(
            chalk.yellow(
              `  Skipped ${missing.length} path(s) that aren't git repos:`
            )
          );
          for (const m of missing) {
            console.log(chalk.dim(`    ${m}`));
          }
          console.log();
        }

        if (found.length > 0) {
          console.log(
            chalk.bold(`  Using ${found.length} explicit repo path(s):`)
          );
          for (const repo of found) {
            const loc = repo.github
              ? chalk.dim(repo.github.replace(/^https?:\/\//, ""))
              : chalk.dim("(no origin remote)");
            const branch = repo.branch ? chalk.dim(` [${repo.branch}]`) : "";
            console.log(
              `    ${chalk.cyan(repo.name.padEnd(20))} ${loc}${branch}`
            );
            console.log(chalk.dim(`      ${repo.absolutePath}`));
          }
          console.log();
          siblingRepos = found;
        }
      }

      // ---- (c): sibling auto-scan ----
      // Only fires if the user didn't hand us explicit paths, OR if
      // they explicitly combined --repo with --scan to add siblings.
      const currentIsGitRepo = existsSync(join(rootDir, ".git"));
      const shouldScan =
        options.scan === true ||
        (options.scan !== false && !currentIsGitRepo && !explicitPathsUsed);

      if (shouldScan) {
        const found = scanForRepos(rootDir);
        // Merge with anything from explicit paths, de-duping by absolutePath
        const seen = new Set(siblingRepos.map((r) => r.absolutePath));
        const fresh = found.filter((r) => !seen.has(r.absolutePath));

        if (fresh.length > 0) {
          console.log(
            chalk.bold(`  Detected ${fresh.length} git repo(s) in this folder:`)
          );
          for (const repo of fresh) {
            const loc = repo.github
              ? chalk.dim(repo.github.replace(/^https?:\/\//, ""))
              : chalk.dim("(no origin remote)");
            const branch = repo.branch ? chalk.dim(` [${repo.branch}]`) : "";
            console.log(`    ${chalk.cyan(repo.name.padEnd(20))} ${loc}${branch}`);
          }
          console.log();

          const accepted = options.yes === true
            ? true
            : await confirmPrompt(
                "  Add them all to ctx.yaml? (Y/n) ",
                true
              );

          if (accepted) {
            siblingRepos = [...siblingRepos, ...fresh];
          } else {
            console.log(chalk.dim("  Skipping sibling repos."));
            console.log();
          }
        }
      }

      // ---------------------------------------------------------------
      // Step 1: Init
      // ---------------------------------------------------------------
      const initSpinner = ora("Initializing project...").start();

      // Token resolution order:
      //   1. --token-file <path>    (preferred — stays out of shell history)
      //   2. --token <value>        (legacy — prints a loud warning)
      //   3. GITHUB_TOKEN env var   (CI-friendly default)
      //
      // If the user hands us both --token and --token-file we take the
      // file and ignore the inline value. That's the safe default
      // (fewer tokens in history) and matches how kubectl / docker
      // resolve competing credential sources.
      let githubToken: string | undefined;
      if (options.tokenFile) {
        try {
          githubToken = readSecretFile(options.tokenFile);
        } catch (err) {
          console.error(
            chalk.red(
              `  ${err instanceof Error ? err.message : String(err)}`
            )
          );
          process.exit(1);
        }
      } else if (options.token) {
        githubToken = options.token;
        // Warn to stderr so `ctx setup --json` stdout is still clean.
        // The warning is intentionally prominent — we want users to
        // actually stop using --token, not just dismiss it.
        console.error(
          chalk.yellow(
            `  ⚠  --token leaks the PAT into shell history. Prefer ` +
              `GITHUB_TOKEN env var or --token-file <path>.`
          )
        );
      } else {
        githubToken = process.env.GITHUB_TOKEN;
      }
      const connectors = options.with ?? [];

      let initResult: InitResult;
      try {
        initResult = await runInit({
          rootDir,
          connectors,
          org: options.org,
          token: githubToken,
          spinner: initSpinner,
          siblingRepos,
          ...(options.name !== undefined && { projectNameOverride: options.name }),
        });
      } catch (error) {
        initSpinner.fail(chalk.red("Initialization failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }

      // Show detected sources up front — users want to know what was
      // found before anything else happens.
      if (initResult.detectedSources.length > 0) {
        console.log();
        console.log(chalk.bold("  Detected sources:"));
        for (const source of initResult.detectedSources) {
          console.log(
            `    ${chalk.cyan(source.name)} ${chalk.dim(`(${source.path})`)} — ${source.fileCount} files`
          );
        }
        console.log();
      }

      // ---------------------------------------------------------------
      // Step 2: Ingest (only if API key is available AND not skipped)
      // ---------------------------------------------------------------
      const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
      const skipIngest = options.ingest === false;

      if (skipIngest) {
        console.log(
          chalk.dim("  Skipping wiki compilation (--no-ingest). Run ") +
            chalk.bold("ctx ingest") +
            chalk.dim(" when ready.")
        );
      } else if (hasApiKey) {
        const ingestSpinner = ora("Compiling wiki with Claude...").start();

        try {
          const { pageCount, tokenCount, cancelled } = await runIngest(
            rootDir,
            ingestSpinner,
            { skipCostPreview: options.yes === true }
          );

          if (cancelled) {
            ingestSpinner.stop();
            console.log(
              chalk.dim(
                "  Wiki not compiled. Run 'ctx ingest' later when you're ready."
              )
            );
          } else if (pageCount > 0) {
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

      if (!hasApiKey || skipIngest) {
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
            `  ${chalk.cyan("1.")} Compile the wiki:  ${chalk.bold("ctx ingest")}`
          );
          console.log(
            `  ${chalk.cyan("2.")} Chat with your codebase: ${chalk.bold("ctx chat")}`
          );
        }
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
