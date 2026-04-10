import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { createLLMFromCtxConfig } from "../../llm/index.js";
import type { LintIssue, LintReport } from "../../types/page.js";

interface LintOptions {
  fix?: boolean;
}

function runLocalLintRules(pageManager: PageManager): LintIssue[] {
  const issues: LintIssue[] = [];
  const allPages = pageManager.list();
  const pageSet = new Set(allPages);

  for (const pagePath of allPages) {
    if (pagePath === "index.md" || pagePath === "log.md") continue;

    const page = pageManager.read(pagePath);
    if (!page) continue;

    // Check: page has a title
    if (page.title === "Untitled") {
      issues.push({
        type: "missing",
        severity: "warning",
        page: pagePath,
        message: "Page is missing a title (# heading)",
        suggestion: "Add a # title as the first line",
      });
    }

    // Check: page is not empty
    if (page.content.trim().length < 20) {
      issues.push({
        type: "missing",
        severity: "warning",
        page: pagePath,
        message: "Page has very little content (< 20 chars)",
        suggestion: "Add meaningful content or remove the page",
      });
    }

    // Check: broken internal links
    for (const ref of page.references) {
      if (!pageSet.has(ref) && !ref.startsWith("http")) {
        issues.push({
          type: "orphan",
          severity: "error",
          page: pagePath,
          message: `Broken link to '${ref}' — target page does not exist`,
          relatedPage: ref,
          suggestion: `Create '${ref}' or fix the link`,
        });
      }
    }

    // Check: stale content (no update in 30+ days)
    const daysSinceUpdate = Math.floor(
      (Date.now() - new Date(page.updatedAt).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (daysSinceUpdate > 30) {
      issues.push({
        type: "stale",
        severity: "warning",
        page: pagePath,
        message: `Page not updated in ${daysSinceUpdate} days`,
        suggestion: "Run 'ctx sync' to refresh or review manually",
      });
    }

    // Check: no source attribution
    if (page.sources.length === 0) {
      issues.push({
        type: "missing",
        severity: "warning",
        page: pagePath,
        message: "No source attribution found",
        suggestion: "Add a _Source: ..._ line to track provenance",
      });
    }
  }

  // Check: index completeness
  const indexContent = pageManager.read("index.md")?.content ?? "";
  for (const pagePath of allPages) {
    if (pagePath === "index.md" || pagePath === "log.md") continue;
    if (!indexContent.includes(pagePath)) {
      issues.push({
        type: "orphan",
        severity: "warning",
        page: pagePath,
        message: "Page is not listed in index.md",
        suggestion: "Add this page to the index",
      });
    }
  }

  return issues;
}

export function registerLintCommand(program: Command): void {
  program
    .command("lint")
    .description("Check wiki for contradictions, stale content, broken links, and gaps")
    .option("--fix", "Attempt to auto-fix issues using Claude")
    .action(async (options: LintOptions) => {
      const spinner = ora("Running lint rules...").start();

      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx setup' first."));
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);
        const allPages = pageManager.list();

        if (allPages.length === 0) {
          spinner.fail(chalk.red("No wiki pages to lint."));
          process.exit(1);
        }

        // Run local lint rules
        const localIssues = runLocalLintRules(pageManager);

        // Run Claude-powered contradiction detection
        spinner.text = "Checking for contradictions with Claude...";
        let claudeIssues: LintIssue[] = [];

        const claude = createLLMFromCtxConfig(config, "lint");
        const available = await claude.isAvailable();

        if (available) {
          const contextFiles: Array<{ path: string; content: string }> = [];
          for (const pagePath of allPages) {
            if (pagePath === "log.md") continue;
            const page = pageManager.read(pagePath);
            if (page) {
              contextFiles.push({ path: pagePath, content: page.content });
            }
          }

          const prompt = `Analyze these wiki pages for contradictions — places where two pages say conflicting things.

For each contradiction found, output a JSON line:
{"page": "file.md", "relatedPage": "other.md", "message": "description of contradiction"}

If no contradictions are found, output: NONE

Only report clear contradictions, not minor differences in wording.`;

          try {
            const response = await claude.promptWithFiles(prompt, contextFiles, {
              systemPrompt:
                "You are a wiki quality checker. Find contradictions between pages. Output JSON lines or NONE.",
            });

            if (response.content.trim() !== "NONE") {
              const lines = response.content.trim().split("\n");
              for (const line of lines) {
                try {
                  const parsed = JSON.parse(line) as {
                    page: string;
                    relatedPage: string;
                    message: string;
                  };
                  claudeIssues.push({
                    type: "contradiction",
                    severity: "error",
                    page: parsed.page,
                    relatedPage: parsed.relatedPage,
                    message: parsed.message,
                  });
                } catch {
                  // Skip unparseable lines
                }
              }
            }
          } catch {
            spinner.warn(chalk.yellow("Claude contradiction check failed — skipping"));
          }
        }

        const allIssues = [...localIssues, ...claudeIssues];

        // Build report
        const report: LintReport = {
          timestamp: new Date().toISOString(),
          pagesChecked: allPages.length,
          issues: allIssues,
          summary: {
            contradictions: allIssues.filter((i) => i.type === "contradiction").length,
            stale: allIssues.filter((i) => i.type === "stale").length,
            orphans: allIssues.filter((i) => i.type === "orphan").length,
            missing: allIssues.filter((i) => i.type === "missing").length,
          },
        };

        spinner.stop();

        // Display report
        console.log();
        console.log(chalk.bold("Lint Report"));
        console.log(chalk.dim(`  Checked ${report.pagesChecked} pages at ${report.timestamp}`));
        console.log();

        if (allIssues.length === 0) {
          console.log(chalk.green("  No issues found — wiki is clean!"));
          console.log();
          return;
        }

        // Group by severity
        const errors = allIssues.filter((i) => i.severity === "error");
        const warnings = allIssues.filter((i) => i.severity === "warning");

        if (errors.length > 0) {
          console.log(chalk.red.bold(`  Errors (${errors.length}):`));
          for (const issue of errors) {
            console.log(
              `    ${chalk.red("x")} ${chalk.bold(issue.page)}: ${issue.message}`
            );
            if (issue.suggestion) {
              console.log(`      ${chalk.dim(issue.suggestion)}`);
            }
          }
          console.log();
        }

        if (warnings.length > 0) {
          console.log(chalk.yellow.bold(`  Warnings (${warnings.length}):`));
          for (const issue of warnings) {
            console.log(
              `    ${chalk.yellow("!")} ${chalk.bold(issue.page)}: ${issue.message}`
            );
            if (issue.suggestion) {
              console.log(`      ${chalk.dim(issue.suggestion)}`);
            }
          }
          console.log();
        }

        // Summary
        console.log(chalk.bold("  Summary:"));
        console.log(`    Contradictions: ${report.summary.contradictions}`);
        console.log(`    Stale pages:    ${report.summary.stale}`);
        console.log(`    Orphan refs:    ${report.summary.orphans}`);
        console.log(`    Missing info:   ${report.summary.missing}`);
        console.log();

        // Auto-fix if requested
        if (options.fix && available) {
          const fixSpinner = ora("Attempting auto-fixes with Claude...").start();

          const fixableIssues = allIssues.filter(
            (i) => i.type === "orphan" || i.type === "missing"
          );

          if (fixableIssues.length === 0) {
            fixSpinner.info("No auto-fixable issues found.");
            return;
          }

          const issueList = fixableIssues
            .map(
              (i) =>
                `- ${i.page}: ${i.message}${i.suggestion ? ` (suggestion: ${i.suggestion})` : ""}`
            )
            .join("\n");

          const contextFiles: Array<{ path: string; content: string }> = [];
          for (const pagePath of allPages) {
            const page = pageManager.read(pagePath);
            if (page) {
              contextFiles.push({ path: pagePath, content: page.content });
            }
          }

          const fixPrompt = `Fix the following wiki issues:

${issueList}

Output updated pages in this format:
---PAGE: <filename.md>---
<full page content>
---END PAGE---

Only output pages that need changes.`;

          try {
            const response = await claude.promptWithFiles(fixPrompt, contextFiles, {
              systemPrompt: "You are a wiki fixer. Fix the listed issues. Output only changed pages.",
            });

            const pagePattern = /---PAGE:\s*(.+?)---\n([\s\S]*?)---END PAGE---/g;
            let match;
            let fixCount = 0;

            while ((match = pagePattern.exec(response.content)) !== null) {
              pageManager.write(match[1].trim(), match[2].trim());
              fixCount++;
            }

            fixSpinner.succeed(`Fixed ${fixCount} page(s)`);
          } catch {
            fixSpinner.fail("Auto-fix failed");
          }
        }

        // Update log
        const logContent = ctxDir.readPage("log.md") ?? "";
        const logEntry = `| ${new Date().toISOString()} | lint | Found ${allIssues.length} issues (${errors.length} errors, ${warnings.length} warnings) |`;
        ctxDir.writePage("log.md", logContent + "\n" + logEntry);

        // Exit with error code if there are errors
        if (errors.length > 0) {
          process.exit(1);
        }
      } catch (error) {
        spinner.fail(chalk.red("Lint failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
