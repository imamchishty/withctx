import type { RawDocument } from "../../types/source.js";
import type { WikiPage } from "../../types/page.js";

/**
 * System prompt for wiki compilation tasks.
 * Instructs Claude to produce structured, cross-referenced markdown.
 */
export const COMPILE_SYSTEM_PROMPT = `You are a technical wiki compiler. Your job is to transform raw source documents into clean, structured markdown wiki pages.

Rules:
- Write clear, structured markdown with proper headings (##, ###).
- Include source attribution at the bottom of each page: _Source: <source name>_
- Cross-reference other wiki pages using relative markdown links, e.g. [Service Name](../services/service-name.md).
- Use fenced code blocks with language tags (e.g. \`\`\`typescript).
- Be concise but comprehensive — capture all important technical details.
- Never invent information not present in the source documents.
- Prefer bullet points and tables over prose for technical details.
- Group related information under descriptive headings.
- If content is ambiguous or conflicting across sources, note the discrepancy.

Output ONLY the markdown content for the wiki page(s). Do not include meta-commentary or explanations about your process.`;

/**
 * Format a prompt for compiling raw documents into new wiki pages.
 * Used when creating pages from scratch during initial ingestion.
 */
export function formatCompilePrompt(
  docs: RawDocument[],
  existingPages: string[]
): string {
  const docSummaries = docs.map((doc, i) => {
    const meta = [
      `Source: ${doc.sourceName} (${doc.sourceType})`,
      doc.author ? `Author: ${doc.author}` : null,
      doc.updatedAt ? `Updated: ${doc.updatedAt}` : null,
      doc.url ? `URL: ${doc.url}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    return `--- Document ${i + 1}: ${doc.title} ---\n${meta}\n\n${doc.content}`;
  });

  const existingList =
    existingPages.length > 0
      ? `\nExisting wiki pages (link to these where relevant):\n${existingPages.map((p) => `- ${p}`).join("\n")}\n`
      : "";

  return `Compile the following ${docs.length} source document(s) into one or more structured wiki pages.

For each page you produce, start with a line: === PAGE: <relative-path.md> ===
Then write the full markdown content for that page.

Decide which pages to create based on the content:
- If documents describe a single service/repo, create one focused page.
- If documents span multiple topics, create separate pages for each.
- Use paths like: repos/<name>/overview.md, services/<name>.md, people/<name>.md

${existingList}
${docSummaries.join("\n\n")}`;
}

/**
 * Format a prompt for updating an existing wiki page with new information.
 */
export function formatUpdatePrompt(
  doc: RawDocument,
  existingPage: string
): string {
  return `Update the following existing wiki page with new information from the source document below.

Preserve the existing structure and content where it is still accurate. Merge new information naturally. Update timestamps and source attributions. Mark any information that conflicts with the existing content.

--- Existing Page ---
${existingPage}

--- New Source Document: ${doc.title} ---
Source: ${doc.sourceName} (${doc.sourceType})
${doc.author ? `Author: ${doc.author}` : ""}
${doc.updatedAt ? `Updated: ${doc.updatedAt}` : ""}

${doc.content}

Output the complete updated page content (not a diff).`;
}

/**
 * Format a prompt for generating a repo overview page.
 */
export function formatRepoOverviewPrompt(
  repoName: string,
  files: RawDocument[]
): string {
  const fileSummaries = files.map((f) => {
    const preview =
      f.content.length > 2000
        ? f.content.slice(0, 2000) + "\n... (truncated)"
        : f.content;
    return `--- ${f.title} ---\n${preview}`;
  });

  return `Generate a comprehensive overview page for the repository "${repoName}".

Create the page at: repos/${repoName}/overview.md

The page should include:
1. **Purpose** — What this repo does and why it exists
2. **Tech Stack** — Languages, frameworks, key dependencies
3. **Architecture** — High-level structure and patterns used
4. **Key Components** — Main modules/packages and their roles
5. **Entry Points** — Where to start reading the code
6. **API Surface** — Exposed APIs, CLI commands, or exports (if applicable)
7. **Configuration** — How to configure/customize the project
8. **Known Issues / Gotchas** — Non-obvious things developers should know

Also generate these additional pages if the source material supports them:
=== PAGE: repos/${repoName}/structure.md ===
Directory structure with descriptions of key files/folders.

=== PAGE: repos/${repoName}/patterns.md ===
Design patterns, conventions, and coding standards found in the codebase.

=== PAGE: repos/${repoName}/dependencies.md ===
Key dependencies, why they are used, and version constraints.

=== PAGE: repos/${repoName}/gotchas.md ===
Non-obvious behaviors, workarounds, known edge cases.

=== PAGE: repos/${repoName}/api-endpoints.md ===
API endpoints or CLI commands (only if present in the source material).

Source files from this repository:
${fileSummaries.join("\n\n")}

For each page, start with: === PAGE: <path> ===
Then the full markdown content. Only create pages for which there is sufficient source material.`;
}

/**
 * Format a prompt for generating cross-repo analysis pages.
 */
export function formatCrossRepoPrompt(
  repos: string[],
  existingPages: WikiPage[]
): string {
  const pageContents = existingPages.map(
    (p) => `--- ${p.path} ---\n${p.content}`
  );

  return `Analyze the following wiki pages from ${repos.length} repositories and generate cross-repo context pages.

Repositories: ${repos.join(", ")}

Create the following pages based on what you find:

=== PAGE: cross-repo/dependencies.md ===
Map of how repositories depend on each other. Include shared libraries, APIs called between services, and data flows.

=== PAGE: cross-repo/data-flow.md ===
How data moves between services/repos. Include databases, message queues, API calls, and shared state.

=== PAGE: cross-repo/deployment-order.md ===
Recommended deployment order based on dependencies. Note any circular dependencies or deployment risks.

Only create pages for which there is meaningful content. If repos are independent with no cross-cutting concerns, say so briefly.

Existing wiki pages:
${pageContents.join("\n\n")}

For each page, start with: === PAGE: <path> ===
Then the full markdown content.`;
}
