import type { WikiPage, LintReport, LintIssue } from "../types/page.js";
import type { LLMProvider } from "../llm/types.js";
import { PageManager } from "../wiki/pages.js";
import { detectContradictions } from "./rules/contradictions.js";
import { detectStaleness, type StalenessOptions } from "./rules/staleness.js";
import { detectOrphans } from "./rules/orphans.js";
import { detectMissing } from "./rules/missing.js";

export type LintRuleName = "contradictions" | "stale" | "orphan" | "missing";

export interface LintOptions {
  /** Run only these rules. If omitted, all rules run. */
  rules?: LintRuleName[];
  /** Staleness configuration. */
  staleness?: StalenessOptions;
  /** LLM provider — required for contradiction detection. */
  claude?: LLMProvider;
}

/**
 * Main linter orchestrator.
 * Runs lint rules against all wiki pages and produces a LintReport.
 */
export async function runLint(
  pageManager: PageManager,
  options: LintOptions = {}
): Promise<LintReport> {
  const activeRules = options.rules ?? [
    "contradictions",
    "stale",
    "orphan",
    "missing",
  ];

  // Load all pages
  const pagePaths = pageManager.list();
  const pages: WikiPage[] = [];

  for (const path of pagePaths) {
    const page = pageManager.read(path);
    if (page) pages.push(page);
  }

  const allIssues: LintIssue[] = [];

  // Run each enabled rule
  if (activeRules.includes("contradictions") && options.claude) {
    const contradictions = await detectContradictions(pages, options.claude);
    allIssues.push(...contradictions);
  }

  if (activeRules.includes("stale")) {
    const stale = detectStaleness(pages, options.staleness);
    allIssues.push(...stale);
  }

  if (activeRules.includes("orphan")) {
    const orphans = detectOrphans(pages);
    allIssues.push(...orphans);
  }

  if (activeRules.includes("missing")) {
    const missing = detectMissing(pages);
    allIssues.push(...missing);
  }

  const report: LintReport = {
    timestamp: new Date().toISOString(),
    pagesChecked: pages.length,
    issues: allIssues,
    summary: {
      contradictions: allIssues.filter((i) => i.type === "contradiction")
        .length,
      stale: allIssues.filter((i) => i.type === "stale").length,
      orphans: allIssues.filter((i) => i.type === "orphan").length,
      missing: allIssues.filter((i) => i.type === "missing").length,
      blessDrift: allIssues.filter((i) => i.type === "bless-drift").length,
    },
  };

  return report;
}
