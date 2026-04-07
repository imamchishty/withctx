import { Command } from "commander";
import chalk from "chalk";
import { writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { CostTracker } from "../../costs/tracker.js";

interface MetricsOptions {
  json?: boolean;
  watch?: boolean;
  output?: string;
}

interface SyncState {
  sources: Record<string, { lastSyncAt: string; itemCount: number }>;
}

interface PageStats {
  total: number;
  byDirectory: Record<string, number>;
  avgSizeBytes: number;
  current: number;    // < 7 days
  recent: number;     // < 30 days
  stale: number;      // > 30 days
}

interface CoverageStats {
  configuredSources: number;
  documentedSources: number;
  sourceNames: string[];
  documentedNames: string[];
}

interface CrossRefStats {
  totalLinks: number;
  brokenLinks: number;
  orphanPages: number;
  orphanNames: string[];
}

interface SourceStats {
  connected: number;
  lastSync: string | null;
  sourceSummary: Array<{ name: string; type: string; lastSync: string | null; items: number }>;
}

interface CostStats {
  thisMonth: number;
  budget: number | null;
  percentUsed: number | null;
}

interface ActivityStats {
  syncs: number;
  queries: number;
  adds: number;
}

interface MetricsData {
  projectName: string;
  generatedAt: string;
  healthScore: number;
  pages: PageStats;
  coverage: CoverageStats;
  crossRefs: CrossRefStats;
  sources: SourceStats;
  costs: CostStats;
  activity: ActivityStats;
}

// ─── Data Collection ────────────────────────────────────────────────

function collectPageStats(pageManager: PageManager): PageStats {
  const allPages = pageManager.list();
  const now = Date.now();
  const SEVEN_DAYS = 7 * 86_400_000;
  const THIRTY_DAYS = 30 * 86_400_000;

  const byDirectory: Record<string, number> = {};
  let totalSize = 0;
  let current = 0;
  let recent = 0;
  let stale = 0;

  for (const pagePath of allPages) {
    // Directory grouping
    const parts = pagePath.split("/");
    const dir = parts.length > 1 ? parts[0] : "root";
    byDirectory[dir] = (byDirectory[dir] ?? 0) + 1;

    const page = pageManager.read(pagePath);
    if (!page) continue;

    totalSize += Buffer.byteLength(page.content, "utf-8");

    const updatedAt = new Date(page.updatedAt).getTime();
    const age = now - updatedAt;

    if (age < SEVEN_DAYS) current++;
    else if (age < THIRTY_DAYS) recent++;
    else stale++;
  }

  return {
    total: allPages.length,
    byDirectory,
    avgSizeBytes: allPages.length > 0 ? Math.round(totalSize / allPages.length) : 0,
    current,
    recent,
    stale,
  };
}

function collectCoverageStats(config: ReturnType<typeof loadConfig>): CoverageStats {
  const sourceNames: string[] = [];

  const sourceTypes = ["local", "jira", "confluence", "github", "teams"] as const;
  for (const type of sourceTypes) {
    const sources = config.sources?.[type];
    if (sources) {
      for (const s of sources) {
        sourceNames.push(s.name);
      }
    }
  }

  return {
    configuredSources: sourceNames.length,
    documentedSources: sourceNames.length, // We count configured = documented for now
    sourceNames,
    documentedNames: sourceNames,
  };
}

function collectCrossRefStats(pageManager: PageManager): CrossRefStats {
  const allPages = pageManager.list();
  const pageSet = new Set(allPages);
  const linkedPages = new Set<string>();
  let totalLinks = 0;
  let brokenLinks = 0;

  for (const pagePath of allPages) {
    const page = pageManager.read(pagePath);
    if (!page) continue;

    // Find all markdown links to .md files
    const linkPattern = /\[([^\]]*)\]\(([^)]+\.md)\)/g;
    let match;
    while ((match = linkPattern.exec(page.content)) !== null) {
      totalLinks++;
      const target = match[2];
      linkedPages.add(target);

      // Check if the target page exists
      if (!pageSet.has(target)) {
        brokenLinks++;
      }
    }
  }

  // Orphan pages: pages that are not linked to from any other page (excluding index.md and log.md)
  const orphanNames: string[] = [];
  for (const pagePath of allPages) {
    if (pagePath === "index.md" || pagePath === "log.md") continue;
    if (!linkedPages.has(pagePath)) {
      orphanNames.push(pagePath);
    }
  }

  return {
    totalLinks,
    brokenLinks,
    orphanPages: orphanNames.length,
    orphanNames,
  };
}

