import { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";

type EventType = "decision" | "ingest" | "sync" | "page-created" | "page-updated" | "manual-add" | "init" | "query";
type FilterType = "all" | "decisions" | "syncs" | "manual" | "pages";
type OutputFormat = "terminal" | "markdown" | "json";

interface TimelineEvent {
  date: string;
  type: EventType;
  description: string;
  relatedPages: string[];
}

interface TimelineOptions {
  since?: string;
  limit?: string;
  type?: FilterType;
  output?: string;
  format?: OutputFormat;
}

/**
 * Parse --since flag into a Date. Supports dates (2025-01-01) and durations (30d).
 */
function parseSince(since: string): Date {
  const durationMatch = since.match(/^(\d+)d$/);
  if (durationMatch) {
    const days = parseInt(durationMatch[1], 10);
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date;
  }
  return new Date(since);
}

/**
 * Parse wiki log.md entries into timeline events.
 */
function parseLogEntries(ctxDir: CtxDirectory): TimelineEvent[] {
  const logContent = ctxDir.readPage("log.md");
  if (!logContent) return [];

  const events: TimelineEvent[] = [];
  const lines = logContent.split("\n");

  for (const line of lines) {
    const match = line.match(/^\|\s*(\d{4}-\d{2}-\d{2}T[^|]*)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/);
    if (!match) continue;

    const timestamp = match[1].trim();
    const action = match[2].trim().toLowerCase();
    const detail = match[3].trim();

    let type: EventType = "sync";
    if (action === "init") type = "init";
    else if (action === "ingest") type = "ingest";
    else if (action === "sync") type = "sync";
    else if (action === "add" || action === "manual") type = "manual-add";
    else if (action === "query") type = "query";

    // Extract referenced pages from the detail
    const pageRefs: string[] = [];
    const pagePattern = /([a-z0-9-]+(?:\/[a-z0-9-]+)*\.md)/gi;
    let pageMatch;
    while ((pageMatch = pagePattern.exec(detail)) !== null) {
      pageRefs.push(pageMatch[1]);
    }

    events.push({
      date: timestamp,
      type,
      description: detail,
      relatedPages: pageRefs,
    });
  }

  return events;
}

/**
 * Get page creation/update events from wiki page metadata.
 */
function getPageEvents(pageManager: PageManager): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const allPages = pageManager.list();

  for (const pagePath of allPages) {
    if (pagePath === "index.md" || pagePath === "log.md") continue;

    const page = pageManager.read(pagePath);
    if (!page) continue;

    // Detect decisions
    const isDecision =
      pagePath.startsWith("decisions/") ||
      pagePath.includes("decision") ||
      page.content.includes("## Decision") ||
      page.content.includes("## Status");

    if (isDecision) {
      events.push({
        date: page.createdAt,
        type: "decision",
        description: `Decision: ${page.title} (${pagePath})`,
        relatedPages: [pagePath],
      });
    }
  }

  return events;
}

/**
 * Get git history for .ctx/ directory changes.
 */
