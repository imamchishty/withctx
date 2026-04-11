import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { createLLMFromCtxConfig } from "../../llm/index.js";
import { CostTracker } from "../../costs/tracker.js";
import { recordCall } from "../../usage/recorder.js";

type OutputFormat = "terminal" | "markdown" | "json";

interface ChangelogOptions {
  since?: string;
  output?: string;
  format?: OutputFormat;
  save?: boolean;
  maxTokens?: string;
}

const SYSTEM_PROMPT = `You are a technical writer generating release notes / changelog from project data. You have access to the project wiki for context about the system architecture, services, and conventions.

Generate structured release notes with EXACTLY these sections (omit a section if there are no items for it):

## Summary
1-2 sentence overview of what changed in this period.

## Features
New capabilities added. Each item should reference the commit hash or PR if available, e.g. "- Added user authentication flow (a1b2c3d)"

## Improvements
Enhancements to existing features.

## Bug Fixes
Issues resolved.

## Breaking Changes
Anything that breaks backwards compatibility. Mark clearly with a warning.

## Infrastructure
CI/CD, dependency, config, deployment changes.

## Documentation
Wiki and documentation updates.

Rules:
- Be concise — one line per item
- Reference commit hashes in parentheses where available
- Group related commits into a single changelog entry
- Use past tense ("Added", "Fixed", "Updated")
- If a section would be empty, omit it entirely
- Do not invent changes — only document what is evidenced in the provided data`;

/**
 * Parse the --since flag into a git-compatible date string.
 * Supports: git tags (v2.3.0), dates (2025-03-01), durations (7d, 30d).
 */
function parseSinceFlag(since: string, projectRoot: string): { date: string; label: string } {
  // Duration: 7d, 30d, etc.
  const durationMatch = since.match(/^(\d+)d$/);
  if (durationMatch) {
    const days = parseInt(durationMatch[1], 10);
    const date = new Date();
    date.setDate(date.getDate() - days);
    return {
      date: date.toISOString().split("T")[0],
      label: `last ${days} days`,
    };
  }

  // Date: YYYY-MM-DD
  const dateMatch = since.match(/^\d{4}-\d{2}-\d{2}$/);
  if (dateMatch) {
    return { date: since, label: `since ${since}` };
  }

  // Git tag or rev: validate against a conservative refname pattern
  // before handing it to git. A refname with `;` or `$(...)` would
  // otherwise slip through even the argv form of execFileSync because
  // git happily accepts weird tag names, and we don't want a hostile
  // `--since` value flowing anywhere near a shell.
  if (/^[A-Za-z0-9._/-]+$/.test(since) && !since.startsWith("-")) {
    try {
      const tagDate = execFileSync(
        "git",
        ["log", "-1", "--format=%ai", since],
        {
          cwd: projectRoot,
          encoding: "utf-8",
        },
      ).trim();
      if (tagDate) {
        return {
          date: tagDate.split(" ")[0],
          label: `since tag ${since}`,
        };
      }
    } catch {
      // Not a valid tag — treat as date string
    }
  }

  return { date: since, label: `since ${since}` };
}

/**
 * Get the date of the last git tag, or fall back to 30 days ago.
 */
function getDefaultSinceDate(projectRoot: string): { date: string; label: string } {
  try {
    const lastTag = execFileSync(
      "git",
      ["describe", "--tags", "--abbrev=0"],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        // stderr swallowed so "fatal: No names found" from a
        // tag-less repo doesn't pollute the terminal.
        stdio: ["pipe", "pipe", "ignore"],
      },
    ).trim();

    // Re-validate git's own output: in theory a malicious tag name
    // could smuggle characters back out through git. We only accept
    // conservative refname characters before using lastTag in
    // another git call.
    if (lastTag && /^[A-Za-z0-9._/-]+$/.test(lastTag)) {
      const tagDate = execFileSync(
        "git",
        ["log", "-1", "--format=%ai", lastTag],
        {
          cwd: projectRoot,
          encoding: "utf-8",
        },
      ).trim();
      return {
        date: tagDate.split(" ")[0],
        label: `since tag ${lastTag}`,
      };
    }
  } catch {
    // No tags — fall back
  }

  const date = new Date();
  date.setDate(date.getDate() - 30);
  return {
    date: date.toISOString().split("T")[0],
    label: "last 30 days (no tags found)",
  };
}

/**
 * Gather git log commits since a given date.
 */