function collectSourceStats(config: ReturnType<typeof loadConfig>, ctxDir: CtxDirectory): SourceStats {
  const statePath = join(ctxDir.path, "sync-state.json");
  let syncState: SyncState | null = null;
  if (existsSync(statePath)) {
    syncState = JSON.parse(readFileSync(statePath, "utf-8")) as SyncState;
  }

  const sourceSummary: Array<{ name: string; type: string; lastSync: string | null; items: number }> = [];
  const sourceTypes = ["local", "jira", "confluence", "github", "teams"] as const;

  for (const type of sourceTypes) {
    const sources = config.sources?.[type];
    if (sources) {
      for (const s of sources) {
        const state = syncState?.sources[s.name];
        sourceSummary.push({
          name: s.name,
          type,
          lastSync: state?.lastSyncAt ?? null,
          items: state?.itemCount ?? 0,
        });
      }
    }
  }

  // Find the most recent sync across all sources
  let lastSync: string | null = null;
  if (syncState) {
    for (const state of Object.values(syncState.sources)) {
      if (!lastSync || new Date(state.lastSyncAt) > new Date(lastSync)) {
        lastSync = state.lastSyncAt;
      }
    }
  }

  return {
    connected: sourceSummary.length,
    lastSync,
    sourceSummary,
  };
}

function collectCostStats(ctxDir: CtxDirectory, config: ReturnType<typeof loadConfig>): CostStats {
  const budget = config.costs?.budget ?? null;

  try {
    const costTracker = new CostTracker(ctxDir, { budget: budget ?? undefined });
    const thisMonth = costTracker.getCurrentMonthCost();
    const percentUsed = budget ? (thisMonth / budget) * 100 : null;

    return { thisMonth, budget, percentUsed };
  } catch {
    return { thisMonth: 0, budget, percentUsed: null };
  }
}

function collectActivityStats(ctxDir: CtxDirectory): ActivityStats {
  const logContent = ctxDir.readPage("log.md");
  if (!logContent) return { syncs: 0, queries: 0, adds: 0 };

  const sevenDaysAgo = Date.now() - 7 * 86_400_000;
  let syncs = 0;
  let queries = 0;
  let adds = 0;

  for (const line of logContent.split("\n")) {
    const match = line.match(/^\|\s*(\d{4}-\d{2}-\d{2}T[^|]*)\s*\|\s*([^|]+)\s*\|/);
    if (!match) continue;

    const timestamp = new Date(match[1].trim()).getTime();
    if (isNaN(timestamp) || timestamp < sevenDaysAgo) continue;

    const action = match[2].trim().toLowerCase();
    if (action === "sync" || action === "ingest") syncs++;
    else if (action === "query") queries++;
    else if (action === "add" || action === "manual") adds++;
  }

  return { syncs, queries, adds };
}

// ─── Health Score ───────────────────────────────────────────────────

