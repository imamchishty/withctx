import type { WikiPage, ExportResult, PackOptions } from "../types/page.js";
import { PageManager } from "../wiki/pages.js";

const CHARS_PER_TOKEN = 4;

/**
 * Export all wiki pages as a single concatenated markdown document.
 * Supports scope filtering and token budget.
 */
export function exportMarkdown(
  pageManager: PageManager,
  options: PackOptions = { format: "markdown" }
): ExportResult {
  const budget = options.budget;
  const maxChars = budget ? budget * CHARS_PER_TOKEN : Infinity;

  // Load pages
  const pagePaths = pageManager.list(options.scope);
  const pages: WikiPage[] = [];

  for (const path of pagePaths) {
    const page = pageManager.read(path);
    if (page) pages.push(page);
  }

  // Sort alphabetically by path
  pages.sort((a, b) => a.path.localeCompare(b.path));

  const sections: string[] = [];
  let totalChars = 0;
  let pagesIncluded = 0;

  // Title
  const title = `# Project Wiki Export\n\n_Generated: ${new Date().toISOString()}_\n_Pages: ${pages.length}_`;
  totalChars += title.length;
  sections.push(title);

  // Table of contents
  const toc = buildToc(pages);
  totalChars += toc.length;
  sections.push(toc);

  // Pages
  for (const page of pages) {
    const section = formatPage(page);
    if (totalChars + section.length > maxChars) break;

    sections.push(section);
    totalChars += section.length;
    pagesIncluded++;
  }

  const content = sections.join("\n\n---\n\n");

  return {
    format: "markdown",
    content,
    tokenCount: Math.ceil(content.length / CHARS_PER_TOKEN),
    pagesIncluded,
  };
}

function buildToc(pages: WikiPage[]): string {
  const lines = ["## Contents", ""];
  for (let i = 0; i < pages.length; i++) {
    lines.push(`${i + 1}. **${pages[i].title}** — \`${pages[i].path}\``);
  }
  return lines.join("\n");
}

function formatPage(page: WikiPage): string {
  const lines: string[] = [];
  lines.push(`## ${page.title}`);
  lines.push(`> Path: \`${page.path}\` | Updated: ${page.updatedAt}`);
  lines.push("");
  lines.push(page.content);
  return lines.join("\n");
}
