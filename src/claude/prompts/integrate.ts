import type { WikiPage } from "../../types/page.js";

/**
 * Format a prompt for integrating a manual note/context into existing wiki pages.
 * Used when users add notes, meeting summaries, or decisions via `ctx add`.
 */
export function formatIntegratePrompt(
  note: string,
  type: string,
  existingPages: WikiPage[]
): string {
  const pageList = existingPages
    .map((p) => `- ${p.path}: ${p.title}`)
    .join("\n");

  const pageContents = existingPages
    .map((p) => `--- ${p.path} ---\n${p.content}`)
    .join("\n\n");

  return `You are integrating a new piece of context into an existing wiki. The user has provided a ${type} note that needs to be woven into the appropriate wiki pages.

Your task:
1. Determine which existing pages should be updated to include this information.
2. If the note describes something entirely new (a new service, person, decision, etc.), create a new page.
3. Weave the information naturally into the existing structure — do not just append it.
4. Add cross-references to/from related pages.
5. Include source attribution: _Source: manual (${type})_

For each page you want to create or update, output:
=== UPDATE: <existing-path.md> ===
(full updated content of the page)

=== PAGE: <new-path.md> ===
(full content of any new pages)

If the note does not warrant any wiki changes, output:
=== NO_CHANGE ===
Reason: <why no change is needed>

Existing wiki pages:
${pageList}

--- Existing Page Contents ---
${pageContents}

--- New ${type} Note ---
${note}`;
}

/**
 * Format a prompt for applying a correction to an existing wiki page.
 * Used when users explicitly correct information via `ctx add --correct`.
 */
export function formatCorrectionPrompt(
  correction: string,
  existingPage: WikiPage
): string {
  return `Apply the following correction to the wiki page below. The user is explicitly stating that some information in the page is wrong and providing the correct version.

Rules:
- Apply the correction precisely.
- Preserve all other content that is not affected by the correction.
- Add a note at the bottom: _Corrected: ${new Date().toISOString().split("T")[0]} — ${correction.slice(0, 80)}${correction.length > 80 ? "..." : ""}_
- If the correction conflicts with multiple sections, update all of them.
- Maintain the existing page structure and formatting.

Output the complete corrected page content (not a diff).

--- Correction ---
${correction}

--- Existing Page: ${existingPage.path} ---
${existingPage.content}`;
}
