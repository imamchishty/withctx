import type { WikiPage, LintIssue } from "../../types/page.js";

/**
 * Pages that are always allowed to have zero incoming references.
 */
const EXEMPT_PAGES = new Set(["index.md", "log.md"]);

/**
 * Detects orphan pages — pages with zero incoming references from other pages.
 */
export function detectOrphans(pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];

  // Build a set of all incoming references for each page
  const incomingRefs = new Map<string, Set<string>>();

  // Initialize all pages with empty sets
  for (const page of pages) {
    incomingRefs.set(page.path, new Set());
  }

  // Populate incoming references
  for (const page of pages) {
    for (const ref of page.references) {
      const normalized = normalizeRef(ref);
      const existing = incomingRefs.get(normalized);
      if (existing) {
        existing.add(page.path);
      }
    }
  }

  // Flag pages with zero incoming references
  for (const page of pages) {
    if (EXEMPT_PAGES.has(page.path)) continue;

    const refs = incomingRefs.get(page.path);
    if (!refs || refs.size === 0) {
      issues.push({
        type: "orphan",
        severity: "warning",
        page: page.path,
        message: `Page has no incoming references from other pages.`,
        suggestion: `Add a link to this page from index.md or a related page, or remove it if it is no longer needed.`,
      });
    }
  }

  return issues;
}

/**
 * Normalize a reference path — strip leading ./ and ensure consistent format.
 */
function normalizeRef(ref: string): string {
  let normalized = ref;
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  // Handle relative paths that go up directories
  if (normalized.startsWith("../")) {
    // For simplicity, take the last segment
    const parts = normalized.split("/");
    normalized = parts[parts.length - 1];
  }
  return normalized;
}
