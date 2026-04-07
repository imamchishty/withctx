import type { PageManager } from "./pages.js";
import type { WikiPage } from "../types/page.js";

/**
 * A reference between two wiki pages.
 */
export interface PageReference {
  /** The page containing the reference */
  from: string;
  /** The page being referenced */
  to: string;
  /** The link text used */
  label: string;
}

/**
 * A detected entity mention in a page.
 */
export interface EntityMention {
  /** The page where the mention was found */
  page: string;
  /** The entity name mentioned */
  entity: string;
  /** How it was mentioned (link, inline text, heading) */
  type: "link" | "text" | "heading";
}

/**
 * Result of a cross-reference scan.
 */
export interface CrossReferenceReport {
  /** All references found across pages */
  references: PageReference[];
  /** Pages with no incoming references */
  orphans: string[];
  /** Broken links (reference to non-existent pages) */
  brokenLinks: PageReference[];
  /** Pages that were updated with "See also" sections */
  pagesUpdated: string[];
  /** Total entity mentions found */
  mentionCount: number;
}

/**
 * Manages cross-references between wiki pages.
 * Scans pages for entity mentions, builds a reference graph,
 * detects broken links and orphan pages, and can inject
 * "See also" sections.
 */
export class CrossReferencer {
  private pages: PageManager;

  constructor(pages: PageManager) {
    this.pages = pages;
  }

  /**
   * Run a full cross-reference scan across all wiki pages.
   * Optionally updates pages with "See also" sections.
   */
  scan(options: { updatePages?: boolean } = {}): CrossReferenceReport {
    const allPaths = this.pages.list();
    const allPages = this.loadAllPages(allPaths);

    // Build the reference graph from existing links
    const references = this.extractAllReferences(allPages);

    // Find entity mentions (names referenced as plain text)
    const mentions = this.findEntityMentions(allPages);

    // Detect broken links
    const pagePathSet = new Set(allPaths);
    const brokenLinks = references.filter((ref) => !pagePathSet.has(ref.to));

    // Detect orphan pages (no incoming references, excluding index/log)
    const orphans = this.findOrphans(allPaths, references);

    // Build "See also" suggestions
    const seeAlsoMap = this.buildSeeAlsoMap(allPages, references, mentions);

    let pagesUpdated: string[] = [];
    if (options.updatePages) {
      pagesUpdated = this.applySeeAlsoSections(allPages, seeAlsoMap);
    }

    return {
      references,
      orphans,
      brokenLinks,
      pagesUpdated,
      mentionCount: mentions.length,
    };
  }

  /**
   * Get the reference graph as an adjacency list.
   * Useful for visualization or further analysis.
   */
  getGraph(): Map<string, Set<string>> {
    const allPages = this.loadAllPages(this.pages.list());
    const references = this.extractAllReferences(allPages);

    const graph = new Map<string, Set<string>>();
    for (const ref of references) {
      if (!graph.has(ref.from)) {
        graph.set(ref.from, new Set());
      }
      graph.get(ref.from)!.add(ref.to);
    }
    return graph;
  }

  /**
   * Load all wiki pages into memory.
   */
  private loadAllPages(paths: string[]): WikiPage[] {
    const pages: WikiPage[] = [];
    for (const path of paths) {
      const page = this.pages.read(path);
      if (page) pages.push(page);
    }
    return pages;
  }