function getGitCommits(projectRoot: string, sinceDate: string): string {
  // Defensive: sinceDate flows in from user input via parseSinceFlag.
  // Even though argv form protects us from shell injection, git itself
  // accepts things like `--pretty=` after `--since=`, so we pin the
  // value to a YYYY-MM-DD shape (which is what our parser produces
  // for every branch except the tag fallback, which has already been
  // resolved to a date by getDefaultSinceDate / parseSinceFlag).
  const normalised = /^\d{4}-\d{2}-\d{2}$/.test(sinceDate)
    ? sinceDate
    : sinceDate.replace(/[^A-Za-z0-9 :,/-]/g, "");
  try {
    return execFileSync(
      "git",
      ["log", "--oneline", `--since=${normalised}`],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      },
    ).trim();
  } catch {
    return "";
  }
}

/**
 * Parse wiki log entries that fall within the date range.
 */
function getWikiLogEntries(ctxDir: CtxDirectory, sinceDate: string): string {
  const logContent = ctxDir.readPage("log.md");
  if (!logContent) return "";

  const sinceTime = new Date(sinceDate).getTime();
  const lines = logContent.split("\n");
  const entries: string[] = [];

  for (const line of lines) {
    // Match table rows: | 2025-04-07T... | action | detail |
    const match = line.match(/^\|\s*(\d{4}-\d{2}-\d{2}T[^|]*)\s*\|(.+)\|(.+)\|/);
    if (match) {
      const timestamp = match[1].trim();
      const entryTime = new Date(timestamp).getTime();
      if (!isNaN(entryTime) && entryTime >= sinceTime) {
        entries.push(line.trim());
      }
    }
  }

  return entries.length > 0
    ? `Wiki log entries:\n${entries.join("\n")}`
    : "";
}

/**
 * Format the changelog for terminal output with colors.
 */
function formatForTerminal(content: string): string {
  let output = content;

  // Colorize headers
  output = output.replace(/^## (.+)$/gm, (_match, title: string) => {
    return chalk.bold.cyan(`## ${title}`);
  });

  // Colorize commit references
  output = output.replace(/\(([a-f0-9]{7,})\)/g, (_match, hash: string) => {
    return chalk.dim(`(${hash})`);
  });

  // Colorize breaking changes warnings
  output = output.replace(/BREAKING/gi, chalk.red.bold("BREAKING"));

  return output;
}

/**
 * Build full markdown document.
 */
function buildMarkdown(content: string, label: string): string {
  const timestamp = new Date().toISOString();
  return `# Changelog — ${label}

_Generated: ${timestamp}_

${content}
`;
}

/**
 * Build JSON output.
 */
function buildJson(
  content: string,
  label: string,
  tokensUsed: { input: number; output: number } | undefined,
  model: string | undefined
): string {
  return JSON.stringify(
    {
      period: label,
      generatedAt: new Date().toISOString(),
      model: model ?? "unknown",
      tokensUsed: tokensUsed ?? null,
      changelog: content,
    },
    null,
    2
  );
}

