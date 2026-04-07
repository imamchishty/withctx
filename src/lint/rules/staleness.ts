import type { WikiPage, LintIssue } from "../../types/page.js";

/**
 * Default staleness threshold: 30 days in milliseconds.
 */
const DEFAULT_STALE_DAYS = 30;

export interface StalenessOptions {
  /** Number of days after which a page is considered stale. */
  staleDays?: number;
  /** Map of source name to last-sync ISO timestamp. */
  sourceFreshness?: Record<string, string>;
}

/**
 * Detects pages that haven't been updated within the configured threshold.
 * Also flags pages whose sources have been refreshed more recently than the page itself.
 */
export function detectStaleness(
  pages: WikiPage[],
  options: StalenessOptions = {}
): LintIssue[] {
  const issues: LintIssue[] = [];
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const thresholdMs = staleDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const sourceFreshness = options.sourceFreshness ?? {};

  for (const page of pages) {
    const updatedAt = new Date(page.updatedAt).getTime();
    const ageMs = now - updatedAt;

    // Check absolute staleness
    if (ageMs > thresholdMs) {
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      issues.push({
        type: "stale",
        severity: ageDays > staleDays * 2 ? "error" : "warning",
        page: page.path,
        message: `Page has not been updated in ${ageDays} days (threshold: ${staleDays} days).`,
        suggestion: `Run \`ctx sync\` or manually review and update this page.`,
      });
      continue;
    }

    // Check if any source has been refreshed more recently than the page
    for (const source of page.sources) {
      const sourceSyncTime = sourceFreshness[source];
      if (!sourceSyncTime) continue;

      const syncAt = new Date(sourceSyncTime).getTime();
      if (syncAt > updatedAt) {
        issues.push({
          type: "stale",
          severity: "warning",
          page: page.path,
          message: `Source "${source}" was synced more recently than this page was updated.`,
          suggestion: `Re-ingest or sync to incorporate the latest source data.`,
        });
      }
    }
  }

  return issues;
}
