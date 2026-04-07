import type { WikiPage } from "../../types/page.js";

/**
 * Format a single-shot query prompt against wiki pages.
 * Used for one-off questions about the codebase/project.
 */
export function formatQueryPrompt(
  question: string,
  pages: WikiPage[]
): string {
  const context = pages
    .map((p) => `--- ${p.path} (updated: ${p.updatedAt}) ---\n${p.content}`)
    .join("\n\n");

  return `You are a technical assistant with access to a project wiki. Answer the following question using ONLY the wiki context provided below. If the answer is not in the context, say so clearly rather than guessing.

Rules:
- Cite your sources by referencing the wiki page path, e.g. "According to [repos/api/overview.md]..."
- Be specific — include code snippets, file paths, and configuration details when relevant.
- If the context contains conflicting information, note the conflict and state which source is likely more current (based on updatedAt timestamps).
- If you are unsure or the context is insufficient, say "I don't have enough context to answer this fully" and suggest which sources might help.

--- Wiki Context (${pages.length} pages) ---
${context}

--- Question ---
${question}`;
}

/**
 * Format a conversational chat prompt with history.
 * Used for multi-turn Q&A sessions about the project.
 */
export function formatChatPrompt(
  question: string,
  pages: WikiPage[],
  history: Array<{ role: string; content: string }>
): string {
  const context = pages
    .map((p) => `--- ${p.path} (updated: ${p.updatedAt}) ---\n${p.content}`)
    .join("\n\n");

  const historyText =
    history.length > 0
      ? history
          .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
          .join("\n\n")
      : "(No prior conversation)";

  return `You are a technical assistant with access to a project wiki. Continue the conversation below, answering the user's latest question using the wiki context.

Rules:
- Cite your sources by referencing wiki page paths.
- Be specific and include code snippets or file paths when relevant.
- Acknowledge uncertainty when the context is insufficient.
- Build on previous conversation turns — avoid repeating information already discussed.
- If the user asks a follow-up, reference the earlier context naturally.

--- Wiki Context (${pages.length} pages) ---
${context}

--- Conversation History ---
${historyText}

--- Latest Question ---
${question}`;
}
