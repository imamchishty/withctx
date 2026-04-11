import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { processMarkdown, type DocType } from "../../connectors/markdown-processor.js";
import { visualWidth } from "../utils/ui.js";
import { readBlessState, hasDriftedSinceBless } from "../../wiki/bless.js";

// ── Box-drawing helpers ───────────────────────────────────────────────
// Thin wrappers that delegate width measurement to the shared ui.ts
// library. We keep a local box layout because this command uses inline
// divider rows (teeLeft/teeRight) which the generic ui.box helper does
// not support; the goal here is to share the primitives, not rewrite
// the multi-section dashboard.

const BOX = {
  topLeft: "\u250C",
  topRight: "\u2510",
  bottomLeft: "\u2514",
  bottomRight: "\u2518",
  horizontal: "\u2500",
  vertical: "\u2502",
  teeLeft: "\u251C",
  teeRight: "\u2524",
};

function boxTop(width: number): string {
  return BOX.topLeft + BOX.horizontal.repeat(width) + BOX.topRight;
}

function boxBottom(width: number): string {
  return BOX.bottomLeft + BOX.horizontal.repeat(width) + BOX.bottomRight;
}

function boxDivider(width: number): string {
  return BOX.teeLeft + BOX.horizontal.repeat(width) + BOX.teeRight;
}

function boxLine(content: string, width: number): string {
  const visible = visualWidth(content);
  const padding = Math.max(0, width - visible);
  return BOX.vertical + " " + content + " ".repeat(padding) + " " + BOX.vertical;
}

// ── Progress bar helper ───────────────────────────────────────────────

function progressBar(filled: number, total: number, width: number = 16): string {
  if (total === 0) return "\u2591".repeat(width);
  const ratio = Math.min(filled / total, 1);
  const filledCount = Math.round(ratio * width);
  return "\u2588".repeat(filledCount) + "\u2591".repeat(width - filledCount);
}

// ── Freshness scoring (inline to avoid dependency on RawDocument) ─────

type FreshnessCategory = "fresh" | "aging" | "stale" | "unknown";

function categorizeFreshness(updatedAt: string): FreshnessCategory {
  const date = new Date(updatedAt);
  if (isNaN(date.getTime())) return "unknown";
  const diffMs = Date.now() - date.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 7) return "fresh";
  if (days <= 30) return "aging";
  return "stale";
}

// ── Relative time formatting ──────────────────────────────────────────

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
  return `${diffDays}d ago`;
}

// ── Sync state loading ────────────────────────────────────────────────

interface SyncState {
  sources: Record<string, { lastSyncAt: string; itemCount: number }>;
}

function loadSyncState(ctxDir: CtxDirectory): SyncState | null {
  const statePath = join(ctxDir.path, "sync-state.json");
  if (existsSync(statePath)) {
    return JSON.parse(readFileSync(statePath, "utf-8")) as SyncState;
  }
  return null;
}

// ── Known doc types for coverage analysis ─────────────────────────────

const ALL_DOC_TYPES: DocType[] = [
  "architecture",
  "deployment",
  "api",
  "database",
  "onboarding",
  "testing",
  "security",
  "incident",
  "dependencies",
  "roadmap",
  "changelog",
  "persona",
  "repo-structure",
  "feature-flags",
];

// ── JSON output structure ─────────────────────────────────────────────

