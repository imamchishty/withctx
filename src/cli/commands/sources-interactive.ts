/**
 * Shared interactive source-add logic.
 * Used by both `ctx sources add [type]` and `ctx add <source-type>`.
 */

import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { findConfigFile } from "../../config/loader.js";
import { resilientFetch } from "../../connectors/resilient-fetch.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const SOURCE_TYPE_NAMES = [
  "confluence",
  "jira",
  "github",
  "slack",
  "notion",
  "local",
] as const;

export type SourceTypeKey = (typeof SOURCE_TYPE_NAMES)[number];

// ---------------------------------------------------------------------------
// Readline prompt helper
// ---------------------------------------------------------------------------

function createPrompt(): {
  ask: (question: string, defaultValue?: string) => Promise<string>;
  askSecret: (question: string) => Promise<string>;
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
      rl.question(`  ${chalk.cyan("?")} ${question}${suffix}: `, (answer) => {
        res(answer.trim() || defaultValue || "");
      });
    });

  const askSecret = (question: string): Promise<string> =>
    new Promise((res) => {
      rl.question(`  ${chalk.cyan("?")} ${question}: `, (answer) => {
        res(answer.trim());
      });
    });

  const confirm = (question: string, defaultYes = false): Promise<boolean> =>
    new Promise((res) => {
      const hint = defaultYes ? chalk.dim(" (Y/n)") : chalk.dim(" (y/N)");
      rl.question(`  ${chalk.cyan("?")} ${question}${hint} `, (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === "") res(defaultYes);
        else res(a === "y" || a === "yes");
      });
    });

  const choose = (question: string, options: string[]): Promise<number> =>
    new Promise((res) => {
      console.log(`  ${chalk.cyan("?")} ${question}`);
      for (let i = 0; i < options.length; i++) {
        console.log(`    ${chalk.cyan(`(${i + 1})`)} ${options[i]}`);
      }
      rl.question(`  ${chalk.cyan(">")} `, (answer) => {
        const idx = parseInt(answer.trim(), 10) - 1;
        res(idx >= 0 && idx < options.length ? idx : 0);
      });
    });

  const close = () => rl.close();

  return { ask, askSecret, confirm, choose, close };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

