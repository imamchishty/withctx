import type { WikiPage } from "../../types/page.js";
import type { RawDocument } from "../../types/source.js";

/**
 * Format a prompt to check for contradictions across wiki pages.
 * Used during lint to find conflicting information.
 */
export function formatContradictionCheckPrompt(pages: WikiPage[]): string {
  if (pages.length === 0) {
    return "No pages provided to check for contradictions.";
  }

  const pageContents = pages.map(
    (p) => `--- ${p.path} (updated: ${p.updatedAt}) ---\n${p.content}`
  );

  return `Analyze the following ${pages.length} wiki pages for contradictions and inconsistencies.

Look for:
1. **Direct contradictions** — Two pages state opposite things (e.g., one says a service uses PostgreSQL, another says MySQL).
2. **Version mismatches** — Different pages reference different versions of the same dependency.
3. **Naming inconsistencies** — The same entity referred to by different names across pages.
4. **Architectural conflicts** — Conflicting descriptions of data flow, ownership, or responsibility.
5. **Stale cross-references** — Links or references to pages/sections that describe something differently.

For each issue found, output a JSON object on its own line with this structure:
{"type": "contradiction", "page1": "<path>", "page2": "<path>", "description": "<what conflicts>", "severity": "warning|error"}

If no contradictions are found, output:
{"type": "none", "message": "No contradictions found across ${pages.length} pages."}

--- Pages ---
${pageContents.join("\n\n")}`;
}

/**
 * Format a prompt to check if a wiki page is stale relative to its sources.
 * Used during lint to find outdated content.
 */
export function formatStalenessCheckPrompt(
  page: WikiPage,
  sources: RawDocument[]
): string {
  if (sources.length === 0) {
    return `No source documents provided to compare against page: ${page.path}`;
  }

  const sourceSummaries = sources.map((s) => {
    const preview =
      s.content.length > 3000
        ? s.content.slice(0, 3000) + "\n... (truncated)"
        : s.content;
    return `--- Source: ${s.title} (${s.sourceName}, updated: ${s.updatedAt ?? "unknown"}) ---\n${preview}`;
  });

  return `Compare the following wiki page against its source documents to determine if the page is stale or outdated.

Check for:
1. **Missing information** — Source documents contain details not reflected in the wiki page.
2. **Changed details** — API endpoints, config values, dependency versions, or architecture that has changed.
3. **Removed features** — The wiki page describes something no longer present in the sources.
4. **New additions** — Source material covers topics the wiki page does not mention.

For each staleness issue found, output a JSON object on its own line:
{"type": "stale", "page": "${page.path}", "description": "<what is outdated>", "severity": "warning|error", "suggestion": "<how to fix>"}

If the page is up to date, output:
{"type": "current", "page": "${page.path}", "message": "Page is current with source material."}

--- Wiki Page: ${page.path} (updated: ${page.updatedAt}) ---
${page.content}

--- Source Documents ---
${sourceSummaries.join("\n\n")}`;
}
