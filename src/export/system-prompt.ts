import type { WikiPage, ExportResult, PackOptions } from "../types/page.js";
import { PageManager } from "../wiki/pages.js";

const CHARS_PER_TOKEN = 4;

/**
 * Export wiki as a concise system prompt for LLMs.
 * More compact than CLAUDE.md — focuses on key instructions and constraints.
 */
export function exportSystemPrompt(
  pageManager: PageManager,
  options: PackOptions = { format: "system-prompt" }
): ExportResult {
  const budget = options.budget ?? 50_000; // default 50k tokens
  const maxChars = budget * CHARS_PER_TOKEN;

  // Load and filter pages
  const pagePaths = pageManager.list(options.scope);
  const pages: WikiPage[] = [];

  for (const path of pagePaths) {
    if (path === "log.md" || path === "lint-report.md" || path === "index.md")
      continue;
    const page = pageManager.read(path);
    if (page) pages.push(page);
  }

  // Prioritize: overview, architecture, conventions first
  pages.sort((a, b) => getPromptPriority(a.path) - getPromptPriority(b.path));

  const sections: string[] = [];
  let totalChars = 0;
  let pagesIncluded = 0;

  // System prompt header
  const header = buildSystemHeader(options);
  totalChars += header.length;
  sections.push(header);

  // Add pages
  for (const page of pages) {
    const section = formatForPrompt(page);
    if (totalChars + section.length > maxChars) break;

    sections.push(section);
    totalChars += section.length;
    pagesIncluded++;
  }

  // Footer with instructions
  const footer = buildSystemFooter();
  sections.push(footer);

  const content = sections.join("\n\n");

  return {
    format: "system-prompt",
    content,
    tokenCount: Math.ceil(content.length / CHARS_PER_TOKEN),
    pagesIncluded,
  };
}

function buildSystemHeader(options: PackOptions): string {
  const lines = [
    "<project-context>",
    "You are working on a codebase. The following is compiled project context.",
    "Use this information to understand the project architecture, conventions, and decisions.",
  ];
  if (options.scope) {
    lines.push(`Scope: ${options.scope}`);
  }
  return lines.join("\n");
}

function buildSystemFooter(): string {
  return [
    "</project-context>",
    "",
    "<instructions>",
    "- Follow the conventions and patterns documented above.",
    "- When making decisions, check the decisions pages for precedent.",
    "- Respect the architecture boundaries described in the architecture pages.",
    "- If something is unclear, state your assumption rather than guessing.",
    "</instructions>",
  ].join("\n");
}

function formatForPrompt(page: WikiPage): string {
  // Use XML-style tags for clear delineation in prompts
  const tag = page.path.replace(/[/.]/g, "-").replace(/-md$/, "");
  const content = condensePage(page.content);
  return `<${tag}>\n${content}\n</${tag}>`;
}

/**
 * Condense page content for prompt use.
 * Removes excessive whitespace and metadata lines.
 */
function condensePage(content: string): string {
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      // Remove source attribution lines
      if (trimmed.startsWith("_Source:") || trimmed.startsWith("_Generated")) {
        return false;
      }
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getPromptPriority(path: string): number {
  if (path.startsWith("overview") || path === "overview.md") return 0;
  if (path.startsWith("architecture") || path.startsWith("repos/")) return 1;
  if (path.startsWith("conventions")) return 2;
  if (path.startsWith("decisions")) return 3;
  if (path.startsWith("cross-repo/")) return 4;
  if (path.startsWith("services/")) return 5;
  return 10;
}