function getGitWikiHistory(projectRoot: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  try {
    const gitLog = execSync('git log --format="%aI|%s" -- .ctx/', {
      cwd: projectRoot,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();

    if (!gitLog) return events;

    for (const line of gitLog.split("\n")) {
      const pipeIdx = line.indexOf("|");
      if (pipeIdx === -1) continue;

      const timestamp = line.slice(0, pipeIdx).trim();
      const subject = line.slice(pipeIdx + 1).trim();

      if (!timestamp || !subject) continue;

      events.push({
        date: timestamp,
        type: "sync",
        description: subject,
        relatedPages: [],
      });
    }
  } catch {
    // Git not available or not a repo — skip
  }

  return events;
}

/**
 * Map EventType to filter category.
 */
function matchesFilter(type: EventType, filter: FilterType): boolean {
  if (filter === "all") return true;
  if (filter === "decisions") return type === "decision";
  if (filter === "syncs") return type === "sync" || type === "ingest";
  if (filter === "manual") return type === "manual-add";
  if (filter === "pages") return type === "page-created" || type === "page-updated" || type === "decision";
  return true;
}

/**
 * Get the icon and color for an event type.
 */
function getEventStyle(type: EventType): { icon: string; colorFn: (s: string) => string } {
  switch (type) {
    case "decision":
      return { icon: "\u25C6", colorFn: chalk.yellow };
    case "manual-add":
      return { icon: "\u25CB", colorFn: chalk.blue };
    case "init":
      return { icon: "\u2605", colorFn: chalk.magenta };
    case "ingest":
    case "sync":
    case "page-created":
    case "page-updated":
    case "query":
    default:
      return { icon: "\u25CF", colorFn: chalk.green };
  }
}

/**
 * Format a single timeline event for terminal display.
 */
function formatTerminalEvent(event: TimelineEvent): string {
  const dateStr = event.date.slice(0, 10);
  const { icon, colorFn } = getEventStyle(event.type);
  return `  ${chalk.cyan(dateStr)}  ${colorFn(icon)} ${event.description}`;
}

/**
 * Format a single timeline event for markdown.
 */
function formatMarkdownEvent(event: TimelineEvent): string {
  const dateStr = event.date.slice(0, 10);
  const typeLabel = event.type.replace("-", " ");
  const pages = event.relatedPages.length > 0
    ? ` (${event.relatedPages.join(", ")})`
    : "";
  return `- **${dateStr}** [${typeLabel}] ${event.description}${pages}`;
}

/**
 * Build the full timeline output.
 */
function buildTimeline(events: TimelineEvent[], format: OutputFormat, projectName: string): string {
  if (events.length === 0) {
    return format === "json"
      ? JSON.stringify({ project: projectName, events: [] }, null, 2)
      : "No events found for the specified criteria.";
  }

  switch (format) {
    case "json":
      return JSON.stringify(
        {
          project: projectName,
          generatedAt: new Date().toISOString(),
          eventCount: events.length,
          events: events.map((e) => ({
            date: e.date.slice(0, 10),
            type: e.type,
            description: e.description,
            relatedPages: e.relatedPages,
          })),
        },
        null,
        2
      );

    case "markdown": {
      const lines = [
        `# Project Timeline — ${projectName}`,
        "",
        `_Generated: ${new Date().toISOString()}_`,
        `_Events: ${events.length}_`,
        "",
      ];
      let currentMonth = "";
      for (const event of events) {
        const month = event.date.slice(0, 7);
        if (month !== currentMonth) {
          currentMonth = month;
          lines.push(`\n### ${month}\n`);
        }
        lines.push(formatMarkdownEvent(event));
      }
      return lines.join("\n");
    }

    case "terminal":
    default: {
      const lines: string[] = [];
      let currentDate = "";
      for (const event of events) {
        const eventDate = event.date.slice(0, 10);
        if (eventDate !== currentDate) {
          if (currentDate) lines.push(""); // spacing between date groups
          currentDate = eventDate;
        }
        lines.push(formatTerminalEvent(event));
      }
      return lines.join("\n");
    }
  }
}

export function registerTimelineCommand(program: Command): void {
  program
    .command("timeline")
    .description("Visualize project history from wiki data — what happened when")
    .option("--since <date>", "Start date: YYYY-MM-DD or duration (30d)")
    .option("--limit <n>", "Maximum number of events to show")
    .option("--type <filter>", "Filter: all, decisions, syncs, manual, pages", "all")
    .option("--output <file>", "Write timeline to a file")
    .option("--format <fmt>", "Output format: terminal, markdown, json", "terminal")
    .action(async (options: TimelineOptions) => {
      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          console.error(chalk.red("No .ctx/ directory found. Run 'ctx setup' first."));
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);
        const filter = (options.type ?? "all") as FilterType;
        const format = (options.format ?? "terminal") as OutputFormat;

        // Gather events from all sources
        let events: TimelineEvent[] = [];

        // 1. Wiki log entries
        events.push(...parseLogEntries(ctxDir));

        // 2. Page-derived events (decisions)
        events.push(...getPageEvents(pageManager));

        // 3. Git history for .ctx/ changes
        events.push(...getGitWikiHistory(projectRoot));

        // Deduplicate by date + description (rough dedup)
        const seen = new Set<string>();
        events = events.filter((e) => {
          const key = `${e.date.slice(0, 10)}|${e.description.slice(0, 60)}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Sort chronologically (newest first for terminal, oldest first for markdown)
        events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        // Apply --since filter
        if (options.since) {
          const sinceDate = parseSince(options.since);
          events = events.filter((e) => new Date(e.date).getTime() >= sinceDate.getTime());
        }

        // Apply --type filter
        events = events.filter((e) => matchesFilter(e.type, filter));

        // Apply --limit
        if (options.limit) {
          const limit = parseInt(options.limit, 10);
          events = events.slice(0, limit);
        }

        // For markdown/json, reverse to chronological order
        if (format === "markdown" || format === "json") {
          events.reverse();
        }

        // Build output
        const output = buildTimeline(events, format, config.project);

        if (options.output) {
          const fileContent = format === "terminal"
            ? buildTimeline(events.reverse(), "markdown", config.project)
            : output;
          writeFileSync(options.output, fileContent);
          console.log(chalk.green(`Timeline written to ${chalk.bold(options.output)}`));
        }

        if (format === "terminal") {
          console.log();
          console.log(chalk.bold.white("Project Timeline"));
          console.log(chalk.dim("─".repeat(60)));
          console.log(
            chalk.dim(
              `  ${chalk.green("\u25CF")} automated  ${chalk.yellow("\u25C6")} decision  ${chalk.blue("\u25CB")} manual  ${chalk.magenta("\u2605")} init`
            )
          );
          console.log(chalk.dim("─".repeat(60)));
          console.log();
          console.log(output);
          console.log();
          console.log(chalk.dim(`${events.length} events total — no API cost (local data only)`));
        } else if (!options.output) {
          console.log(output);
        }

        console.log();
      } catch (error) {
        console.error(chalk.red("Timeline generation failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
