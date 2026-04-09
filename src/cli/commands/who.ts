import { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { processMarkdown, parseFrontmatter } from "../../connectors/markdown-processor.js";

interface OwnershipEntry {
  area: string;
  owners: string[];
  lastUpdated: string;
  stale: boolean;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

function isStale(dateStr: string): boolean {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  return diffMs > 30 * 86_400_000; // 30 days
}

/**
 * Extract ownership signals from page content.
 * Looks for patterns like "Owner:", "Maintainer:", "Team:", "Contact:" in the content.
 */
function extractOwnershipFromContent(content: string): string[] {
  const owners: string[] = [];
  const patterns = [
    /^(?:Owner|Maintainer|Team|Contact|Author|Lead)\s*:\s*(.+)$/gim,
    /\|\s*(?:Owner|Maintainer|Team|Contact|Author|Lead)\s*\|\s*(.+?)\s*\|/gim,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const value = match[1].trim().replace(/\*\*/g, "").replace(/`/g, "");
      if (value && value !== "—" && value !== "-" && value !== "N/A") {
        owners.push(value);
      }
    }
  }

  return [...new Set(owners)];
}

/**
 * Get the last git committer for a file path.
 */
function getGitAuthor(filePath: string): string | null {
  try {
    const result = execSync(`git log --format='%an' -1 -- "${filePath}"`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

export function registerWhoCommand(program: Command): void {
  program
    .command("who [search]")
    .description("Show who owns what in the project wiki")
    .option("--format <format>", "Output format: table (default) or json", "table")
    .action(async (search: string | undefined, opts: { format: string }) => {
      try {
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          console.error(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);
        const allPages = pageManager.list();

        if (allPages.length === 0) {
          console.error(chalk.red("No wiki pages found. Run 'ctx ingest' first."));
          process.exit(1);
        }

        // Build ownership entries
        const entries: OwnershipEntry[] = [];

        for (const pagePath of allPages) {
          const page = pageManager.read(pagePath);
          if (!page) continue;

          const owners: string[] = [];

          // 1. Check frontmatter author
          const processed = processMarkdown(pagePath, page.content, ctxDir.contextPath);
          if (processed.metadata.author) {
            owners.push(processed.metadata.author);
          }

          // 2. Extract ownership from content patterns
          const contentOwners = extractOwnershipFromContent(page.content);
          owners.push(...contentOwners);

          // 3. Git blame — last committer
          const fullPath = join(ctxDir.contextPath, pagePath);
          const gitAuthor = getGitAuthor(fullPath);
          if (gitAuthor && !owners.includes(gitAuthor)) {
            owners.push(gitAuthor);
          }

          const area = page.title !== "Untitled" ? page.title : pagePath.replace(/\.md$/, "");

          entries.push({
            area,
            owners: owners.length > 0 ? [...new Set(owners)] : [],
            lastUpdated: page.updatedAt,
            stale: isStale(page.updatedAt),
          });
        }

        // Sort by area name
        entries.sort((a, b) => a.area.localeCompare(b.area));

        // Filter if search term provided
        const filtered = search
          ? entries.filter(
              (e) =>
                e.area.toLowerCase().includes(search.toLowerCase()) ||
                e.owners.some((o) => o.toLowerCase().includes(search.toLowerCase()))
            )
          : entries;

        if (filtered.length === 0) {
          console.log();
          console.log(chalk.yellow(search ? `No matches for "${search}"` : "No ownership data found."));
          console.log();
          return;
        }

        // JSON output
        if (opts.format === "json") {
          console.log(JSON.stringify(filtered, null, 2));
          return;
        }

        // Table output
        const areaWidth = Math.max(24, ...filtered.map((e) => e.area.length + 2));
        const ownerWidth = Math.max(22, ...filtered.map((e) => (e.owners.join(", ") || "\u2014").length + 2));

        console.log();
        console.log(chalk.bold.cyan("withctx ownership"));
        if (search) {
          console.log(chalk.dim(`  Filtered by: "${search}"`));
        }
        console.log();

        // Header
        const header =
          chalk.bold("Area".padEnd(areaWidth)) +
          chalk.bold("Owner(s)".padEnd(ownerWidth)) +
          chalk.bold("Last Updated");
        console.log(`  ${header}`);
        console.log(`  ${chalk.dim("\u2500".repeat(areaWidth + ownerWidth + 20))}`);

        // Rows
        for (const entry of filtered) {
          const area = entry.area.padEnd(areaWidth);
          const ownerStr = entry.owners.length > 0 ? entry.owners.join(", ") : "\u2014";
          const owner = ownerStr.padEnd(ownerWidth);
          const time = formatRelativeTime(entry.lastUpdated);
          const staleFlag = entry.stale ? chalk.yellow(" \u26A0\uFE0F stale") : "";

          console.log(
            `  ${chalk.white(area)}${entry.owners.length > 0 ? chalk.green(owner) : chalk.dim(owner)}${chalk.dim(time)}${staleFlag}`
          );
        }

        // Summary
        console.log();
        const unowned = filtered.filter((e) => e.owners.length === 0).length;
        const staleCount = filtered.filter((e) => e.stale).length;
        console.log(chalk.dim(`  ${filtered.length} areas total`));
        if (unowned > 0) {
          console.log(chalk.yellow(`  ${unowned} area(s) have no owner`));
        }
        if (staleCount > 0) {
          console.log(chalk.yellow(`  ${staleCount} area(s) are stale (>30 days)`));
        }
        console.log();
      } catch (error) {
        console.error(chalk.red("Failed to load ownership data"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
