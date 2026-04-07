import type { WikiPage, LintIssue } from "../../types/page.js";

/**
 * Detects links to .md files that don't exist in the wiki.
 */
export function detectMissing(pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];

  // Build a set of all known page paths
  const knownPages = new Set(pages.map((p) => p.path));

  // Also build a set of basenames for fuzzy matching
  const knownBasenames = new Map<string, string>();
  for (const p of pages) {
    const basename = p.path.split("/").pop() ?? p.path;
    knownBasenames.set(basename, p.path);
  }

  for (const page of pages) {
    for (const ref of page.references) {
      const normalized = normalizeRef(ref);

      if (knownPages.has(normalized)) continue;

      // Try basename match for relative paths
      const basename = normalized.split("/").pop() ?? normalized;
      if (knownPages.has(basename)) continue;

      // Check if the ref points to an external URL (not a wiki link)
      if (ref.startsWith("http://") || ref.startsWith("https://")) continue;

      // It's a missing page
      const suggestion = findClosestMatch(normalized, knownPages);
      issues.push({
        type: "missing",
        severity: "error",
        page: page.path,
        message: `Link to "${ref}" points to a non-existent page.`,
        relatedPage: ref,
        suggestion: suggestion
          ? `Did you mean "${suggestion}"?`
          : `Create the page or fix the link.`,
      });
    }
  }

  return issues;
}

function normalizeRef(ref: string): string {
  let normalized = ref;
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/**
 * Simple Levenshtein-based closest match finder.
 */
function findClosestMatch(
  target: string,
  candidates: Set<string>
): string | null {
  let bestMatch: string | null = null;
  let bestDistance = Infinity;
  const maxDistance = 3; // Only suggest if close enough

  for (const candidate of candidates) {
    const distance = levenshtein(target, candidate);
    if (distance < bestDistance && distance <= maxDistance) {
      bestDistance = distance;
      bestMatch = candidate;
    }
  }

  return bestMatch;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}
