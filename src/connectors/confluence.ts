import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";
import type { ConfluenceSource } from "../types/config.js";
import { resilientFetch } from "./resilient-fetch.js";
import { processMarkdown, detectDocType } from "./markdown-processor.js";

interface ConfluencePage {
  id: string;
  type: string;
  status: string;
  title: string;
  body?: {
    storage?: { value: string };
    view?: { value: string };
  };
  version?: {
    number: number;
    when: string;
    by?: { displayName: string; email?: string };
  };
  history?: {
    createdDate: string;
    createdBy?: { displayName: string };
  };
  _links?: {
    webui?: string;
    self?: string;
  };
  metadata?: {
    labels?: {
      results: Array<{ name: string }>;
    };
  };
  children?: {
    attachment?: {
      results: Array<{
        title: string;
        mediaType: string;
        _links?: { download?: string };
      }>;
    };
  };
}

interface ConfluenceSearchResponse {
  results: ConfluencePage[];
  start: number;
  limit: number;
  size: number;
  _links?: { next?: string };
}

/**
 * Normalize a Confluence base_url so the rest of the connector can
 * always append plain `/rest/api/...` paths and have them resolve.
 *
 * Confluence has two deployment shapes and they use DIFFERENT URL
 * layouts:
 *
 *   Cloud (*.atlassian.net):
 *     Every REST endpoint lives under `/wiki/rest/api/...`.
 *     A user who sets `base_url: https://acme.atlassian.net` will hit
 *     404s on every call — the connector would build
 *     `https://acme.atlassian.net/rest/api/content/search` which is
 *     outside the wiki mount point.
 *
 *   Server / Data Center (self-hosted):
 *     Endpoints live at the root: `/rest/api/...`.
 *     A user who sets `base_url: https://confluence.acme.internal`
 *     is already correct — adding `/wiki` would break it.
 *
 * We detect Cloud by hostname (`*.atlassian.net`) and, when the
 * user hasn't already included `/wiki`, append it. The heuristic
 * is narrow on purpose: we don't want to rewrite custom domains or
 * non-cloud hosts, so any host that isn't `atlassian.net` is left
 * alone and treated as Server/DC.
 *
 * Trailing slashes are stripped so `resilientFetch` doesn't end up
 * with `//rest/api/...` in the path.
 */
export function normalizeConfluenceBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/$/, "");

  // Try to parse as a URL so we can read the hostname cleanly.
  // If the input isn't URL-shaped (shouldn't happen — SafeHttpUrl has
  // already validated it), fall back to the original string.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const isCloud = /(^|\.)atlassian\.net$/i.test(parsed.hostname);
  if (!isCloud) return trimmed;

  // User already put /wiki in the path (or deeper) — leave it alone.
  const path = parsed.pathname.replace(/\/$/, "");
  if (path === "/wiki" || path.startsWith("/wiki/")) return trimmed;

  // Cloud host with no /wiki prefix → append it. Preserve the origin.
  return `${parsed.origin}/wiki`;
}

/**
 * Connector for Confluence.
 * Uses Atlassian REST API (fetch-based).
 * Supports spaces, specific pages, labels, page trees.
 * Converts Confluence storage format to markdown.
 *
 * Supports BOTH deployment modes:
 *
 *   Cloud (*.atlassian.net) — Basic auth via `email + token` (API token
 *     from id.atlassian.com). base_url is auto-normalized to include
 *     the `/wiki` mount point if the user forgot it.
 *
 *   Server / Data Center — Bearer auth via PAT in `token` (no email).
 *     Endpoints live at the host root, e.g.
 *     `https://confluence.acme.internal/rest/api/...`.
 *
 * The auth mode is picked automatically by the presence of `email`
 * in the source config: email set → Basic (Cloud), email absent →
 * Bearer (Server/DC).
 */
export class ConfluenceConnector implements SourceConnector {
  readonly type = "confluence" as const;
  readonly name: string;
  private baseUrl: string;
  private email?: string;
  private token: string;
  private spaces: string[];
  private pages?: Array<{ id?: string; url?: string }>;
  private label?: string;
  private parent?: string;
  private exclude?: {
    label?: string[];
    title?: string[];
  };
  private status: SourceStatus;

