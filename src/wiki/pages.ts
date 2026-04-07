import { CtxDirectory } from "../storage/ctx-dir.js";
import type { WikiPage, IndexEntry } from "../types/page.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * Manages wiki page CRUD operations.
 */
export class PageManager {
  private ctx: CtxDirectory;

  constructor(ctx: CtxDirectory) {
    this.ctx = ctx;
  }

  /**
   * Read a wiki page by relative path.
   */
  read(relativePath: string): WikiPage | null {
    const content = this.ctx.readPage(relativePath);
    if (!content) return null;

    const fullPath = join(this.ctx.contextPath, relativePath);
    const stat = statSync(fullPath);

    return {
      path: relativePath,
      title: this.extractTitle(content),
      content,
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      sources: this.extractSources(content),
      references: this.extractReferences(content),
    };
  }

  /**
   * Write or update a wiki page.
   */
  write(relativePath: string, content: string): void {
    this.ctx.writePage(relativePath, content);
  }

  /**
   * List all wiki pages.
   */
  list(subdir?: string): string[] {
    return this.ctx.listPages(subdir);
  }

  /**
   * Search wiki pages by content.
   */
  search(query: string): WikiPage[] {
    const pages = this.list();
    const results: WikiPage[] = [];
    const queryLower = query.toLowerCase();

    for (const pagePath of pages) {
      const page = this.read(pagePath);
      if (!page) continue;

      if (
        page.content.toLowerCase().includes(queryLower) ||
        page.title.toLowerCase().includes(queryLower)
      ) {
        results.push(page);
      }
    }

    return results;
  }

  /**
   * Get the index as structured entries.
   */
  getIndex(): IndexEntry[] {
    const pages = this.list();
    return pages
      .filter((p) => p !== "index.md" && p !== "log.md")
      .map((pagePath) => {
        const page = this.read(pagePath);
        return {
          path: pagePath,
          title: page?.title ?? basename(pagePath, ".md"),
          summary: page ? this.extractFirstParagraph(page.content) : "",
          updatedAt: page?.updatedAt ?? "",
        };
      });
  }

  private extractTitle(content: string): string {
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : "Untitled";
  }

  private extractFirstParagraph(content: string): string {
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("|") && !trimmed.startsWith("_")) {
        return trimmed.slice(0, 200);
      }
    }
    return "";
  }

  private extractSources(content: string): string[] {
    const sources: string[] = [];
    const sourceMatch = content.match(/_(?:Source|Generated from|Sources?):(.+)_/g);
    if (sourceMatch) {
      for (const match of sourceMatch) {
        sources.push(match.replace(/^_(?:Source|Generated from|Sources?):/, "").replace(/_$/, "").trim());
      }
    }
    return sources;
  }

  private extractReferences(content: string): string[] {
    const refs: string[] = [];
    const linkPattern = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
    let match;
    while ((match = linkPattern.exec(content)) !== null) {
      refs.push(match[2]);
    }
    return [...new Set(refs)];
  }
}