export function registerChangelogCommand(program: Command): void {
  program
    .command("changelog")
    .description("Auto-generate release notes from wiki context + git history")
    .option("--since <ref>", "Start point: git tag (v2.3.0), date (2025-03-01), or duration (7d, 30d)")
    .option("--output <file>", "Write changelog to a file")
    .option("--format <fmt>", "Output format: terminal, markdown, json", "terminal")
    .option("--save", "Save as a wiki page (manual/changelog-<date>.md)")
    .option("--max-tokens <n>", "Max tokens for Claude response")
    .action(async (options: ChangelogOptions) => {
      const format = (options.format ?? "terminal") as OutputFormat;
      const spinner = ora("Preparing changelog data...").start();

      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx setup' first."));
          process.exit(1);
        }

        // Determine the date range
        const { date: sinceDate, label: sinceLabel } = options.since
          ? parseSinceFlag(options.since, projectRoot)
          : getDefaultSinceDate(projectRoot);

        spinner.text = `Gathering changes ${sinceLabel}...`;

        // 1. Git log
        const gitCommits = getGitCommits(projectRoot, sinceDate);
        if (!gitCommits) {
          spinner.warn(chalk.yellow(`No git commits found ${sinceLabel}.`));
        }

        // 2. Wiki log entries
        const wikiLogEntries = getWikiLogEntries(ctxDir, sinceDate);

        // 3. Wiki context pages (decisions, architecture)
        const pageManager = new PageManager(ctxDir);
        const contextFiles: Array<{ path: string; content: string }> = [];

        const contextPagePaths = ["decisions.md", "architecture.md", "index.md"];
        for (const pagePath of contextPagePaths) {
          const page = pageManager.read(pagePath);
          if (page) {
            contextFiles.push({ path: pagePath, content: page.content });
          }
        }

        // Also load any decision pages
        const allPages = pageManager.list();
        for (const pagePath of allPages) {
          if (
            pagePath.startsWith("decisions/") ||
            pagePath.startsWith("cross-repo/")
          ) {
            const page = pageManager.read(pagePath);
            if (page) {
              contextFiles.push({ path: pagePath, content: page.content });
            }
          }
        }

        // Build the user prompt
        let dataPrompt = `Generate a changelog / release notes for the period: ${sinceLabel}.\n\n`;

        if (gitCommits) {
          dataPrompt += `## Git Commits\n\`\`\`\n${gitCommits}\n\`\`\`\n\n`;
        }

        if (wikiLogEntries) {
          dataPrompt += `## Wiki Activity\n${wikiLogEntries}\n\n`;
        }

        if (!gitCommits && !wikiLogEntries) {
          spinner.fail(chalk.red(`No changes found ${sinceLabel}. Nothing to generate.`));
          process.exit(1);
        }

        dataPrompt += `\nPlease generate structured release notes from the above data.`;

        // Send to Claude
        spinner.text = "Generating changelog with Claude...";

        const claude = createLLMFromCtxConfig(config, "changelog");
        const maxTokens = options.maxTokens ? parseInt(options.maxTokens, 10) : 4096;

        const response = contextFiles.length > 0
          ? await claude.promptWithFiles(dataPrompt, contextFiles, {
              systemPrompt: SYSTEM_PROMPT,
              maxTokens,
              cacheSystemPrompt: true,
            })
          : await claude.prompt(dataPrompt, {
              systemPrompt: SYSTEM_PROMPT,
              maxTokens,
            });

        spinner.stop();

        // Track costs
        if (response.tokensUsed) {
          const changelogModel = response.model ?? "claude-sonnet-4";
          const budget = config.costs?.budget;
          const costTracker = new CostTracker(ctxDir, { budget });
          costTracker.record(
            "query",
            {
              inputTokens: response.tokensUsed.input,
              outputTokens: response.tokensUsed.output,
            },
            changelogModel
          );
          recordCall(ctxDir, "changelog", changelogModel, {
            input: response.tokensUsed.input,
            output: response.tokensUsed.output,
            cacheRead: response.tokensUsed.cacheRead ?? 0,
            cacheWrite: response.tokensUsed.cacheCreation ?? 0,
          });
        }

        // Output
        switch (format) {
          case "json": {
            const jsonOutput = buildJson(
              response.content,
              sinceLabel,
              response.tokensUsed,
              response.model
            );
            if (options.output) {
              writeFileSync(options.output, jsonOutput);
              console.log(chalk.green(`Changelog written to ${chalk.bold(options.output)}`));
            } else {
              console.log(jsonOutput);
            }
            break;
          }
          case "markdown": {
            const mdOutput = buildMarkdown(response.content, sinceLabel);
            if (options.output) {
              writeFileSync(options.output, mdOutput);
              console.log(chalk.green(`Changelog written to ${chalk.bold(options.output)}`));
            } else {
              console.log(mdOutput);
            }
            break;
          }
          case "terminal":
          default: {
            console.log();
            console.log(chalk.bold.white("Changelog"));
            console.log(chalk.dim("─".repeat(60)));
            console.log(chalk.bold("Period:"), chalk.cyan(sinceLabel));
            console.log(chalk.dim("─".repeat(60)));
            console.log();
            console.log(formatForTerminal(response.content));
            console.log();

            if (options.output) {
              const mdOutput = buildMarkdown(response.content, sinceLabel);
              writeFileSync(options.output, mdOutput);
              console.log(chalk.green(`Changelog also written to ${chalk.bold(options.output)}`));
            }
            break;
          }
        }

        // Save as wiki page
        if (options.save) {
          const dateStr = new Date().toISOString().split("T")[0];
          const savePath = `manual/changelog-${dateStr}.md`;
          const saveContent = buildMarkdown(response.content, sinceLabel);
          pageManager.write(savePath, saveContent);
          console.log(chalk.green(`Saved as wiki page: ${chalk.bold(savePath)}`));
        }

        // Token usage summary
        console.log();
        console.log(chalk.dim("─".repeat(60)));
        if (response.model) {
          console.log(chalk.dim(`Model: ${response.model}`));
        }
        if (response.tokensUsed) {
          const total = response.tokensUsed.input + response.tokensUsed.output;
          console.log(
            chalk.dim(
              `Tokens: Input: ${response.tokensUsed.input.toLocaleString()} | Output: ${response.tokensUsed.output.toLocaleString()} | Total: ${total.toLocaleString()}`
            )
          );
          const inputCost = (response.tokensUsed.input / 1_000_000) * 3;
          const outputCost = (response.tokensUsed.output / 1_000_000) * 15;
          console.log(chalk.dim(`Estimated cost: $${(inputCost + outputCost).toFixed(4)}`));
        }
      } catch (error) {
        spinner.fail(chalk.red("Changelog generation failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
