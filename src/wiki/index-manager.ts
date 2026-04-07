import type { PageManager } from "./pages.js";
import type { CtxDirectory } from "../storage/ctx-dir.js";

/**
 * Maintains the index.md catalog page.
 */
export class IndexManager {
  private ctx: CtxDirectory;
  private pages: PageManager;

  constructor(ctx: CtxDirectory, pages: PageManager) {
    this.ctx = ctx;
    this.pages = pages;
  }

  /**
   * Regenerate index.md from current wiki pages.
   */
  rebuild(): void {
    const entries = this.pages.getIndex();
    const sections = new Map<string, typeof entries>();

    // Group by top-level directory
    for (const entry of entries) {
      const parts = entry.path.split("/");
      const section = parts.length > 1 ? parts[0] : "root";
      if (!sections.has(section)) {
        sections.set(section, []);
      }
      sections.get(section)!.push(entry);
    }

    let content = "# Wiki Index\n\n";
    content += `_${entries.length} pages compiled. Last updated: ${new Date().toISOString()}_\n\n`;

    // Root-level pages first
    const rootPages = sections.get("root") ?? [];
    if (rootPages.length > 0) {
      content += "## Overview\n\n";
      for (const entry of rootPages) {
        content += `- [${entry.title}](${entry.path})`;
        if (entry.summary) content += ` — ${entry.summary}`;
        content += "\n";
      }
      content += "\n";
    }

    // Categorized sections
    const sectionOrder = [
      "repos",
      "cross-repo",
      "services",
      "people",
      "onboarding",
      "manual",
    ];

    const sectionTitles: Record<string, string> = {
      repos: "Repositories",
      "cross-repo": "Cross-Repo Context",
      services: "Services",
      people: "People & Teams",
      onboarding: "Onboarding",
      manual: "Manual Notes",
    };

    for (const section of sectionOrder) {
      const pages = sections.get(section);
      if (!pages || pages.length === 0) continue;

      content += `## ${sectionTitles[section] ?? section}\n\n`;
      for (const entry of pages) {
        content += `- [${entry.title}](${entry.path})`;
        if (entry.summary) content += ` — ${entry.summary}`;
        content += "\n";
      }
      content += "\n";
    }

    // Any remaining sections
    for (const [section, pages] of sections) {
      if (section === "root" || sectionOrder.includes(section)) continue;
      if (pages.length === 0) continue;

      content += `## ${section}\n\n`;
      for (const entry of pages) {
        content += `- [${entry.title}](${entry.path})`;
        if (entry.summary) content += ` — ${entry.summary}`;
        content += "\n";
      }
      content += "\n";
    }

    this.ctx.writePage("index.md", content);
  }
}