function calculateHealthScore(
  pages: PageStats,
  crossRefs: CrossRefStats,
  sources: SourceStats,
  coverage: CoverageStats
): number {
  let score = 0;

  // Freshness: 30 pts
  if (pages.total > 0) {
    const freshRatio = (pages.current + pages.recent * 0.5) / pages.total;
    score += Math.round(freshRatio * 30);
  }

  // Coverage: 25 pts
  if (coverage.configuredSources > 0) {
    const coverageRatio = coverage.documentedSources / coverage.configuredSources;
    score += Math.round(coverageRatio * 25);
  } else {
    score += 25; // No sources configured = no coverage issues
  }

  // Cross-refs: 20 pts
  if (pages.total > 0) {
    const noBrokenLinks = crossRefs.brokenLinks === 0 ? 10 : Math.max(0, 10 - crossRefs.brokenLinks * 2);
    const lowOrphans = crossRefs.orphanPages <= 1 ? 10 : Math.max(0, 10 - (crossRefs.orphanPages - 1) * 2);
    score += noBrokenLinks + lowOrphans;
  }

  // Source connectivity: 15 pts
  if (sources.connected > 0) {
    score += 10;
    // Bonus for recent sync
    if (sources.lastSync) {
      const syncAge = Date.now() - new Date(sources.lastSync).getTime();
      if (syncAge < 7 * 86_400_000) score += 5;
    }
  } else if (coverage.configuredSources === 0) {
    score += 15; // No sources to connect
  }

  // Lint: 10 pts (no broken links = clean)
  if (crossRefs.brokenLinks === 0) {
    score += 10;
  } else {
    score += Math.max(0, 10 - crossRefs.brokenLinks * 3);
  }

  return Math.min(100, Math.max(0, score));
}

// ─── Display ────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function buildProgressBar(percent: number, width: number = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
  return bar;
}

function renderDashboard(data: MetricsData): string {
  const W = 50;
  const hr = "\u2500".repeat(W - 2);
  const top = `\u250C${"─".repeat(W - 2)}\u2510`;
  const bot = `\u2514${"─".repeat(W - 2)}\u2518`;
  const sep = `\u251C${hr}\u2524`;

  function pad(text: string, len: number = W - 4): string {
    // Strip ANSI for length calculation
    const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
    const padding = Math.max(0, len - stripped.length);
    return text + " ".repeat(padding);
  }

  function row(text: string): string {
    return `\u2502  ${pad(text)}  \u2502`;
  }

  function emptyRow(): string {
    return `\u2502${" ".repeat(W - 2)}\u2502`;
  }

  const lines: string[] = [];
  lines.push(top);

  // Title
  const title = chalk.bold(`withctx metrics \u2014 ${data.projectName}`);
  lines.push(row(title));
  lines.push(sep);
  lines.push(emptyRow());

  // Health score
  const scoreColor = data.healthScore >= 80 ? chalk.green : data.healthScore >= 50 ? chalk.yellow : chalk.red;
  lines.push(row(`Wiki Health Score: ${scoreColor.bold(`${data.healthScore}/100`)}`));
  lines.push(emptyRow());

  // Pages
  lines.push(row(chalk.bold("Pages:") + `        ${data.pages.total} total`));
  lines.push(row(`  current:    ${data.pages.current} (< 7 days old)`));
  lines.push(row(`  recent:     ${data.pages.recent} (< 30 days)`));
  const staleWarning = data.pages.stale > 0 ? chalk.yellow(" !!") : "";
  lines.push(row(`  stale:      ${data.pages.stale} (> 30 days)${staleWarning}`));
  lines.push(emptyRow());

  // Coverage
  lines.push(row(chalk.bold("Coverage:")));
  lines.push(row(`  sources:    ${data.coverage.documentedSources}/${data.coverage.configuredSources} documented`));
  lines.push(emptyRow());

  // Cross-refs
  lines.push(row(chalk.bold("Cross-References:")));
  const brokenStatus = data.crossRefs.brokenLinks === 0
    ? chalk.green("0 broken [ok]")
    : chalk.red(`${data.crossRefs.brokenLinks} broken`);
  lines.push(row(`  links:      ${data.crossRefs.totalLinks} total, ${brokenStatus}`));
  lines.push(row(`  orphans:    ${data.crossRefs.orphanPages} page(s)`));
  lines.push(emptyRow());

  // Sources
  lines.push(row(`${chalk.bold("Sources:")}      ${data.sources.connected} connected`));
  if (data.sources.lastSync) {
    lines.push(row(`  last sync:  ${formatRelativeTime(data.sources.lastSync)}`));
  } else {
    lines.push(row(`  last sync:  ${chalk.yellow("never")}`));
  }
  lines.push(emptyRow());

  // Costs
  lines.push(row(chalk.bold("Costs:")));
  if (data.costs.budget) {
    const pct = data.costs.percentUsed ?? 0;
    const costColor = pct > 80 ? chalk.red : pct > 50 ? chalk.yellow : chalk.green;
    lines.push(row(`  this month: ${costColor(`$${data.costs.thisMonth.toFixed(2)} / $${data.costs.budget.toFixed(2)} budget`)}`));
    lines.push(row(`  ${costColor(buildProgressBar(pct))} ${costColor(`${Math.round(pct)}%`)}`));
  } else {
    lines.push(row(`  this month: $${data.costs.thisMonth.toFixed(2)} (no budget set)`));
  }
  lines.push(emptyRow());

  // Activity
  lines.push(row(chalk.bold("Activity (last 7 days):")));
  lines.push(row(`  syncs: ${data.activity.syncs}  queries: ${data.activity.queries}  adds: ${data.activity.adds}`));
  lines.push(emptyRow());

  lines.push(bot);

  return lines.join("\n");
}

