import chalk from "chalk";
import type { LintReport, LintIssue } from "../types/page.js";
import type { CtxDirectory } from "../storage/ctx-dir.js";

/**
 * Format a LintReport as colored terminal output.
 */
export function formatLintReport(report: LintReport): string {
  const lines: string[] = [];

  lines.push(chalk.bold("\n=== Wiki Lint Report ===\n"));
  lines.push(`  Pages checked: ${report.pagesChecked}`);
  lines.push(`  Timestamp:     ${report.timestamp}\n`);

  const totalIssues = report.issues.length;

  if (totalIssues === 0) {
    lines.push(chalk.green("  No issues found. Wiki is clean.\n"));
    return lines.join("\n");
  }

  // Group by type
  const grouped = groupByType(report.issues);

  if (grouped.contradiction.length > 0) {
    lines.push(chalk.red.bold(`  Contradictions (${grouped.contradiction.length}):`));
    for (const issue of grouped.contradiction) {
      lines.push(formatIssue(issue));
    }
    lines.push("");
  }

  if (grouped.stale.length > 0) {
    lines.push(chalk.yellow.bold(`  Stale Pages (${grouped.stale.length}):`));
    for (const issue of grouped.stale) {
      lines.push(formatIssue(issue));
    }
    lines.push("");
  }

  if (grouped.orphan.length > 0) {
    lines.push(chalk.cyan.bold(`  Orphan Pages (${grouped.orphan.length}):`));
    for (const issue of grouped.orphan) {
      lines.push(formatIssue(issue));
    }
    lines.push("");
  }

  if (grouped.missing.length > 0) {
    lines.push(chalk.magenta.bold(`  Missing Pages (${grouped.missing.length}):`));
    for (const issue of grouped.missing) {
      lines.push(formatIssue(issue));
    }
    lines.push("");
  }

  // Summary line
  const summaryColor = totalIssues > 5 ? chalk.red : chalk.yellow;
  lines.push(
    summaryColor(
      `  Total: ${totalIssues} issue${totalIssues === 1 ? "" : "s"} ` +
        `(${report.summary.contradictions} contradictions, ` +
        `${report.summary.stale} stale, ` +
        `${report.summary.orphans} orphans, ` +
        `${report.summary.missing} missing)`
    )
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Write lint-report.md to the .ctx/ directory.
 */
export function writeLintReportFile(
  report: LintReport,
  ctx: CtxDirectory
): void {
  const lines: string[] = [];

  lines.push("# Lint Report");
  lines.push("");
  lines.push(`_Generated: ${report.timestamp}_`);
  lines.push(`_Pages checked: ${report.pagesChecked}_`);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(`| Type | Count |`);
  lines.push(`|------|-------|`);
  lines.push(`| Contradictions | ${report.summary.contradictions} |`);
  lines.push(`| Stale | ${report.summary.stale} |`);
  lines.push(`| Orphans | ${report.summary.orphans} |`);
  lines.push(`| Missing | ${report.summary.missing} |`);
  lines.push(`| **Total** | **${report.issues.length}** |`);
  lines.push("");

  if (report.issues.length > 0) {
    lines.push("## Issues");
    lines.push("");

    const grouped = groupByType(report.issues);

    for (const [type, issues] of Object.entries(grouped)) {
      if (issues.length === 0) continue;
      lines.push(`### ${capitalize(type)}s`);
      lines.push("");
      for (const issue of issues) {
        const severity =
          issue.severity === "error" ? "ERROR" : "WARN";
        lines.push(
          `- **[${severity}]** \`${issue.page}\`: ${issue.message}`
        );
        if (issue.relatedPage) {
          lines.push(`  - Related: \`${issue.relatedPage}\``);
        }
        if (issue.suggestion) {
          lines.push(`  - Suggestion: ${issue.suggestion}`);
        }
      }
      lines.push("");
    }
  }

  ctx.writePage("lint-report.md", lines.join("\n"));
}

function formatIssue(issue: LintIssue): string {
  const severity =
    issue.severity === "error"
      ? chalk.red("ERROR")
      : chalk.yellow("WARN ");

  let line = `    [${severity}] ${chalk.bold(issue.page)}`;
  if (issue.relatedPage) {
    line += chalk.dim(` <-> ${issue.relatedPage}`);
  }
  line += `\n             ${issue.message}`;
  if (issue.suggestion) {
    line += chalk.dim(`\n             Suggestion: ${issue.suggestion}`);
  }
  return line;
}

interface GroupedIssues {
  contradiction: LintIssue[];
  stale: LintIssue[];
  orphan: LintIssue[];
  missing: LintIssue[];
}

function groupByType(issues: LintIssue[]): GroupedIssues {
  return {
    contradiction: issues.filter((i) => i.type === "contradiction"),
    stale: issues.filter((i) => i.type === "stale"),
    orphan: issues.filter((i) => i.type === "orphan"),
    missing: issues.filter((i) => i.type === "missing"),
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