  constructor(config: ConfluenceSource) {
    this.name = config.name;
    this.baseUrl = normalizeConfluenceBaseUrl(config.base_url);
    this.email = config.email;
    this.token = config.token;
    // Support both single space string and array of spaces
    this.spaces = config.space
      ? Array.isArray(config.space) ? config.space : [config.space]
      : [];
    this.pages = config.pages;
    this.label = config.label;
    this.parent = config.parent;
    this.exclude = config.exclude;
    this.status = {
      name: config.name,
      type: "confluence",
      status: "disconnected",
    };
  }

  async validate(): Promise<boolean> {
    try {
      const response = await this.apiGet("/rest/api/user/current");
      if (response.ok) {
        this.status.status = "connected";
        return true;
      }
      // Some Confluence instances don't support /user/current
      const spaceResponse = await this.apiGet("/rest/api/space?limit=1");
      if (spaceResponse.ok) {
        this.status.status = "connected";
        return true;
      }
      this.status.status = "error";
      this.status.error = `Confluence auth failed: HTTP ${response.status}`;
      return false;
    } catch (error) {
      this.status.status = "error";
      this.status.error = `Failed to connect to Confluence: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";
    let count = 0;

    try {
      // Strategy 1: Fetch specific pages by ID
      if (this.pages && this.pages.length > 0) {
        for (const pageRef of this.pages) {
          const pageId = pageRef.id || this.extractPageIdFromUrl(pageRef.url || "");
          if (!pageId) continue;

          const page = await this.fetchPage(pageId);
          if (!page) continue;
          if (this.shouldExclude(page)) continue;

          count++;
          yield this.pageToDocument(page);
          if (options?.limit && count >= options.limit) break;
        }
      }

      // Strategy 2: Fetch page tree from parent
      if (this.parent && !(options?.limit && count >= options.limit)) {
        for await (const doc of this.fetchPageTree(this.parent, options)) {
          count++;
          yield doc;
          if (options?.limit && count >= options.limit) break;
        }
      }

      // Strategy 3: Fetch by space(s) / label via CQL search
      if ((this.spaces.length > 0 || this.label) && !this.parent && !(this.pages && this.pages.length > 0)) {
        if (this.spaces.length > 0) {
          // Iterate over each space
          for (const space of this.spaces) {
            if (options?.limit && count >= options.limit) break;
            for await (const doc of this.fetchByCql(options, space)) {
              count++;
              yield doc;
              if (options?.limit && count >= options.limit) break;
            }
          }
        } else {
          // Label-only search (no space filter)
          for await (const doc of this.fetchByCql(options)) {
            count++;
            yield doc;
            if (options?.limit && count >= options.limit) break;
          }
        }
      }

      this.status.status = "connected";
      this.status.lastSyncAt = new Date().toISOString();
      this.status.itemCount = count;
    } catch (error) {
      this.status.status = "error";
      this.status.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  getStatus(): SourceStatus {
    return { ...this.status };
  }

  private async fetchPage(pageId: string): Promise<ConfluencePage | null> {
    const expand = "body.storage,version,history,metadata.labels,children.attachment";
    const response = await this.apiGet(`/rest/api/content/${pageId}?expand=${expand}`);
    if (!response.ok) return null;
    return response.json() as Promise<ConfluencePage | null>;
  }

  private async *fetchPageTree(
    parentId: string,
    options?: FetchOptions
  ): AsyncGenerator<RawDocument> {
    // Fetch children of the parent page
    let start = 0;
    const limit = 25;
    let hasMore = true;

    while (hasMore) {
      const expand = "body.storage,version,history,metadata.labels,children.attachment";
      const response = await this.apiGet(
        `/rest/api/content/${parentId}/child/page?expand=${expand}&start=${start}&limit=${limit}`
      );

      if (!response.ok) break;
      const data = await response.json() as ConfluenceSearchResponse;

      for (const page of data.results) {
        if (this.shouldExclude(page)) continue;

        // Check incremental
        if (options?.since && page.version?.when) {
          const updatedAt = new Date(page.version.when);
          if (updatedAt < options.since) continue;
        }

        yield this.pageToDocument(page);

        // Recursively fetch children
        yield* this.fetchPageTree(page.id, options);
      }

      hasMore = data.size === limit;
      start += limit;
    }
  }

  private async *fetchByCql(options?: FetchOptions, space?: string): AsyncGenerator<RawDocument> {
    const cqlParts: string[] = [];
    cqlParts.push("type = page");

    if (space) {
      cqlParts.push(`space = "${space}"`);
    }
    if (this.label) {
      cqlParts.push(`label = "${this.label}"`);
    }
    if (options?.since) {
      const dateStr = options.since.toISOString().split("T")[0];
      cqlParts.push(`lastModified >= "${dateStr}"`);
    }

    const cql = cqlParts.join(" AND ");
    let start = 0;
    const limit = 25;
    let hasMore = true;

    while (hasMore) {
      const expand = "body.storage,version,history,metadata.labels,children.attachment";
      const response = await this.apiGet(
        `/rest/api/content/search?cql=${encodeURIComponent(cql)}&expand=${expand}&start=${start}&limit=${limit}`
      );

      if (!response.ok) {
        throw new Error(`Confluence search failed: HTTP ${response.status} — ${await response.text()}`);
      }

      const data = await response.json() as ConfluenceSearchResponse;

      for (const page of data.results) {
        if (this.shouldExclude(page)) continue;
        yield this.pageToDocument(page);
      }

      hasMore = data.size === limit && !!data._links?.next;
      start += limit;
    }
  }

  private pageToDocument(page: ConfluencePage): RawDocument {
    const storageHtml = page.body?.storage?.value || "";
    const markdownContent = this.storageToMarkdown(storageHtml);

    const labels = page.metadata?.labels?.results?.map((l) => l.name) || [];

    // Detect embedded images in the storage format
    const images: Array<{ name: string; data: Buffer; mimeType: string }> = [];
    // Note: Actual image data would require separate API calls to download attachments.
    // We detect image references and include them in metadata for potential later processing.
    const imageRefs = this.extractImageReferences(storageHtml);

    const webUrl = page._links?.webui
      ? `${this.baseUrl}${page._links.webui}`
      : undefined;

    // Run converted markdown through the processor for doc type detection + sectioning
    const processed = processMarkdown(page.title + ".md", markdownContent, ".");
    const docType = processed.metadata.docType;

    return {
      id: `confluence:${this.name}:${page.id}`,
      sourceType: "confluence",
      sourceName: this.name,
      title: page.title,
      content: markdownContent,
      contentType: "text",
      url: webUrl,
      author: page.version?.by?.displayName || page.history?.createdBy?.displayName,
      createdAt: page.history?.createdDate,
      updatedAt: page.version?.when,
      metadata: {
        pageId: page.id,
        labels,
        version: page.version?.number,
        docType,
        sectionsCount: processed.sections.length,
        sections: processed.sections.map(s => s.heading).filter(Boolean),
        crossReferences: processed.crossReferences.map(r => r.rawPath),
        imageReferences: imageRefs.length > 0 ? imageRefs : undefined,
        hasAttachments: (page.children?.attachment?.results?.length || 0) > 0,
        attachmentCount: page.children?.attachment?.results?.length || 0,
      },
      images: images.length > 0 ? images : undefined,
    };
  }

  /**
   * Convert Confluence storage format (XHTML-like) to markdown.
   * Handles common elements: headings, paragraphs, lists, tables, code blocks, links.
   */
  private storageToMarkdown(html: string): string {
    if (!html) return "";

    let md = html;

    // Code blocks: <ac:structured-macro ac:name="code">...<ac:plain-text-body><![CDATA[...]]></ac:plain-text-body>
    md = md.replace(
      /<ac:structured-macro[^>]*ac:name="code"[^>]*>[\s\S]*?<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/gi,
      (_, code) => `\n\`\`\`\n${code}\n\`\`\`\n`
    );

    // Info/note/warning panels
    md = md.replace(
      /<ac:structured-macro[^>]*ac:name="(info|note|warning|tip)"[^>]*>[\s\S]*?<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>[\s\S]*?<\/ac:structured-macro>/gi,
      (_, type, body) => `\n> **${type.toUpperCase()}:** ${body.trim()}\n`
    );

    // Remove remaining Confluence macros
    md = md.replace(/<ac:structured-macro[\s\S]*?<\/ac:structured-macro>/gi, "");
    md = md.replace(/<ac:[^>]*\/>/gi, "");
    md = md.replace(/<ac:[^>]*>[\s\S]*?<\/ac:[^>]*>/gi, "");
    md = md.replace(/<ri:[^>]*\/>/gi, "");
    md = md.replace(/<ri:[^>]*>[\s\S]*?<\/ri:[^>]*>/gi, "");

    // Headings
    md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
    md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
    md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
    md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
    md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n");
    md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n");

    // Bold and italic
    md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
    md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");
    md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*");
    md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*");

    // Inline code
    md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

    // Links
    md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");

    // Lists
    md = md.replace(/<ul[^>]*>/gi, "\n");
    md = md.replace(/<\/ul>/gi, "\n");
    md = md.replace(/<ol[^>]*>/gi, "\n");
    md = md.replace(/<\/ol>/gi, "\n");
    md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");

    // Tables
    md = md.replace(/<table[^>]*>/gi, "\n");
    md = md.replace(/<\/table>/gi, "\n");
    md = md.replace(/<thead[^>]*>/gi, "");
    md = md.replace(/<\/thead>/gi, "");
    md = md.replace(/<tbody[^>]*>/gi, "");
    md = md.replace(/<\/tbody>/gi, "");
    md = md.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
      const cells = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [];
      const cellValues = cells.map((c: string) =>
        c.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/i, "$1").trim()
      );
      return `| ${cellValues.join(" | ")} |\n`;
    });

    // Paragraphs and breaks
    md = md.replace(/<br\s*\/?>/gi, "\n");
    md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
    md = md.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, "\n$1\n");

    // Strip remaining HTML tags
    md = md.replace(/<[^>]+>/g, "");

    // Decode HTML entities
    md = md.replace(/&amp;/g, "&");
    md = md.replace(/&lt;/g, "<");
    md = md.replace(/&gt;/g, ">");
    md = md.replace(/&quot;/g, '"');
    md = md.replace(/&#39;/g, "'");
    md = md.replace(/&nbsp;/g, " ");

    // Clean up excessive whitespace
    md = md.replace(/\n{3,}/g, "\n\n");

    return md.trim();
  }

  /**
   * Extract image references from Confluence storage format.
   */
  private extractImageReferences(html: string): string[] {
    const refs: string[] = [];

    // <ac:image> tags with attachment references
    const imageRegex = /<ac:image[^>]*>[\s\S]*?<ri:attachment ri:filename="([^"]*)"[\s\S]*?<\/ac:image>/gi;
    let match: RegExpExecArray | null;
    while ((match = imageRegex.exec(html)) !== null) {
      refs.push(match[1]);
    }

    // Standard <img> tags
    const imgRegex = /<img[^>]*src="([^"]*)"[^>]*>/gi;
    while ((match = imgRegex.exec(html)) !== null) {
      refs.push(match[1]);
    }

    return refs;
  }

  private shouldExclude(page: ConfluencePage): boolean {
    if (!this.exclude) return false;

    const labels = page.metadata?.labels?.results?.map((l) => l.name) || [];

    if (this.exclude.label?.some((l) => labels.includes(l))) return true;
    if (this.exclude.title?.some((t) => page.title.toLowerCase().includes(t.toLowerCase()))) return true;

    return false;
  }

  private extractPageIdFromUrl(url: string): string | null {
    // Confluence URLs: /pages/viewpage.action?pageId=12345 or /wiki/spaces/SPACE/pages/12345/Title
    const idMatch = url.match(/pageId=(\d+)/);
    if (idMatch) return idMatch[1];

    const pathMatch = url.match(/\/pages\/(\d+)/);
    if (pathMatch) return pathMatch[1];

    return null;
  }

  private async apiGet(path: string): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (this.email) {
      headers["Authorization"] = `Basic ${Buffer.from(`${this.email}:${this.token}`).toString("base64")}`;
    } else {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    return resilientFetch(url, { headers });
  }
}