async function testConfluenceConnection(
  baseUrl: string,
  email: string,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (email) {
      headers["Authorization"] = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    } else {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await resilientFetch(`${baseUrl}/rest/api/space?limit=1`, {
      headers,
      timeout: 15000,
      maxRetries: 1,
    } as RequestInit & { timeout?: number; maxRetries?: number });
    if (res.ok) return { ok: true };
    return { ok: false, error: `HTTP ${res.status} — ${res.statusText}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchConfluenceSpaces(
  baseUrl: string,
  email: string,
  token: string,
): Promise<Array<{ key: string; name: string }>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (email) {
    headers["Authorization"] = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  } else {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await resilientFetch(`${baseUrl}/rest/api/space?limit=100`, {
    headers,
    timeout: 15000,
    maxRetries: 1,
  } as RequestInit & { timeout?: number; maxRetries?: number });
  if (!res.ok) return [];
  const data = (await res.json()) as { results: Array<{ key: string; name: string }> };
  return data.results.map((s) => ({ key: s.key, name: s.name }));
}

async function testJiraConnection(
  baseUrl: string,
  email: string,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (email) {
      headers["Authorization"] = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    } else {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await resilientFetch(`${baseUrl}/rest/api/2/myself`, {
      headers,
      timeout: 15000,
      maxRetries: 1,
    } as RequestInit & { timeout?: number; maxRetries?: number });
    if (res.ok) return { ok: true };
    return { ok: false, error: `HTTP ${res.status} — ${res.statusText}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchJiraProjects(
  baseUrl: string,
  email: string,
  token: string,
): Promise<Array<{ key: string; name: string }>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (email) {
    headers["Authorization"] = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  } else {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await resilientFetch(`${baseUrl}/rest/api/2/project`, {
    headers,
    timeout: 15000,
    maxRetries: 1,
  } as RequestInit & { timeout?: number; maxRetries?: number });
  if (!res.ok) return [];
  const data = (await res.json()) as Array<{ key: string; name: string }>;
  return data.map((p) => ({ key: p.key, name: p.name }));
}

async function testGitHubConnection(
  token: string,
): Promise<{ ok: boolean; error?: string; username?: string }> {
  try {
    const res = await resilientFetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      timeout: 15000,
      maxRetries: 1,
    } as RequestInit & { timeout?: number; maxRetries?: number });
    if (res.ok) {
      const data = (await res.json()) as { login: string };
      return { ok: true, username: data.login };
    }
    return { ok: false, error: `HTTP ${res.status} — ${res.statusText}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function testSlackConnection(
  token: string,
): Promise<{ ok: boolean; error?: string; team?: string }> {
  try {
    const res = await resilientFetch("https://slack.com/api/auth.test", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
      maxRetries: 1,
    } as RequestInit & { timeout?: number; maxRetries?: number });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { ok: boolean; team?: string; error?: string };
    if (data.ok) return { ok: true, team: data.team };
    return { ok: false, error: data.error ?? "Unknown Slack error" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function testNotionConnection(
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await resilientFetch("https://api.notion.com/v1/users/me", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
      },
      timeout: 15000,
      maxRetries: 1,
    } as RequestInit & { timeout?: number; maxRetries?: number });
    if (res.ok) return { ok: true };
    return { ok: false, error: `HTTP ${res.status} — ${res.statusText}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Interactive add flows per source type
// ---------------------------------------------------------------------------

interface AddResult {
  type: SourceTypeKey;
  sourceEntry: Record<string, unknown>;
  sourceName: string;
  summary: string;
}

async function addConfluenceInteractive(prompt: ReturnType<typeof createPrompt>): Promise<AddResult | null> {
  console.log();
  console.log(chalk.bold("  Adding Confluence source..."));
  console.log();

  const baseUrl = (await prompt.ask("Confluence URL", "https://yourorg.atlassian.net")).replace(/\/$/, "");
  const email = await prompt.ask("Email (for Cloud auth, leave blank for Server/DC)");
  const token = await prompt.askSecret("API Token");

  if (!token) {
    console.log(chalk.red("  Token is required."));
    return null;
  }

  const spinner = ora("  Testing connection...").start();
  const test = await testConfluenceConnection(baseUrl, email, token);

  if (!test.ok) {
    spinner.fail(chalk.red(`  Connection failed: ${test.error}`));
    const proceed = await prompt.confirm("Add anyway (with env var placeholders)?", false);
    if (!proceed) return null;

    const name = await prompt.ask("Source name", "confluence");
    const entry: Record<string, unknown> = {
      name,
      base_url: baseUrl,
      token: "${CONFLUENCE_TOKEN}",
    };
    if (email) entry.email = "${CONFLUENCE_EMAIL}";

    return {
      type: "confluence",
      sourceEntry: entry,
      sourceName: name,
      summary: `confluence source '${name}' (unverified)`,
    };
  }

  spinner.succeed(chalk.green("  Connected"));

  const spaces = await fetchConfluenceSpaces(baseUrl, email, token);
  let selectedSpaces: string[] = [];

  if (spaces.length > 0) {
    console.log();
    console.log(`  Found ${chalk.bold(String(spaces.length))} spaces:`);
    for (const s of spaces.slice(0, 20)) {
      console.log(`    ${chalk.cyan(s.key)} — ${s.name}`);
    }
    if (spaces.length > 20) {
      console.log(chalk.dim(`    ... and ${spaces.length - 20} more`));
    }
    console.log();
    const spaceInput = await prompt.ask(
      "Space keys to include (comma-separated, or 'all')",
      "all",
    );
    if (spaceInput.toLowerCase() === "all") {
      selectedSpaces = spaces.map((s) => s.key);
    } else {
      selectedSpaces = spaceInput
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    }
  }

  const name = await prompt.ask("Source name", "confluence");

  const entry: Record<string, unknown> = {
    name,
    base_url: baseUrl,
    token: "${CONFLUENCE_TOKEN}",
  };
  if (email) entry.email = "${CONFLUENCE_EMAIL}";
  if (selectedSpaces.length > 0 && selectedSpaces.length < spaces.length) {
    entry.space = selectedSpaces.length === 1 ? selectedSpaces[0] : selectedSpaces;
  }

  const spaceDesc = selectedSpaces.length > 0
    ? `${selectedSpaces.length} space(s)`
    : "all spaces";

  return {
    type: "confluence",
    sourceEntry: entry,
    sourceName: name,
    summary: `confluence source '${name}' with ${spaceDesc}`,
  };
}

async function addJiraInteractive(prompt: ReturnType<typeof createPrompt>): Promise<AddResult | null> {
  console.log();
  console.log(chalk.bold("  Adding Jira source..."));
  console.log();

  const baseUrl = (await prompt.ask("Jira URL", "https://yourorg.atlassian.net")).replace(/\/$/, "");
  const email = await prompt.ask("Email (for Cloud auth, leave blank for Server/DC)");
  const token = await prompt.askSecret("API Token");

  if (!token) {
    console.log(chalk.red("  Token is required."));
    return null;
  }

  const spinner = ora("  Testing connection...").start();
  const test = await testJiraConnection(baseUrl, email, token);

  if (!test.ok) {
    spinner.fail(chalk.red(`  Connection failed: ${test.error}`));
    const proceed = await prompt.confirm("Add anyway (with env var placeholders)?", false);
    if (!proceed) return null;

    const name = await prompt.ask("Source name", "jira");
    const entry: Record<string, unknown> = {
      name,
      base_url: baseUrl,
      token: "${JIRA_TOKEN}",
    };
    if (email) entry.email = "${JIRA_EMAIL}";

    return {
      type: "jira",
      sourceEntry: entry,
      sourceName: name,
      summary: `jira source '${name}' (unverified)`,
    };
  }

  spinner.succeed(chalk.green("  Connected"));

  const projects = await fetchJiraProjects(baseUrl, email, token);
  let selectedProject = "";

  if (projects.length > 0) {
    console.log();
    console.log(`  Found ${chalk.bold(String(projects.length))} projects:`);
    for (const p of projects.slice(0, 20)) {
      console.log(`    ${chalk.cyan(p.key)} — ${p.name}`);
    }
    if (projects.length > 20) {
      console.log(chalk.dim(`    ... and ${projects.length - 20} more`));
    }
    console.log();
    selectedProject = await prompt.ask(
      "Project key (or 'all' for all projects)",
      "all",
    );
    if (selectedProject.toLowerCase() === "all") {
      selectedProject = "";
    }
  }

  const name = await prompt.ask("Source name", "jira");

  const entry: Record<string, unknown> = {
    name,
    base_url: baseUrl,
    token: "${JIRA_TOKEN}",
  };
  if (email) entry.email = "${JIRA_EMAIL}";
  if (selectedProject) entry.project = selectedProject;

  const projDesc = selectedProject ? `project ${selectedProject}` : "all projects";

  return {
    type: "jira",
    sourceEntry: entry,
    sourceName: name,
    summary: `jira source '${name}' with ${projDesc}`,
  };
}

async function addGitHubInteractive(prompt: ReturnType<typeof createPrompt>): Promise<AddResult | null> {
  console.log();
  console.log(chalk.bold("  Adding GitHub source..."));
  console.log();

  const envToken = process.env.GITHUB_TOKEN;
  let token: string;
  if (envToken) {
    console.log(chalk.dim("  Found GITHUB_TOKEN in environment."));
    const useEnv = await prompt.confirm("Use existing GITHUB_TOKEN?", true);
    token = useEnv ? envToken : await prompt.askSecret("GitHub Personal Access Token");
  } else {
    token = await prompt.askSecret("GitHub Personal Access Token");
  }

  if (!token) {
    console.log(chalk.red("  Token is required."));
    return null;
  }

  const spinner = ora("  Testing connection...").start();
  const test = await testGitHubConnection(token);

  if (!test.ok) {
    spinner.fail(chalk.red(`  Connection failed: ${test.error}`));
    const proceed = await prompt.confirm("Add anyway (with env var placeholders)?", false);
    if (!proceed) return null;

    const owner = await prompt.ask("GitHub owner/org");
    const repo = await prompt.ask("Repository (leave blank for all repos under owner)");
    const name = await prompt.ask("Source name", "github");

    const entry: Record<string, unknown> = {
      name,
      token: "${GITHUB_TOKEN}",
      owner,
    };
    if (repo) entry.repo = repo;

    return {
      type: "github",
      sourceEntry: entry,
      sourceName: name,
      summary: `github source '${name}' (unverified)`,
    };
  }

  spinner.succeed(chalk.green(`  Connected as ${chalk.bold(test.username)}`));

  const owner = await prompt.ask("GitHub owner/org", test.username);
  const repo = await prompt.ask("Repository (leave blank for all repos under owner)");
  const name = await prompt.ask("Source name", "github");

  const entry: Record<string, unknown> = {
    name,
    token: "${GITHUB_TOKEN}",
    owner,
  };
  if (repo) entry.repo = repo;

  const repoDesc = repo ? `${owner}/${repo}` : `all repos under ${owner}`;

  return {
    type: "github",
    sourceEntry: entry,
    sourceName: name,
    summary: `github source '${name}' (${repoDesc})`,
  };
}

async function addSlackInteractive(prompt: ReturnType<typeof createPrompt>): Promise<AddResult | null> {
  console.log();
  console.log(chalk.bold("  Adding Slack source..."));
  console.log();

  const envToken = process.env.SLACK_TOKEN;
  let token: string;
  if (envToken) {
    console.log(chalk.dim("  Found SLACK_TOKEN in environment."));
    const useEnv = await prompt.confirm("Use existing SLACK_TOKEN?", true);
    token = useEnv ? envToken : await prompt.askSecret("Slack Bot Token (xoxb-...)");
  } else {
    token = await prompt.askSecret("Slack Bot Token (xoxb-...)");
  }

  if (!token) {
    console.log(chalk.red("  Token is required."));
    return null;
  }

  const spinner = ora("  Testing connection...").start();
  const test = await testSlackConnection(token);

  if (!test.ok) {
    spinner.fail(chalk.red(`  Connection failed: ${test.error}`));
    const proceed = await prompt.confirm("Add anyway (with env var placeholders)?", false);
    if (!proceed) return null;

    const channels = await prompt.ask("Channel names (comma-separated)", "general");
    const name = await prompt.ask("Source name", "slack");

    return {
      type: "slack",
      sourceEntry: {
        name,
        token: "${SLACK_TOKEN}",
        channels: channels.split(",").map((c) => c.trim().replace(/^#/, "")),
      },
      sourceName: name,
      summary: `slack source '${name}' (unverified)`,
    };
  }

  spinner.succeed(chalk.green(`  Connected to ${chalk.bold(test.team ?? "workspace")}`));

  const channels = await prompt.ask("Channel names (comma-separated)", "general");
  const channelList = channels.split(",").map((c) => c.trim().replace(/^#/, "")).filter(Boolean);
  const name = await prompt.ask("Source name", "slack");

  return {
    type: "slack",
    sourceEntry: {
      name,
      token: "${SLACK_TOKEN}",
      channels: channelList,
    },
    sourceName: name,
    summary: `slack source '${name}' with ${channelList.length} channel(s)`,
  };
}

async function addNotionInteractive(prompt: ReturnType<typeof createPrompt>): Promise<AddResult | null> {
  console.log();
  console.log(chalk.bold("  Adding Notion source..."));
  console.log();

  const envToken = process.env.NOTION_TOKEN;
  let token: string;
  if (envToken) {
    console.log(chalk.dim("  Found NOTION_TOKEN in environment."));
    const useEnv = await prompt.confirm("Use existing NOTION_TOKEN?", true);
    token = useEnv ? envToken : await prompt.askSecret("Notion Integration Token (secret_...)");
  } else {
    token = await prompt.askSecret("Notion Integration Token (secret_...)");
  }

  if (!token) {
    console.log(chalk.red("  Token is required."));
    return null;
  }

  const spinner = ora("  Testing connection...").start();
  const test = await testNotionConnection(token);

  if (!test.ok) {
    spinner.fail(chalk.red(`  Connection failed: ${test.error}`));
    const proceed = await prompt.confirm("Add anyway (with env var placeholders)?", false);
    if (!proceed) return null;

    const dbIds = await prompt.ask("Database IDs (comma-separated, or leave blank)");
    const name = await prompt.ask("Source name", "notion");

    const entry: Record<string, unknown> = {
      name,
      token: "${NOTION_TOKEN}",
    };
    if (dbIds) {
      entry.database_ids = dbIds.split(",").map((d) => d.trim()).filter(Boolean);
    }

    return {
      type: "notion",
      sourceEntry: entry,
      sourceName: name,
      summary: `notion source '${name}' (unverified)`,
    };
  }

  spinner.succeed(chalk.green("  Connected"));

  const dbIds = await prompt.ask("Database IDs (comma-separated, or leave blank for all shared pages)");
  const name = await prompt.ask("Source name", "notion");

  const entry: Record<string, unknown> = {
    name,
    token: "${NOTION_TOKEN}",
  };
  if (dbIds) {
    const ids = dbIds.split(",").map((d) => d.trim()).filter(Boolean);
    if (ids.length > 0) entry.database_ids = ids;
  }

  const dbDesc = entry.database_ids
    ? `${(entry.database_ids as string[]).length} database(s)`
    : "all shared pages";

  return {
    type: "notion",
    sourceEntry: entry,
    sourceName: name,
    summary: `notion source '${name}' with ${dbDesc}`,
  };
}

async function addLocalInteractive(
  prompt: ReturnType<typeof createPrompt>,
  pathArg?: string,
): Promise<AddResult | null> {
  console.log();
  console.log(chalk.bold("  Adding local source..."));
  console.log();

  const localPath = pathArg || (await prompt.ask("Path", "./docs"));
  const resolvedPath = resolve(process.cwd(), localPath);

  if (!existsSync(resolvedPath)) {
    console.log(chalk.yellow(`  Path '${localPath}' does not exist yet.`));
    const proceed = await prompt.confirm("Add anyway?", true);
    if (!proceed) return null;
  } else {
    console.log(chalk.green(`  Path exists: ${resolvedPath}`));
  }

  const defaultName = localPath.replace(/^\.\//, "").replace(/\//g, "-") || "local";
  const name = await prompt.ask("Source name", defaultName);

  return {
    type: "local",
    sourceEntry: { name, path: localPath },
    sourceName: name,
    summary: `local source '${name}' at ${localPath}`,
  };
}

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

function appendSourceToConfig(
  configPath: string,
  type: SourceTypeKey,
  entry: Record<string, unknown>,
): void {
  const data = readRawConfig(configPath);
  if (!data.sources) data.sources = {};
  const sources = data.sources as Record<string, unknown[]>;
  if (!sources[type]) sources[type] = [];
  (sources[type] as Array<Record<string, unknown>>).push(entry);
  writeRawConfig(configPath, data);
}

// ---------------------------------------------------------------------------
// Public entry point — called from both `ctx sources add` and `ctx add`
// ---------------------------------------------------------------------------

export async function runInteractiveSourceAdd(
  typeArg?: string,
  pathArg?: string,
): Promise<void> {
  const configPath = findConfigFile();
  if (!configPath) {
    console.error(chalk.red("No ctx.yaml found. Run 'ctx init' first."));
    process.exit(1);
  }

  const prompt = createPrompt();

  try {
    // Determine source type
    let sourceType: SourceTypeKey;

    if (typeArg && SOURCE_TYPE_NAMES.includes(typeArg as SourceTypeKey)) {
      sourceType = typeArg as SourceTypeKey;
    } else if (typeArg) {
      console.error(
        chalk.red(
          `Unknown source type '${typeArg}'. Supported: ${SOURCE_TYPE_NAMES.join(", ")}`
        )
      );
      process.exit(1);
    } else {
      console.log();
      const idx = await prompt.choose("Source type", [
        "Confluence  — Atlassian wiki pages",
        "Jira        — Issues and epics",
        "GitHub      — Repos, issues, PRs",
        "Slack       — Channel messages",
        "Notion      — Pages and databases",
        "Local       — Files on disk",
      ]);
      sourceType = SOURCE_TYPE_NAMES[idx];
    }

    // Run the interactive flow
    let result: AddResult | null = null;

    switch (sourceType) {
      case "confluence":
        result = await addConfluenceInteractive(prompt);
        break;
      case "jira":
        result = await addJiraInteractive(prompt);
        break;
      case "github":
        result = await addGitHubInteractive(prompt);
        break;
      case "slack":
        result = await addSlackInteractive(prompt);
        break;
      case "notion":
        result = await addNotionInteractive(prompt);
        break;
      case "local":
        result = await addLocalInteractive(prompt, pathArg);
        break;
    }

    if (!result) {
      console.log(chalk.dim("\n  Cancelled.\n"));
      return;
    }

    // Write to ctx.yaml
    appendSourceToConfig(configPath, result.type, result.sourceEntry);

    console.log();
    console.log(
      chalk.green(`  ${chalk.bold("\u2713")} Added ${result.summary} to ctx.yaml`)
    );

    // Offer to sync
    console.log();
    const shouldSync = await prompt.confirm("Sync now?", true);

    if (shouldSync) {
      console.log();
      console.log(
        chalk.cyan(
          `  Run: ${chalk.bold(`ctx sync --source ${result.sourceName}`)}`
        )
      );
      console.log(
        chalk.dim(
          "  Alternatively, run 'ctx go' to compile your full wiki."
        )
      );
    }

    console.log();
    console.log(
      chalk.dim("  Tip: Tokens are stored as ${ENV_VAR} placeholders.")
    );
    console.log(
      chalk.dim(
        "  Set the actual values in your environment or .env file."
      )
    );
    console.log();
  } catch (error) {
    console.log();
    console.error(chalk.red("Failed to add source"));
    if (error instanceof Error) {
      console.error(chalk.red(`  ${error.message}`));
    }
    process.exit(1);
  } finally {
    prompt.close();
  }
}
