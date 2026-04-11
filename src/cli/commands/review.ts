import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { createLLMFromCtxConfig } from "../../llm/index.js";
import { CostTracker } from "../../costs/tracker.js";
import { recordCall } from "../../usage/recorder.js";
import { findAffectedPages, type AffectedPage } from "../../wiki/drift.js";
import type { WikiPage } from "../../types/page.js";

type Severity = "strict" | "normal" | "lenient";
type Focus = "security" | "performance" | "patterns" | "all";

interface ReviewOptions {
  staged?: boolean;
  severity?: Severity;
  focus?: Focus;
  output?: string;
  maxTokens?: string;
  /**
   * Skip the LLM pass entirely and just list wiki pages whose bless
   * or refresh state is invalidated by the diff. LLM-free, $0, and
   * fast enough to run as a pre-commit hook. Fails the process with
   * exit 1 when at least one blessed page is flagged, so CI pipelines
   * can gate merges on "every drifted page must be re-blessed".
   */
  drift?: boolean;
  json?: boolean;
}

/**
 * Resolve the diff content from the input argument.
 * Supports: GitHub PR URL, local diff file, or --staged flag.
 */
function resolveDiff(input: string | undefined, options: ReviewOptions): { diff: string; source: string } {
  // --staged: review staged git changes
  if (options.staged) {
    try {
      const diff = execFileSync("git", ["diff", "--staged"], { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      if (!diff.trim()) {
        throw new Error("No staged changes found. Stage changes with 'git add' first.");
      }
      return { diff, source: "staged changes" };
    } catch (err) {
      if (err instanceof Error && err.message.includes("No staged changes")) throw err;
      throw new Error("Failed to get staged diff. Are you in a git repository?");
    }
  }

  if (!input) {
    throw new Error("Provide a PR URL, diff file path, or use --staged.");
  }

  // GitHub PR URL
  if (input.startsWith("https://github.com/") && input.includes("/pull/")) {
    // Parse the URL up front so the downstream calls only ever see
    // values that matched a strict regex. This protects both branches
    // (gh CLI and the curl fallback) from any attempt to smuggle shell
    // metacharacters or command-line flags through the URL argument.
    const prMatch = input.match(
      /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/,
    );
    if (!prMatch) {
      throw new Error(
        `Invalid GitHub PR URL: ${input}. Expected https://github.com/<owner>/<repo>/pull/<number>.`,
      );
    }
    const [, owner, repo, prNumber] = prMatch;
    const canonicalUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

    try {
      // Try gh CLI first — argv form so no shell involvement.
      const diff = execFileSync("gh", ["pr", "diff", canonicalUrl], {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return { diff, source: canonicalUrl };
    } catch {
      // Fallback: GitHub REST API via curl. Using argv form means the
      // token (which may legitimately contain `$`, `"` or other shell
      // metacharacters after rotation) is passed literally and cannot
      // be interpreted by a shell.
      const token = process.env.GITHUB_TOKEN;
      if (token) {
        try {
          const diff = execFileSync(
            "curl",
            [
              "-s",
              "-H",
              `Authorization: token ${token}`,
              "-H",
              "Accept: application/vnd.github.v3.diff",
              `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
            ],
            { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
          );
          return { diff, source: canonicalUrl };
        } catch {
          throw new Error(
            `Failed to fetch PR diff from GitHub API for ${canonicalUrl}`,
          );
        }
      }
      throw new Error(
        `Failed to fetch PR diff. Ensure 'gh' CLI is installed and authenticated, or set GITHUB_TOKEN.`,
      );
    }
  }

  // Local diff file
  const filePath = resolve(input);
  if (existsSync(filePath)) {
    const diff = readFileSync(filePath, "utf-8");
    return { diff, source: relative(process.cwd(), filePath) };
  }

  throw new Error(
    `Could not resolve input: "${input}". Provide a GitHub PR URL, a local diff file path, or use --staged.`
  );
}

/**
 * Extract changed file paths from a unified diff.
 */
function extractChangedFiles(diff: string): string[] {
  const files: string[] = [];
  const pattern = /^(?:diff --git a\/(.+?) b\/|--- a\/(.+)|[+]{3} b\/(.+))/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(diff)) !== null) {
    const file = match[1] ?? match[2] ?? match[3];
    if (file && !files.includes(file)) {
      files.push(file);
    }
  }

  return files;
}

/**
 * Load relevant wiki pages based on changed files.
 * Matches file paths to repo wiki pages for conventions, architecture, decisions, etc.
 */
function loadRelevantWikiPages(
  pageManager: PageManager,
  changedFiles: string[]
): Array<{ path: string; content: string }> {
  const allPages = pageManager.list();
  const relevant: Array<{ path: string; content: string }> = [];
  const added = new Set<string>();

  // Always include these high-value pages if they exist
  const alwaysInclude = [
    "conventions.md",
    "architecture.md",
    "decisions.md",
    "gotchas.md",
    "cross-repo/dependencies.md",
    "index.md",
    "patterns.md",
    "testing.md",
    "security.md",
  ];

  for (const pagePath of alwaysInclude) {
    if (allPages.includes(pagePath) && !added.has(pagePath)) {
      const page = pageManager.read(pagePath);
      if (page) {
        relevant.push({ path: pagePath, content: page.content });
        added.add(pagePath);
      }
    }
  }

  // Match changed files to repo-specific wiki pages
  for (const changedFile of changedFiles) {
    const parts = changedFile.split("/");
    // Look for repo-level pages that might cover this file's area
    for (const pagePath of allPages) {
      if (added.has(pagePath)) continue;
      const pagePathLower = pagePath.toLowerCase();
      // Match if the wiki page name overlaps with directory names in the changed file
      for (const part of parts) {
        if (
          part.length > 2 &&
          pagePathLower.includes(part.toLowerCase())
        ) {
          const page = pageManager.read(pagePath);
          if (page) {
            relevant.push({ path: pagePath, content: page.content });
            added.add(pagePath);
          }
          break;
        }
      }
    }
  }

  return relevant;
}

/**
 * Build the severity instruction for the review prompt.
 */
function severityInstruction(severity: Severity): string {
  switch (severity) {
    case "strict":
      return `You are performing a STRICT review. Flag every potential issue, no matter how minor. Enforce all conventions rigorously. Require explicit test coverage for every change. Zero tolerance for missing error handling.`;
    case "lenient":
      return `You are performing a LENIENT review. Focus only on critical bugs, security vulnerabilities, and major architectural concerns. Ignore style nitpicks and minor improvements.`;
    case "normal":
    default:
      return `You are performing a STANDARD review. Balance thoroughness with pragmatism. Flag real issues and significant improvements, but skip trivial style nitpicks.`;
  }
}

/**
 * Build the focus instruction for the review prompt.
 */
function focusInstruction(focus: Focus): string {
  switch (focus) {
    case "security":
      return `Focus primarily on SECURITY concerns: injection vulnerabilities, auth issues, data exposure, secrets in code, unsafe deserialization, SSRF, and access control.`;
    case "performance":
      return `Focus primarily on PERFORMANCE concerns: N+1 queries, missing indexes, unnecessary allocations, blocking operations, missing caching, and scalability issues.`;
    case "patterns":
      return `Focus primarily on CODE PATTERNS: adherence to project conventions, consistent patterns, proper abstractions, DRY violations, and architectural alignment.`;
    case "all":
    default:
      return `Review all aspects: correctness, security, performance, patterns, testing, and maintainability.`;
  }
}

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Context-aware PR review using wiki knowledge")
    .argument("[pr-url-or-diff]", "GitHub PR URL or path to a local diff file")
    .option("--staged", "Review staged git changes instead of a PR or diff file")
    .option(
      "--severity <level>",
      "Review strictness: strict, normal, lenient",
      "normal"
    )
    .option(
      "--focus <area>",
      "Review focus: security, performance, patterns, all",
      "all"
    )
    .option("--output <file>", "Write review to a file")
    .option("--max-tokens <n>", "Max tokens for response")
    .option(
      "--drift",
      "Skip LLM review; list wiki pages invalidated by the diff (no API cost)"
    )
    .option("--json", "Emit the report as JSON (only meaningful with --drift)")
    .action(async (input: string | undefined, options: ReviewOptions) => {
      const spinner = ora("Resolving diff...").start();

      try {
        // 1. Resolve the diff
        const { diff, source } = resolveDiff(input, options);
        const changedFiles = extractChangedFiles(diff);

        if (changedFiles.length === 0) {
          spinner.fail(chalk.red("No file changes detected in the diff."));
          process.exit(1);
        }

        spinner.text = `Found ${changedFiles.length} changed file(s). Loading wiki context...`;

        // 2. Load config and wiki
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx setup' first."));
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);

        // ── Drift-only fast path ─────────────────────────────────
        //
        // When `--drift` is set we deliberately skip every LLM-touching
        // code path below. This is the cheap, deterministic, CI-safe
        // review mode: list the wiki pages this diff invalidates, exit
        // non-zero if any of them were blessed, done.
        if (options.drift) {
          spinner.stop();
          const allPaths = pageManager.list();
          const wikiSet: WikiPage[] = [];
          for (const p of allPaths) {
            const page = pageManager.read(p);
            if (page) wikiSet.push(page);
          }
          const affected = findAffectedPages(changedFiles, wikiSet);

          if (options.json) {
            console.log(JSON.stringify(buildDriftJson(source, changedFiles, affected), null, 2));
          } else {
            renderDriftReport(source, changedFiles, affected);
          }

          // Exit non-zero when any blessed page drifted — that's the
          // signal CI should block on.
          const blockedCount = affected.filter((a) => a.classification === "drifted").length;
          if (blockedCount > 0) {
            process.exit(1);
          }
          return;
        }

        const wikiPages = loadRelevantWikiPages(pageManager, changedFiles);

        spinner.text = `Loaded ${wikiPages.length} wiki page(s). Sending to Claude for review...`;

        // 3. Build prompt
        const severity = (options.severity ?? "normal") as Severity;
        const focus = (options.focus ?? "all") as Focus;

        const systemPrompt = `You are a senior code reviewer with deep knowledge of this project's architecture, conventions, and cross-repo dependencies. You have access to the project's compiled wiki for context.

${severityInstruction(severity)}
${focusInstruction(focus)}

Your review MUST use this exact format with these section headers:

## Summary
A 2-3 sentence overview of what this PR/diff does.

## Issues
Critical problems that should be fixed before merging. Each issue should reference the file and line range.
If no issues found, write "No critical issues found."

## Suggestions
Non-blocking improvements and recommendations. Each with file reference.
If no suggestions, write "No suggestions."

## Cross-Repo Impact
Any changes that might affect other repositories or services (reference cross-repo/dependencies.md context).
If no cross-repo impact, write "No cross-repo impact detected."

## Positives
What's done well in this PR. Be specific.

## Verdict
One of: APPROVE, REQUEST_CHANGES, or NEEDS_DISCUSSION, with a brief justification.`;

        const userPrompt = `Review the following diff using the wiki context provided.

## Changed Files
${changedFiles.map((f) => `- ${f}`).join("\n")}

## Diff
\`\`\`diff
${diff}
\`\`\``;

        // 4. Call Claude
        const claude = createLLMFromCtxConfig(config, "review");
        const response = await claude.promptWithFiles(userPrompt, wikiPages, {
          systemPrompt,
          maxTokens: options.maxTokens ? parseInt(options.maxTokens, 10) : 8192,
          cacheSystemPrompt: true,
        });

        spinner.stop();

        // 5. Format and display the review
        const review = response.content;
        const coloredReview = colorizeReview(review);

        console.log();
        console.log(chalk.bold.underline(`Review: ${source}`));
        console.log(chalk.dim(`Files changed: ${changedFiles.length} | Severity: ${severity} | Focus: ${focus}`));
        console.log();
        console.log(coloredReview);
        console.log();

        // 6. Token/cost tracking
        if (response.tokensUsed) {
          const reviewModel = response.model ?? config.costs?.model ?? "claude-sonnet-4";
          const costTracker = new CostTracker(ctxDir, {
            budget: config.costs?.budget,
          });
          costTracker.record(
            "review",
            {
              inputTokens: response.tokensUsed.input,
              outputTokens: response.tokensUsed.output,
            },
            reviewModel
          );
          recordCall(ctxDir, "review", reviewModel, {
            input: response.tokensUsed.input,
            output: response.tokensUsed.output,
            cacheRead: response.tokensUsed.cacheRead ?? 0,
            cacheWrite: response.tokensUsed.cacheCreation ?? 0,
          });

          console.log(
            chalk.dim(
              `Tokens: ${response.tokensUsed.input.toLocaleString()} in / ${response.tokensUsed.output.toLocaleString()} out` +
                (response.tokensUsed.cacheRead
                  ? ` (${response.tokensUsed.cacheRead.toLocaleString()} cache read)`
                  : "")
            )
          );
        }

        console.log(chalk.dim(`Wiki pages consulted: ${wikiPages.length}`));

        // 7. Write to file if requested
        if (options.output) {
          const outputPath = resolve(options.output);
          const fileContent = `# PR Review: ${source}\n\n_Generated: ${new Date().toISOString()}_\n_Severity: ${severity} | Focus: ${focus}_\n_Files changed: ${changedFiles.join(", ")}_\n_Wiki pages: ${wikiPages.map((p) => p.path).join(", ")}_\n\n${review}\n`;
          writeFileSync(outputPath, fileContent);
          console.log();
          console.log(chalk.green(`Review written to ${chalk.bold(outputPath)}`));
        }
      } catch (error) {
        spinner.fail(chalk.red("Review failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}

// ── Drift rendering ──────────────────────────────────────────────────
//
// `ctx review --drift` and `ctx review --drift --json` share the same
// data model; the renderers here are the only things that differ.
// Keeping them adjacent to the command handler (rather than extracted
// to a separate file) makes the "what does --drift print?" question
// answerable by scrolling through one file.

interface DriftJsonReport {
  source: string;
  changedFiles: string[];
  summary: {
    total: number;
    drifted: number;
    stale: number;
    unblessed: number;
  };
  affected: Array<{
    page: string;
    title: string;
    classification: string;
    blessed_by?: string;
    blessed_at?: string;
    blessed_at_sha?: string;
    reasons: Array<{
      changedFile: string;
      kind: string;
      line: number;
      excerpt: string;
    }>;
  }>;
}

function buildDriftJson(
  source: string,
  changedFiles: string[],
  affected: AffectedPage[]
): DriftJsonReport {
  return {
    source,
    changedFiles,
    summary: {
      total: affected.length,
      drifted: affected.filter((a) => a.classification === "drifted").length,
      stale: affected.filter((a) => a.classification === "stale").length,
      unblessed: affected.filter((a) => a.classification === "unblessed").length,
    },
    affected: affected.map((a) => ({
      page: a.page.path,
      title: a.page.title,
      classification: a.classification,
      ...(a.bless.status === "blessed" && {
        blessed_by: a.bless.stamp.blessed_by,
        blessed_at: a.bless.stamp.blessed_at,
        ...(a.bless.stamp.blessed_at_sha && { blessed_at_sha: a.bless.stamp.blessed_at_sha }),
      }),
      reasons: a.reasons.map((r) => ({
        changedFile: r.changedFile,
        kind: r.kind,
        line: r.line,
        excerpt: r.excerpt,
      })),
    })),
  };
}

function renderDriftReport(
  source: string,
  changedFiles: string[],
  affected: AffectedPage[]
): void {
  console.log();
  console.log(chalk.bold.underline(`Drift check: ${source}`));
  console.log(
    chalk.dim(
      `${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} changed`
    )
  );
  console.log();

  if (affected.length === 0) {
    console.log(chalk.green("  \u2713 No wiki pages reference the changed files."));
    console.log(chalk.dim("    Nothing to re-approve or re-sync."));
    console.log();
    return;
  }

  // Classification summary.
  const drifted = affected.filter((a) => a.classification === "drifted");
  const stale = affected.filter((a) => a.classification === "stale");
  const unblessed = affected.filter((a) => a.classification === "unblessed");

  const lines: string[] = [];
  if (drifted.length > 0) {
    lines.push(
      chalk.red(
        `${drifted.length} drifted (approved before this change)`
      )
    );
  }
  if (stale.length > 0) {
    lines.push(chalk.yellow(`${stale.length} stale (refreshed before this change)`));
  }
  if (unblessed.length > 0) {
    lines.push(chalk.dim(`${unblessed.length} not yet approved (manual notes, no trust signal)`));
  }
  console.log("  " + lines.join(chalk.dim(" · ")));
  console.log();

  for (const a of affected) {
    const badge = classificationBadge(a.classification);
    const path = chalk.bold(a.page.path);
    console.log(`  ${badge}  ${path}`);
    if (a.bless.status === "blessed") {
      const by = chalk.cyan(a.bless.stamp.blessed_by);
      const sha = a.bless.stamp.blessed_at_sha ? chalk.dim(`@ ${a.bless.stamp.blessed_at_sha}`) : "";
      console.log(`        ${chalk.dim("last approved by")} ${by} ${sha}`.trimEnd());
    }
    // Show a handful of match reasons, truncated to keep the output
    // scannable.
    const shown = a.reasons.slice(0, 3);
    for (const r of shown) {
      const kindTag = chalk.dim(`[${r.kind}]`);
      const excerpt = r.excerpt.length > 80 ? r.excerpt.slice(0, 77) + "\u2026" : r.excerpt;
      console.log(`        ${kindTag} line ${r.line + 1}: ${chalk.dim(excerpt)}`);
    }
    if (a.reasons.length > shown.length) {
      const more = a.reasons.length - shown.length;
      console.log(`        ${chalk.dim(`\u2026 ${more} more reference${more === 1 ? "" : "s"}`)}`);
    }
  }
  console.log();

  if (drifted.length > 0) {
    console.log(
      chalk.yellow(
        `  Tip: run \`ctx approve ${drifted[0].page.path}\` after re-reading the page to clear drift.`
      )
    );
    console.log();
  }
}

function classificationBadge(cls: string): string {
  switch (cls) {
    case "drifted":
      return chalk.red("\u2717 drifted ");
    case "stale":
      return chalk.yellow("! stale   ");
    case "unblessed":
      // Classification key stays `unblessed` for JSON/API stability;
      // only the human label reads "not approved".
      return chalk.dim("\u2013 not approved");
    default:
      return chalk.dim("\u2013 unknown   ");
  }
}

/**
 * Apply chalk colors to review sections for terminal output.
 */
function colorizeReview(review: string): string {
  const lines = review.split("\n");
  const colored: string[] = [];

  for (const line of lines) {
    // Section headers
    if (line.startsWith("## Summary")) {
      colored.push(chalk.bold.cyan(line));
    } else if (line.startsWith("## Issues")) {
      colored.push(chalk.bold.red(line));
    } else if (line.startsWith("## Suggestions")) {
      colored.push(chalk.bold.yellow(line));
    } else if (line.startsWith("## Cross-Repo Impact")) {
      colored.push(chalk.bold.magenta(line));
    } else if (line.startsWith("## Positives")) {
      colored.push(chalk.bold.green(line));
    } else if (line.startsWith("## Verdict")) {
      colored.push(chalk.bold.white(line));
    }
    // Verdict values
    else if (line.includes("APPROVE")) {
      colored.push(chalk.green(line));
    } else if (line.includes("REQUEST_CHANGES")) {
      colored.push(chalk.red(line));
    } else if (line.includes("NEEDS_DISCUSSION")) {
      colored.push(chalk.yellow(line));
    }
    // Issue markers
    else if (line.trim().startsWith("- ") && colored.length > 0) {
      // Check which section we're in by looking back for the last header
      const lastHeader = [...colored].reverse().find((l) =>
        l.includes("##")
      );
      if (lastHeader?.includes("Issues")) {
        colored.push(chalk.red(line));
      } else if (lastHeader?.includes("Suggestions")) {
        colored.push(chalk.yellow(line));
      } else if (lastHeader?.includes("Positives")) {
        colored.push(chalk.green(line));
      } else {
        colored.push(line);
      }
    } else {
      colored.push(line);
    }
  }

  return colored.join("\n");
}
