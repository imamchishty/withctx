import { CtxDirectory } from "../storage/ctx-dir.js";
import type { WikiPage, IndexEntry } from "../types/page.js";
import { statSync } from "node:fs";
import { join, basename } from "node:path";
import {
  parsePage,
  stampMetadata,
  stripMetadata,
  type PageMetadata,
} from "./metadata.js";
import { detectActor } from "../usage/refresh-context.js";

/**
 * Options for writing a page. `meta` is merged into any existing ctx
 * front-matter the caller may have embedded; unspecified fields are
 * auto-stamped (`refreshed_at`, `refreshed_by`) so the Info-axis
 * guarantee — every page carries a freshness header — holds even for
 * call sites that don't know about metadata.
 */
export interface WritePageOptions {
  meta?: PageMetadata;
  /**
   * Skip the auto-stamp of `refreshed_at` / `refreshed_by`. Used by
   * tests and by the reset command. You almost never want this in
   * production code paths.
   */
  skipStamp?: boolean;
}

/**
 * Manages wiki page CRUD operations.
 */
export class PageManager {
  private ctx: CtxDirectory;

  constructor(ctx: CtxDirectory) {
    this.ctx = ctx;
  }

  /**
   * Read a wiki page by relative path. Parses any `ctx` front-matter
   * into `page.meta` and strips it from `page.content` so downstream
   * consumers (LLM prompts, exports) see the body only.
   */
  read(relativePath: string): WikiPage | null {
    const raw = this.ctx.readPage(relativePath);
    if (!raw) return null;

    const fullPath = join(this.ctx.contextPath, relativePath);
    const stat = statSync(fullPath);

    const parsed = parsePage(raw);
    const body = Object.keys(parsed.otherFrontmatter).length
      ? stripMetadata(raw)
      : parsed.body;

    return {
      path: relativePath,
      title: this.extractTitle(body),
      content: body,
      createdAt: stat.birthtime.toISOString(),
      updatedAt: parsed.meta.refreshed_at ?? stat.mtime.toISOString(),
      sources: this.extractSources(body),
      references: this.extractReferences(body),
      meta: parsed.meta,
    };
  }

  /**
   * Read a page's raw content including front-matter — used by lint /
   * verify / export paths that want to round-trip the block untouched.
   */
  readRaw(relativePath: string): string | null {
    return this.ctx.readPage(relativePath);
  }

  /**
   * Write or update a wiki page. Auto-stamps `refreshed_at` and
   * `refreshed_by` unless `skipStamp` is passed. Any caller-supplied
   * `meta` fields are merged on top.
   */
  write(
    relativePath: string,
    content: string,
    options: WritePageOptions = {}
  ): void {
    const stamped = options.skipStamp
      ? content
      : stampMetadata(content, {
          refreshed_at: new Date().toISOString(),
          refreshed_by: safeDetectActor(),
          ...(options.meta ?? {}),
        });
    this.ctx.writePage(relativePath, stamped);
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

/**
 * Actor detection can throw in edge cases (e.g. missing os.userInfo()
 * on some Docker images). A freshness stamp is never worth crashing
 * a wiki write, so we fall back to a generic label.
 */
function safeDetectActor(): string {
  try {
    return detectActor();
  } catch {
    return "unknown";
  }
}