  /**
   * Extract all markdown link references from all pages.
   */
  private extractAllReferences(pages: WikiPage[]): PageReference[] {
    const refs: PageReference[] = [];
    const linkPattern = /\[([^\]]+)\]\(([^)]+\.md)\)/g;

    for (const page of pages) {
      let match: RegExpExecArray | null;
      while ((match = linkPattern.exec(page.content)) !== null) {
        const targetPath = this.resolveRelativePath(page.path, match[2]);
        refs.push({
          from: page.path,
          to: targetPath,
          label: match[1],
        });
      }
    }

    return refs;
  }

  /**
   * Find entity mentions — page titles or known terms
   * referenced as plain text (not links) in other pages.
   */
  private findEntityMentions(pages: WikiPage[]): EntityMention[] {
    const mentions: EntityMention[] = [];

    // Build a map of page titles to paths for matching
    const titleToPath = new Map<string, string>();
    for (const page of pages) {
      if (page.title && page.title !== "Untitled") {
        titleToPath.set(page.title.toLowerCase(), page.path);
      }
      // Also index by filename slug
      const slug = page.path
        .split("/")
        .pop()
        ?.replace(".md", "")
        .replace(/-/g, " ");
      if (slug) {
        titleToPath.set(slug.toLowerCase(), page.path);
      }
    }

    for (const page of pages) {
      const contentLower = page.content.toLowerCase();

      for (const [title, targetPath] of titleToPath) {
        // Skip self-references
        if (targetPath === page.path) continue;

        // Skip very short titles (too many false positives)
        if (title.length < 4) continue;

        // Check if title appears in content but is not already linked
        if (contentLower.includes(title)) {
          // Verify it's not already a link target
          const alreadyLinked = page.references.includes(targetPath);
          if (!alreadyLinked) {
            // Check if it appears in a heading
            const headingPattern = new RegExp(
              `^#{1,6}\\s+.*${escapeRegex(title)}`,
              "im"
            );
            const type = headingPattern.test(page.content)
              ? "heading"
              : "text";

            mentions.push({
              page: page.path,
              entity: title,
              type,
            });
          }
        }
      }
    }

    return mentions;
  }

  /**
   * Find orphan pages — pages with no incoming references.
   */
  private findOrphans(
    allPaths: string[],
    references: PageReference[]
  ): string[] {
    const excludePaths = new Set(["index.md", "log.md"]);
    const referencedPages = new Set(references.map((r) => r.to));

    return allPaths.filter(
      (path) => !excludePaths.has(path) && !referencedPages.has(path)
    );
  }

  /**
   * Build a map of page path -> suggested "See also" links.
   * Based on entity mentions and shared references.
   */
  private buildSeeAlsoMap(
    pages: WikiPage[],
    references: PageReference[],
    mentions: EntityMention[]
  ): Map<string, Set<string>> {
    const seeAlso = new Map<string, Set<string>>();

    // From entity mentions: if page A mentions entity from page B,
    // suggest B in A's "See also"
    const titleToPath = new Map<string, string>();
    for (const page of pages) {
      if (page.title && page.title !== "Untitled") {
        titleToPath.set(page.title.toLowerCase(), page.path);
      }
    }

    for (const mention of mentions) {
      const targetPath = titleToPath.get(mention.entity);
      if (!targetPath) continue;

      if (!seeAlso.has(mention.page)) {
        seeAlso.set(mention.page, new Set());
      }
      seeAlso.get(mention.page)!.add(targetPath);
    }

    // From shared references: if page A and page B both reference page C,
    // they are likely related
    const reverseIndex = new Map<string, Set<string>>();
    for (const ref of references) {
      if (!reverseIndex.has(ref.to)) {
        reverseIndex.set(ref.to, new Set());
      }
      reverseIndex.get(ref.to)!.add(ref.from);
    }

    for (const [, referrers] of reverseIndex) {
      if (referrers.size < 2) continue;
      const referrerList = Array.from(referrers);
      for (let i = 0; i < referrerList.length; i++) {
        for (let j = i + 1; j < referrerList.length; j++) {
          const a = referrerList[i];
          const b = referrerList[j];

          // Only suggest if not already linked
          const aRefs = references
            .filter((r) => r.from === a)
            .map((r) => r.to);
          if (!aRefs.includes(b)) {
            if (!seeAlso.has(a)) seeAlso.set(a, new Set());
            seeAlso.get(a)!.add(b);
          }

          const bRefs = references
            .filter((r) => r.from === b)
            .map((r) => r.to);
          if (!bRefs.includes(a)) {
            if (!seeAlso.has(b)) seeAlso.set(b, new Set());
            seeAlso.get(b)!.add(a);
          }
        }
      }
    }

    return seeAlso;
  }

  /**
   * Apply "See also" sections to pages that need them.
   * Returns list of paths that were updated.
   */
  private applySeeAlsoSections(
    pages: WikiPage[],
    seeAlsoMap: Map<string, Set<string>>
  ): string[] {
    const updated: string[] = [];

    for (const page of pages) {
      const suggestions = seeAlsoMap.get(page.path);
      if (!suggestions || suggestions.size === 0) continue;

      // Build "See also" section
      const seeAlsoLinks = Array.from(suggestions)
        .sort()
        .map((targetPath) => {
          const targetPage = pages.find((p) => p.path === targetPath);
          const label = targetPage?.title ?? targetPath;
          const relativePath = this.computeRelativePath(
            page.path,
            targetPath
          );
          return `- [${label}](${relativePath})`;
        })
        .join("\n");

      const seeAlsoSection = `\n\n## See Also\n\n${seeAlsoLinks}\n`;

      // Remove existing "See also" section if present
      let content = page.content.replace(
        /\n+## See Also\n[\s\S]*?(?=\n## |\n*$)/i,
        ""
      );

      // Append the new section
      content = content.trimEnd() + seeAlsoSection;

      this.pages.write(page.path, content);
      updated.push(page.path);
    }

    return updated;
  }

  /**
   * Resolve a relative link path from a source page.
   * e.g., from "repos/api/overview.md", "../services/auth.md"
   * resolves to "services/auth.md"
   */
  private resolveRelativePath(fromPage: string, linkTarget: string): string {
    if (!linkTarget.startsWith("..") && !linkTarget.startsWith("./")) {
      return linkTarget;
    }

    const fromParts = fromPage.split("/");
    fromParts.pop(); // remove filename

    const linkParts = linkTarget.split("/");

    for (const part of linkParts) {
      if (part === "..") {
        fromParts.pop();
      } else if (part !== ".") {
        fromParts.push(part);
      }
    }

    return fromParts.join("/");
  }

  /**
   * Compute a relative path from one page to another.
   */
  private computeRelativePath(fromPage: string, toPage: string): string {
    const fromParts = fromPage.split("/");
    fromParts.pop(); // remove filename

    const toParts = toPage.split("/");

    // Find common prefix
    let common = 0;
    while (
      common < fromParts.length &&
      common < toParts.length - 1 &&
      fromParts[common] === toParts[common]
    ) {
      common++;
    }

    // Build relative path
    const ups = fromParts.length - common;
    const parts: string[] = [];

    for (let i = 0; i < ups; i++) {
      parts.push("..");
    }

    for (let i = common; i < toParts.length; i++) {
      parts.push(toParts[i]);
    }

    return parts.join("/") || toPage;
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