interface StatusJson {
  pages: number;
  words: number;
  sources: number;
  lastSync: string | null;
  freshness: {
    fresh: number;
    aging: number;
    stale: number;
    unknown: number;
  };
  /**
   * Human-review signal. `blessed` is the count of pages with a
   * blessed_at stamp; `ratio` is `blessed / contentPages` (index/log
   * excluded). `drifted` is pages blessed at an old git sha whose
   * tree has since changed — same drift detection `ctx lint` uses.
   */
  bless: {
    blessed: number;
    unblessed: number;
    drifted: number;
    ratio: number;
    contentPages: number;
  };
  /**
   * Claim-tier distribution across content pages. Unmarked pages
   * fall into `unknown`. Tiers come from the ctx front-matter
   * `tier:` field, auto-promoted by ctx approve / ctx verify.
   */
  tiers: {
    verified: number;
    asserted: number;
    manual: number;
    historical: number;
    unknown: number;
  };
  /**
   * Assertion check totals across all content pages. `pages` counts
   * how many pages carry a `ctx.verified` block at all; `passed` and
   * `failed` are the summed per-page counters from the last `ctx
   * verify` run. `lastRunAt` is the most recent timestamp seen.
   */
  assertions: {
    pages: number;
    passed: number;
    failed: number;
    lastRunAt: string | null;
  };
  coverage: Record<string, number>;
  gaps: string[];
}