// ─── Command Registration ───────────────────────────────────────────

export function registerMetricsCommand(program: Command): void {
  program
    .command("metrics")
    .description("Wiki health dashboard — page stats, freshness, coverage, costs")
    .option("--json", "Machine-readable JSON output")
    .option("--watch", "Refresh dashboard every 30 seconds")
    .option("--output <file>", "Write metrics to a file")
    .action(async (options: MetricsOptions) => {
      try {
        const renderOnce = (): MetricsData => {
          const config = loadConfig();
          const projectRoot = getProjectRoot();
          const ctxDir = new CtxDirectory(projectRoot);

          if (!ctxDir.exists()) {
            console.error(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
            process.exit(1);
          }

          const pageManager = new PageManager(ctxDir);

          const pages = collectPageStats(pageManager);
          const coverage = collectCoverageStats(config);
          const crossRefs = collectCrossRefStats(pageManager);
          const sources = collectSourceStats(config, ctxDir);
          const costs = collectCostStats(ctxDir, config);
          const activity = collectActivityStats(ctxDir);

          const healthScore = calculateHealthScore(pages, crossRefs, sources, coverage);

          return {
            projectName: config.project,
            generatedAt: new Date().toISOString(),
            healthScore,
            pages,
            coverage,
            crossRefs,
            sources,
            costs,
            activity,
          };
        };

        if (options.json) {
          const data = renderOnce();
          const output = JSON.stringify(data, null, 2);
          if (options.output) {
            writeFileSync(options.output, output);
            console.log(chalk.green(`Metrics written to ${chalk.bold(options.output)}`));
          } else {
            console.log(output);
          }
          return;
        }

        if (options.watch) {
          const render = (): void => {
            // Clear terminal
            process.stdout.write("\x1b[2J\x1b[H");
            const data = renderOnce();
            console.log(renderDashboard(data));
            console.log();
            console.log(chalk.dim("Refreshing every 30s — press Ctrl+C to stop"));
            console.log(chalk.dim(`No API cost — local data only`));
          };

          render();
          setInterval(render, 30_000);
          return;
        }

        // Default: single render
        const data = renderOnce();

        if (options.output) {
          writeFileSync(options.output, JSON.stringify(data, null, 2));
          console.log(chalk.green(`Metrics written to ${chalk.bold(options.output)}`));
        }

        console.log();
        console.log(renderDashboard(data));
        console.log();
        console.log(chalk.dim("No API cost — local data only"));
        console.log();
      } catch (error) {
        console.error(chalk.red("Metrics collection failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
