import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { existsSync, readdirSync, statSync, accessSync, constants, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { findConfigFile, loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { ClaudeClient } from "../../claude/client.js";
import type { CtxConfig } from "../../types/config.js";
import { icons, divider } from "../utils/ui.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CheckStatus = "pass" | "warn" | "fail";

interface CheckResult {
  label: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function icon(status: CheckStatus): string {
  switch (status) {
    case "pass":
      return icons.pass;
    case "warn":
      return icons.warn;
    case "fail":
      return icons.fail;
  }
}

function statusColor(status: CheckStatus, text: string): string {
  switch (status) {
    case "pass":
      return chalk.green(text);
    case "warn":
      return chalk.yellow(text);
    case "fail":
      return chalk.red(text);
  }
}

function envIsSet(name: string): boolean {
  const val = process.env[name];
  return val !== undefined && val.trim().length > 0;
}

function countSourceFiles(dir: string, depth = 0): number {
  if (depth > 6) return 0;
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory()) {
        count += countSourceFiles(join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        count++;
      }
    }
  } catch {
    // permission or read error — skip
  }
  return count;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkNodeVersion(): CheckResult {
  const version = process.versions.node;
  const major = parseInt(version.split(".")[0], 10);

  if (major >= 20) {
    return {
      label: "Node.js version",
      status: "pass",
      message: `v${version}`,
    };
  }

  return {
    label: "Node.js version",
    status: "fail",
    message: `v${version} (requires 20+)`,
    fix: "Install Node.js 20+ from https://nodejs.org or use nvm: nvm install 20",
  };
}

function checkConfigFile(): CheckResult {
  const configPath = findConfigFile();
  if (configPath) {
    return {
      label: "ctx.yaml",
      status: "pass",
      message: configPath,
    };
  }

  return {
    label: "ctx.yaml",
    status: "fail",
    message: "Not found",
    fix: "Run 'ctx init' to create a configuration file.",
  };
}

function checkCtxDirectory(): CheckResult {
  const configPath = findConfigFile();
  if (!configPath) {
    return {
      label: ".ctx/ directory",
      status: "fail",
      message: "Cannot check — no ctx.yaml found",
      fix: "Run 'ctx init' to initialize the project.",
    };
  }

  const projectRoot = resolve(configPath, "..");
  const ctxDir = new CtxDirectory(projectRoot);

  if (ctxDir.exists()) {
    return {
      label: ".ctx/ directory",
      status: "pass",
      message: join(projectRoot, ".ctx"),
    };
  }

  return {
    label: ".ctx/ directory",
    status: "fail",
    message: "Not initialized",
    fix: "Run 'ctx init' to create the .ctx/ directory.",
  };
}

function checkApiKey(): CheckResult {
  if (envIsSet("ANTHROPIC_API_KEY")) {
    const key = process.env["ANTHROPIC_API_KEY"]!;
    const masked = key.slice(0, 8) + "..." + key.slice(-4);
    return {
      label: "ANTHROPIC_API_KEY",
      status: "pass",
      message: masked,
    };
  }

  return {
    label: "ANTHROPIC_API_KEY",
    status: "fail",
    message: "Not set",
    fix: "Export the key: export ANTHROPIC_API_KEY=sk-ant-...",
  };
}

async function checkApiConnection(config?: CtxConfig | null): Promise<CheckResult> {
  if (!envIsSet("ANTHROPIC_API_KEY")) {
    return {
      label: "API connection",
      status: "fail",
      message: "Skipped — no API key",
      fix: "Set ANTHROPIC_API_KEY first.",
    };
  }

  const spinner = ora({ text: "Testing API connection...", indent: 2 }).start();

  try {
    const client = new ClaudeClient(
      config?.costs?.model ?? "claude-sonnet-4-20250514",
      { baseURL: config?.ai?.base_url }
    );
    const available = await client.isAvailable();
    const baseURL = client.getBaseURL();
    const isDefault = baseURL === "https://api.anthropic.com";
    const urlSuffix = isDefault ? "" : ` via ${baseURL}`;

    if (available) {
      spinner.stop();
      return {
        label: "API connection",
        status: "pass",
        message: `Connected (${client.getModel()})${urlSuffix}`,
      };
    }

    spinner.stop();
    return {
      label: "API connection",
      status: "fail",
      message: `API returned no content${urlSuffix}`,
      fix: isDefault
        ? "Check your API key is valid and has available credits at https://console.anthropic.com"
        : `Check that ${baseURL} is reachable and speaks the Anthropic Messages API.`,
    };
  } catch (error) {
    spinner.stop();
    const msg = error instanceof Error ? error.message : "Unknown error";
    return {
      label: "API connection",
      status: "fail",
      message: msg,
      fix: "Check your API key and network connection. Visit https://console.anthropic.com to verify your account.",
    };
  }
}

function checkLocalSources(config: CtxConfig, projectRoot: string): CheckResult[] {
  const results: CheckResult[] = [];
  const locals = config.sources?.local ?? [];

  for (const source of locals) {
    const fullPath = resolve(projectRoot, source.path);
    if (!existsSync(fullPath)) {
      results.push({
        label: `Source: ${source.name} (local)`,
        status: "fail",
        message: `Path does not exist: ${fullPath}`,
        fix: `Create the directory or update the path in ctx.yaml.`,
      });
      continue;
    }

    const stat = statSync(fullPath);
    if (!stat.isDirectory()) {
      results.push({
        label: `Source: ${source.name} (local)`,
        status: "warn",
        message: `Path is a file, not a directory: ${fullPath}`,
      });
      continue;
    }

    const fileCount = countSourceFiles(fullPath);
    results.push({
      label: `Source: ${source.name} (local)`,
      status: fileCount > 0 ? "pass" : "warn",
      message: fileCount > 0 ? `${fileCount} file(s) in ${source.path}` : `Empty directory: ${source.path}`,
      ...(fileCount === 0 && { fix: "Add files to this source directory or remove it from ctx.yaml." }),
    });
  }

  return results;
}

function checkEnvVars(
  label: string,
  vars: Array<{ name: string; required: boolean }>
): CheckResult {
  const missing: string[] = [];
  const present: string[] = [];

  for (const v of vars) {
    if (envIsSet(v.name)) {
      present.push(v.name);
    } else if (v.required) {
      missing.push(v.name);
    }
  }

  if (missing.length === 0) {
    return {
      label,
      status: "pass",
      message: `${present.length}/${vars.length} env var(s) set`,
    };
  }

  return {
    label,
    status: "fail",
    message: `Missing: ${missing.join(", ")}`,
    fix: `Export the required variables:\n${missing.map((v) => `     export ${v}=<value>`).join("\n")}`,
  };
}

function checkJiraSources(config: CtxConfig): CheckResult[] {
  const sources = config.sources?.jira ?? [];
  return sources.map((source) =>
    checkEnvVars(`Source: ${source.name} (jira)`, [
      { name: "JIRA_URL", required: true },
      { name: "JIRA_TOKEN", required: true },
      { name: "JIRA_EMAIL", required: false },
    ])
  );
}

function checkConfluenceSources(config: CtxConfig): CheckResult[] {
  const sources = config.sources?.confluence ?? [];
  return sources.map((source) =>
    checkEnvVars(`Source: ${source.name} (confluence)`, [
      { name: "CONFLUENCE_URL", required: true },
      { name: "CONFLUENCE_TOKEN", required: true },
      { name: "CONFLUENCE_EMAIL", required: false },
    ])
  );
}

function checkGitHubSources(config: CtxConfig): CheckResult[] {
  const sources = config.sources?.github ?? [];
  return sources.map((source) =>
    checkEnvVars(`Source: ${source.name} (github)`, [
      { name: "GITHUB_TOKEN", required: true },
    ])
  );
}

function checkTeamsSources(config: CtxConfig): CheckResult[] {
  const sources = config.sources?.teams ?? [];
  return sources.map((source) =>
    checkEnvVars(`Source: ${source.name} (teams)`, [
      { name: "TEAMS_TENANT_ID", required: true },
      { name: "TEAMS_CLIENT_ID", required: true },
      { name: "TEAMS_CLIENT_SECRET", required: true },
    ])
  );
}

function checkNotionSources(config: CtxConfig): CheckResult[] {
  const sources = config.sources?.notion ?? [];
  return sources.map((source) =>
    checkEnvVars(`Source: ${source.name} (notion)`, [
      { name: "NOTION_TOKEN", required: true },
    ])
  );
}

function checkSlackSources(config: CtxConfig): CheckResult[] {
  const sources = config.sources?.slack ?? [];
  return sources.map((source) =>
    checkEnvVars(`Source: ${source.name} (slack)`, [
      { name: "SLACK_TOKEN", required: true },
    ])
  );
}

function checkWikiWritable(projectRoot: string): CheckResult {
  const ctxDir = new CtxDirectory(projectRoot);
  const targetPath = ctxDir.exists() ? ctxDir.path : projectRoot;

  try {
    accessSync(targetPath, constants.W_OK);
    return {
      label: "Wiki directory writable",
      status: "pass",
      message: targetPath,
    };
  } catch {
    return {
      label: "Wiki directory writable",
      status: "fail",
      message: `Cannot write to ${targetPath}`,
      fix: "Check directory permissions (try: chmod -R u+w .ctx/).",
    };
  }
}

function checkWikiHasPages(projectRoot: string): CheckResult {
  const ctxDir = new CtxDirectory(projectRoot);
  if (!ctxDir.exists()) {
    return {
      label: "Wiki content",
      status: "warn",
      message: "Wiki not initialized",
      fix: "Run 'ctx init' then 'ctx sync' to build the wiki.",
    };
  }

  const pageManager = new PageManager(ctxDir);
  const allPages = pageManager.list();
  const contentPages = allPages.filter((p) => {
    const base = p.split("/").pop() ?? p;
    return base !== "index.md" && base !== "log.md" && base !== "glossary.md";
  });

  if (contentPages.length === 0) {
    return {
      label: "Wiki content",
      status: "warn",
      message: "Wiki is empty — no pages yet",
      fix: "Run 'ctx sync' to fetch sources and compile the wiki.",
    };
  }

  return {
    label: "Wiki content",
    status: "pass",
    message: `${contentPages.length} page(s)`,
  };
}

function checkLastSyncAge(projectRoot: string): CheckResult | null {
  const ctxDir = new CtxDirectory(projectRoot);
  if (!ctxDir.exists()) return null;

  const pageManager = new PageManager(ctxDir);
  const allPages = pageManager.list();
  const contentPages = allPages.filter((p) => {
    const base = p.split("/").pop() ?? p;
    return base !== "index.md" && base !== "log.md" && base !== "glossary.md";
  });

  if (contentPages.length === 0) return null;

  let newestMs = 0;
  for (const pagePath of contentPages) {
    try {
      const stat = statSync(join(ctxDir.contextPath, pagePath));
      if (stat.mtimeMs > newestMs) newestMs = stat.mtimeMs;
    } catch {
      // ignore
    }
  }

  if (newestMs === 0) return null;

  const ageDays = Math.floor((Date.now() - newestMs) / (1000 * 60 * 60 * 24));

  if (ageDays > 7) {
    return {
      label: "Last sync age",
      status: "warn",
      message: `Wiki hasn't been synced in ${ageDays} day(s)`,
      fix: "Run 'ctx sync' to refresh the wiki from sources.",
    };
  }

  return {
    label: "Last sync age",
    status: "pass",
    message: ageDays === 0 ? "Synced today" : `${ageDays} day(s) ago`,
  };
}

function checkDependencies(projectRoot: string): CheckResult | null {
  const pkgPath = join(projectRoot, "package.json");
  if (!existsSync(pkgPath)) return null;

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return null;
  }

  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const hasWithctx = Object.keys(deps).some(
    (name) => name === "withctx" || name.startsWith("withctx-") || name.startsWith("@withctx/")
  );

  if (!hasWithctx) return null;

  const nodeModulesPath = join(projectRoot, "node_modules");
  if (!existsSync(nodeModulesPath)) {
    return {
      label: "Dependencies",
      status: "warn",
      message: "node_modules missing",
      fix: "Run 'npm install' to install dependencies.",
    };
  }

  const withctxInstalled = existsSync(join(nodeModulesPath, "withctx"));
  if (!withctxInstalled && deps["withctx"]) {
    return {
      label: "Dependencies",
      status: "warn",
      message: "withctx listed in package.json but not installed",
      fix: "Run 'npm install' to sync dependencies.",
    };
  }

  return {
    label: "Dependencies",
    status: "pass",
    message: "withctx dependencies installed",
  };
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run pre-flight diagnostics — check environment, config, sources, and API connectivity")
    .action(async () => {
      console.log();
      console.log(chalk.bold.cyan("ctx doctor"));
      console.log(divider("\u2500", 50));
      console.log();

      const results: CheckResult[] = [];

      // ----- Environment checks -----
      console.log(chalk.bold("Environment"));

      results.push(checkNodeVersion());
      results.push(checkConfigFile());
      results.push(checkCtxDirectory());
      results.push(checkApiKey());

      // Load config early so the API check can honour ai.base_url.
      const configPath = findConfigFile();
      let config: CtxConfig | null = null;
      let projectRoot: string | null = null;

      if (configPath) {
        try {
          config = loadConfig(configPath);
          projectRoot = getProjectRoot(configPath);
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Unknown error";
          results.push({
            label: "Config parsing",
            status: "fail",
            message: msg,
            fix: "Fix the syntax errors in ctx.yaml and re-run ctx doctor.",
          });
        }
      }

      const apiResult = await checkApiConnection(config);
      results.push(apiResult);

      // Print environment results
      for (const r of results) {
        console.log(`  ${icon(r.status)} ${r.label}: ${statusColor(r.status, r.message)}`);
      }

      if (config && projectRoot) {
        const sourceResults: CheckResult[] = [
          ...checkLocalSources(config, projectRoot),
          ...checkJiraSources(config),
          ...checkConfluenceSources(config),
          ...checkGitHubSources(config),
          ...checkTeamsSources(config),
          ...checkNotionSources(config),
          ...checkSlackSources(config),
        ];

        if (sourceResults.length > 0) {
          console.log();
          console.log(chalk.bold("Sources"));

          for (const r of sourceResults) {
            console.log(`  ${icon(r.status)} ${r.label}: ${statusColor(r.status, r.message)}`);
          }

          results.push(...sourceResults);
        }

        // ----- Wiki checks -----
        const wikiResults: CheckResult[] = [];
        wikiResults.push(checkWikiWritable(projectRoot));
        wikiResults.push(checkWikiHasPages(projectRoot));

        const lastSync = checkLastSyncAge(projectRoot);
        if (lastSync) wikiResults.push(lastSync);

        const deps = checkDependencies(projectRoot);
        if (deps) wikiResults.push(deps);

        if (wikiResults.length > 0) {
          console.log();
          console.log(chalk.bold("Wiki"));

          for (const r of wikiResults) {
            console.log(`  ${icon(r.status)} ${r.label}: ${statusColor(r.status, r.message)}`);
          }

          results.push(...wikiResults);
        }
      }

      // ----- Summary -----
      console.log();
      console.log(divider("\u2500", 50));

      const failCount = results.filter((r) => r.status === "fail").length;
      const warnCount = results.filter((r) => r.status === "warn").length;
      const passCount = results.filter((r) => r.status === "pass").length;

      console.log(
        `  ${chalk.green(`${passCount} passed`)}` +
          (warnCount > 0 ? `  ${chalk.yellow(`${warnCount} warning(s)`)}` : "") +
          (failCount > 0 ? `  ${chalk.red(`${failCount} failed`)}` : "")
      );

      // Show fix instructions for failures
      const fixable = results.filter((r) => r.status === "fail" && r.fix);
      if (fixable.length > 0) {
        console.log();
        console.log(chalk.bold("How to fix:"));
        for (const r of fixable) {
          console.log();
          console.log(`  ${icons.fail} ${chalk.bold(r.label)}`);
          console.log(`     ${chalk.dim(r.fix!)}`);
        }
      }

      // Show warnings
      const warnings = results.filter((r) => r.status === "warn" && r.fix);
      if (warnings.length > 0) {
        console.log();
        console.log(chalk.bold("Warnings:"));
        for (const r of warnings) {
          console.log();
          console.log(`  ${icons.warn} ${chalk.bold(r.label)}`);
          console.log(`     ${chalk.dim(r.fix!)}`);
        }
      }

      // Final summary line
      console.log();
      if (failCount > 0) {
        console.log(
          `  ${icons.fail} ${chalk.bold.red(`${failCount} check${failCount === 1 ? "" : "s"} failed`)} ${chalk.dim("— see fixes above")}`
        );
      } else if (warnCount > 0) {
        console.log(
          `  ${icons.warn} ${chalk.bold.yellow(`${warnCount} warning${warnCount === 1 ? "" : "s"}`)} ${chalk.dim("— see fixes above")}`
        );
      } else {
        console.log(
          `  ${icons.pass} ${chalk.bold.green("Everything looks good!")} ${chalk.dim("Next:")} ${chalk.cyan("ctx sync")}`
        );
      }

      console.log();

      // Exit with appropriate code
      if (failCount > 0) {
        process.exit(1);
      }
    });
}