// ── Command registration ──────────────────────────────────────────────

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Wiki health dashboard — pages, freshness, coverage gaps, and sources")
    .option("--format <format>", "Output format: dashboard (default) or json", "dashboard")
    .option("--json", "Shortcut for --format json (machine-readable output)")
    .action(async (opts: { format: string; json?: boolean }) => {
      // `--json` is the idiom users expect; treat it as sugar for
      // `--format json` so both work interchangeably.
      if (opts.json) opts.format = "json";
      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          console.error(chalk.red("No .ctx/ directory found. Run 'ctx setup' first."));
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);
        const allPages = pageManager.list();
        const syncState = loadSyncState(ctxDir);

        // ── Gather metrics ──────────────────────────────────────────

        let totalWords = 0;
        const freshness: Record<FreshnessCategory, number> = {
          fresh: 0,
          aging: 0,
          stale: 0,
          unknown: 0,
        };
        // Bless tallies — computed alongside freshness so we walk the
        // page list once rather than twice. `contentPages` excludes
        // index.md / log.md / glossary.md because those are
        // auto-generated catalogues, not things a human reviews.
        let blessContentPages = 0;
        let blessed = 0;
        let drifted = 0;
        const tiers = {
          verified: 0,
          asserted: 0,
          manual: 0,
          historical: 0,
          unknown: 0,
        };
        // Assertion tallies — read from page.meta.verified. A page
        // only contributes to `assertionsPages` when it has a
        // `verified` block at all (i.e. `ctx verify` ran on it at
        // least once). Pages with zero assertions get a block with
        // passed=0, failed=0 and ARE counted here so users can see
        // "10 pages, 0 assertions" rather than silently undercount.
        let assertionsPages = 0;
        let assertionsPassed = 0;
        let assertionsFailed = 0;
        let assertionsLastRunAt: string | null = null;
        const coverageMap: Record<string, number> = {};

        // Initialize coverage map with all known doc types
        for (const dt of ALL_DOC_TYPES) {
          coverageMap[dt] = 0;
        }

        for (const pagePath of allPages) {
          const page = pageManager.read(pagePath);
          if (!page) continue;

          // Word count
          const words = page.content
            .replace(/[#|_`*\->\[\](){}]/g, " ")
            .split(/\s+/)
            .filter(Boolean).length;
          totalWords += words;

          // Freshness
          const cat = categorizeFreshness(page.updatedAt);
          freshness[cat]++;

          // Doc type coverage
          const processed = processMarkdown(pagePath, page.content, ctxDir.contextPath);
          const docType = processed.metadata.docType;
          if (docType !== "general") {
            coverageMap[docType] = (coverageMap[docType] ?? 0) + 1;
          }

          // Bless stats + tier tallies — skip auto-generated
          // catalogue pages. The bless state and tier are both read
          // from the same page metadata block, so we bucket them
          // together to avoid re-parsing.
          const base = pagePath.split("/").pop() ?? pagePath;
          if (base !== "index.md" && base !== "log.md" && base !== "glossary.md") {
            blessContentPages++;
            const raw = pageManager.readRaw(pagePath);
            if (raw) {
              const state = readBlessState(raw);
              if (state.status === "blessed") {
                blessed++;
                if (hasDriftedSinceBless(state, { cwd: projectRoot })) {
                  drifted++;
                }
              }
            }
            // Tier tally — uses the already-parsed meta on the page.
            const tier = page.meta?.tier;
            if (tier === "verified") tiers.verified++;
            else if (tier === "asserted") tiers.asserted++;
            else if (tier === "manual") tiers.manual++;
            else if (tier === "historical") tiers.historical++;
            else tiers.unknown++;

            // Assertion tally — only pages that have actually been
            // through `ctx verify` carry a `verified` block. We
            // sum the per-page counts and track the most recent
            // run timestamp so the dashboard can say "verified 2h
            // ago" without a second parse.
            const v = page.meta?.verified;
            if (v) {
              assertionsPages++;
              assertionsPassed += v.passed;
              assertionsFailed += v.failed;
              if (v.last_run_at) {
                if (!assertionsLastRunAt || v.last_run_at > assertionsLastRunAt) {
                  assertionsLastRunAt = v.last_run_at;
                }
              }
            }
          }
        }

        // Sources
        const sourcesList: Array<{ name: string; type: string }> = [];
        if (config.sources) {
          const sourceKeys = Object.keys(config.sources) as Array<keyof typeof config.sources>;
          for (const key of sourceKeys) {
            const arr = config.sources[key];
            if (Array.isArray(arr)) {
              for (const s of arr) {
                if (typeof s === "object" && s !== null && "name" in s) {
                  sourcesList.push({ name: (s as { name: string }).name, type: key });
                }
              }
            }
          }
        }

        // Last sync
        let lastSyncTime: string | null = null;
        if (syncState) {
          for (const state of Object.values(syncState.sources)) {
            if (!lastSyncTime || new Date(state.lastSyncAt) > new Date(lastSyncTime)) {
              lastSyncTime = state.lastSyncAt;
            }
          }
        }

        // Coverage gaps
        const gaps = ALL_DOC_TYPES.filter((dt) => (coverageMap[dt] ?? 0) === 0);

        // ── JSON output ─────────────────────────────────────────────

        if (opts.format === "json") {
          const output: StatusJson = {
            pages: allPages.length,
            words: totalWords,
            sources: sourcesList.length,
            lastSync: lastSyncTime,
            freshness,
            bless: {
              blessed,
              unblessed: Math.max(0, blessContentPages - blessed),
              drifted,
              ratio:
                blessContentPages === 0
                  ? 0
                  : Math.round((blessed / blessContentPages) * 100) / 100,
              contentPages: blessContentPages,
            },
            tiers,
            assertions: {
              pages: assertionsPages,
              passed: assertionsPassed,
              failed: assertionsFailed,
              lastRunAt: assertionsLastRunAt,
            },
            coverage: coverageMap,
            gaps,
          };
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        // ── Dashboard output ────────────────────────────────────────

        const W = 50; // inner width (between box borders)

        console.log();
        console.log("  " + boxTop(W));

        // Title
        console.log("  " + boxLine(chalk.bold.cyan("withctx Wiki Status"), W));

        // Summary
        console.log("  " + boxDivider(W));
        const pagesStr = `Pages: ${chalk.bold(String(allPages.length))}`;
        const wordsStr = `Words: ${chalk.bold(totalWords.toLocaleString())}`;
        console.log("  " + boxLine(`${pagesStr}        ${wordsStr}`, W));

        const sourcesStr = `Sources: ${chalk.bold(String(sourcesList.length))}`;
        const syncStr = lastSyncTime
          ? `Last sync: ${chalk.green(formatRelativeTime(lastSyncTime))}`
          : `Last sync: ${chalk.yellow("never")}`;
        console.log("  " + boxLine(`${sourcesStr}     ${syncStr}`, W));

        // Freshness
        console.log("  " + boxDivider(W));
        console.log("  " + boxLine(chalk.bold("Freshness"), W));

        const totalPages = allPages.length || 1;
        const freshPct = Math.round((freshness.fresh / totalPages) * 100);
        const agingPct = Math.round((freshness.aging / totalPages) * 100);
        const stalePct = Math.round((freshness.stale / totalPages) * 100);

        console.log(
          "  " +
            boxLine(
              `${chalk.green(progressBar(freshness.fresh, totalPages))}  Fresh: ${freshness.fresh} (${freshPct}%)`,
              W
            )
        );
        console.log(
          "  " +
            boxLine(
              `${chalk.yellow(progressBar(freshness.aging, totalPages))}  Aging: ${freshness.aging} (${agingPct}%)`,
              W
            )
        );
        console.log(
          "  " +
            boxLine(
              `${chalk.red(progressBar(freshness.stale, totalPages))}  Stale: ${freshness.stale} (${stalePct}%)`,
              W
            )
        );
        if (freshness.unknown > 0) {
          const unknownPct = Math.round((freshness.unknown / totalPages) * 100);
          console.log(
            "  " +
              boxLine(
                `${chalk.dim(progressBar(freshness.unknown, totalPages))}  Unknown: ${freshness.unknown} (${unknownPct}%)`,
                W
              )
          );
        }

        // Approvals — only render when there are content pages to
        // measure. Skips the block entirely on freshly-scaffolded
        // wikis (would be misleading to report "0% approved" on a
        // 0-page wiki).
        if (blessContentPages > 0) {
          console.log("  " + boxDivider(W));
          console.log("  " + boxLine(chalk.bold("Approvals (human review)"), W));

          const ratio = blessed / blessContentPages;
          const ratioPct = Math.round(ratio * 100);
          // Pick a colour based on coverage threshold — a wiki with
          // <25% approved isn't yet trusted, 25–75% is a work in
          // progress, >75% is healthy.
          const colourForRatio = (p: number): (s: string) => string =>
            p >= 75 ? chalk.green : p >= 25 ? chalk.yellow : chalk.red;
          const colour = colourForRatio(ratioPct);

          console.log(
            "  " +
              boxLine(
                `${colour(progressBar(blessed, blessContentPages))}  Approved: ${blessed}/${blessContentPages} (${ratioPct}%)`,
                W
              )
          );
          if (drifted > 0) {
            console.log(
              "  " +
                boxLine(
                  chalk.yellow(
                    `${drifted} page${drifted === 1 ? "" : "s"} drifted since last approval`
                  ),
                  W
                )
            );
          }
          if (ratioPct < 25) {
            console.log(
              "  " +
                boxLine(
                  chalk.dim("Tip: run `ctx approve <page>` after reviewing a page"),
                  W
                )
            );
          }
        }

        // Trust tiers — only shown when at least one page carries a
        // non-unknown tier. On a freshly-compiled wiki every page is
        // untiered and this section would be empty noise.
        const totalTiered =
          tiers.verified + tiers.asserted + tiers.manual + tiers.historical;
        if (totalTiered > 0 && blessContentPages > 0) {
          console.log("  " + boxDivider(W));
          console.log("  " + boxLine(chalk.bold("Trust tiers"), W));

          const formatTierLine = (
            label: string,
            count: number,
            colour: (s: string) => string
          ) => {
            if (count === 0) return null;
            const pct = Math.round((count / blessContentPages) * 100);
            return (
              "  " +
              boxLine(
                `${colour(progressBar(count, blessContentPages))}  ${label}: ${count} (${pct}%)`,
                W
              )
            );
          };

          const lines = [
            formatTierLine("Verified ", tiers.verified, chalk.green),
            formatTierLine("Asserted ", tiers.asserted, chalk.cyan),
            formatTierLine("Manual   ", tiers.manual, chalk.yellow),
            formatTierLine("Historic ", tiers.historical, chalk.dim),
          ].filter((l): l is string => l !== null);
          for (const line of lines) console.log(line);
        }

        // Assertions — the machine-verified trust signal. Only shown
        // when at least one page carries a `verified` block (i.e.
        // `ctx verify` has run at least once). If nothing has been
        // verified yet we stay silent rather than showing an empty
        // 0/0 line — a quiet dashboard is better than a noisy one.
        if (assertionsPages > 0) {
          console.log("  " + boxDivider(W));
          console.log("  " + boxLine(chalk.bold("Assertions"), W));

          const total = assertionsPassed + assertionsFailed;
          const ratio = total === 0 ? 1 : assertionsPassed / total;
          const ratioPct = Math.round(ratio * 100);
          // Colour policy: all-green when every assertion passes on
          // at least one page; yellow when there's at least one
          // failure but the majority pass; red when most assertions
          // fail. Matches the Bless block's three-stop palette.
          const colour =
            assertionsFailed === 0
              ? chalk.green
              : ratioPct >= 50
                ? chalk.yellow
                : chalk.red;

          console.log(
            "  " +
              boxLine(
                `${colour(progressBar(assertionsPassed, Math.max(1, total)))}  ${assertionsPassed}/${total} passed (${ratioPct}%)`,
                W
              )
          );

          const secondLineParts: string[] = [];
          secondLineParts.push(
            chalk.dim(
              `${assertionsPages} page${assertionsPages === 1 ? "" : "s"} verified`
            )
          );
          if (assertionsLastRunAt) {
            secondLineParts.push(
              chalk.dim(`last run ${formatRelativeTime(assertionsLastRunAt)}`)
            );
          }
          console.log("  " + boxLine(secondLineParts.join("  "), W));

          if (assertionsFailed > 0) {
            console.log(
              "  " +
                boxLine(
                  chalk.red(
                    `${assertionsFailed} assertion${assertionsFailed === 1 ? "" : "s"} failing — run \`ctx verify\` for details`
                  ),
                  W
                )
            );
          } else if (assertionsPages < blessContentPages) {
            const remaining = blessContentPages - assertionsPages;
            console.log(
              "  " +
                boxLine(
                  chalk.dim(
                    `Tip: ${remaining} page${remaining === 1 ? " has" : "s have"} no assertions yet — add a \`ctx-assert\` block`
                  ),
                  W
                )
            );
          }
        }

        // Coverage
        console.log("  " + boxDivider(W));
        console.log("  " + boxLine(chalk.bold("Coverage"), W));

        // Display doc types in two-column layout
        const docTypes = ALL_DOC_TYPES.slice();
        for (let i = 0; i < docTypes.length; i += 2) {
          const left = docTypes[i];
          const right = docTypes[i + 1];

          const leftCount = coverageMap[left] ?? 0;
          const leftIcon = leftCount > 0 ? chalk.green("\u2705") : chalk.red("\u274C");
          const leftStr = `${leftIcon} ${left} (${leftCount})`;

          let line = leftStr.padEnd(28);
          if (right) {
            const rightCount = coverageMap[right] ?? 0;
            const rightIcon = rightCount > 0 ? chalk.green("\u2705") : chalk.red("\u274C");
            line += `${rightIcon} ${right} (${rightCount})`;
          }

          // Need to pad using stripped length because of ANSI codes in emoji
          console.log("  " + boxLine(line, W));
        }

        // Gaps warning
        if (gaps.length > 0) {
          console.log("  " + boxDivider(W));
          const gapList = gaps.join(", ");
          console.log(
            "  " +
              boxLine(
                chalk.yellow(`Missing: ${gapList}`),
                W
              )
          );
          console.log(
            "  " +
              boxLine(
                chalk.dim("Consider adding docs for these areas"),
                W
              )
          );
        }

        console.log("  " + boxBottom(W));
        console.log();
      } catch (error) {
        console.error(chalk.red("Status check failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
