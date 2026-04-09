import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";
import type { NotionSource } from "../types/config.js";

interface NotionBlock {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface NotionPage {
  id: string;
  created_time: string;
  last_edited_time: string;
  properties: Record<string, NotionProperty>;
  url: string;
}

interface NotionProperty {
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  number?: number | null;
  select?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
  date?: { start: string; end?: string } | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  [key: string]: unknown;
}

interface NotionListResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

interface NotionBlocksResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export class NotionConnector implements SourceConnector {
  readonly type = "notion" as const;
  readonly name: string;
  private token: string;
  private databaseIds: string[];
  private pageIds: string[];
  private status: SourceStatus;

  constructor(config: NotionSource) {
    this.name = config.name;
    this.token = config.token || process.env.NOTION_TOKEN || "";
    this.databaseIds = config.database_ids || [];
    this.pageIds = config.page_ids || [];
    this.status = { name: config.name, type: "notion", status: "disconnected" };
  }

  async validate(): Promise<boolean> {
    if (!this.token) {
      this.status.status = "error";
      this.status.error = "No Notion token. Set NOTION_TOKEN or add token to ctx.yaml.";
      return false;
    }
    try {
      const response = await fetch(`${NOTION_API_BASE}/users/me`, {
        headers: this.getHeaders(),
      });
      if (!response.ok) {
        this.status.status = "error";
        this.status.error = `Notion API returned ${response.status}`;
        return false;
      }
      this.status.status = "connected";
      return true;
    } catch (error) {
      this.status.status = "error";
      this.status.error = `Cannot reach Notion API: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";
    let count = 0;
    try {
      for (const dbId of this.databaseIds) {
        const pages = await this.queryDatabase(dbId, options?.since);
        for (const page of pages) {
          if (options?.limit && count >= options.limit) break;
          const doc = await this.pageToDocument(page);
          if (doc) { count++; yield doc; }
        }
      }
      for (const pageId of this.pageIds) {
        if (options?.limit && count >= options.limit) break;
        try {
          const page = await this.fetchPage(pageId);
          if (options?.since && new Date(page.last_edited_time) <= options.since) continue;
          const doc = await this.pageToDocument(page);
          if (doc) { count++; yield doc; }
        } catch (error) {
          process.stderr.write(`[withctx] Warning: Failed to fetch Notion page ${pageId}: ${error instanceof Error ? error.message : String(error)}\n`);
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

  getStatus(): SourceStatus { return { ...this.status }; }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    };
  }

  private async queryDatabase(databaseId: string, since?: Date): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let cursor: string | null = null;
    do {
      const body: Record<string, unknown> = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      if (since) {
        body.filter = { timestamp: "last_edited_time", last_edited_time: { after: since.toISOString() } };
      }
      const response = await fetch(`${NOTION_API_BASE}/databases/${databaseId}/query`, {
        method: "POST", headers: this.getHeaders(), body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Notion database query failed (${response.status})`);
      const data = (await response.json()) as NotionListResponse;
      pages.push(...data.results);
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return pages;
  }

  private async fetchPage(pageId: string): Promise<NotionPage> {
    const response = await fetch(`${NOTION_API_BASE}/pages/${pageId}`, { headers: this.getHeaders() });
    if (!response.ok) throw new Error(`Notion page fetch failed (${response.status})`);
    return (await response.json()) as NotionPage;
  }

  private async fetchBlocks(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | null = null;
    do {
      const url = cursor
        ? `${NOTION_API_BASE}/blocks/${blockId}/children?start_cursor=${cursor}`
        : `${NOTION_API_BASE}/blocks/${blockId}/children`;
      const response = await fetch(url, { headers: this.getHeaders() });
      if (!response.ok) throw new Error(`Notion blocks fetch failed (${response.status})`);
      const data = (await response.json()) as NotionBlocksResponse;
      blocks.push(...data.results);
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return blocks;
  }

  private async pageToDocument(page: NotionPage): Promise<RawDocument | null> {
    const title = this.extractTitle(page);
    const blocks = await this.fetchBlocks(page.id);
    const content = this.blocksToMarkdown(blocks);
    if (!content.trim()) return null;
    const propsMarkdown = this.propertiesToMarkdown(page.properties);
    const fullContent = propsMarkdown ? `# ${title}\n\n${propsMarkdown}\n\n${content}` : `# ${title}\n\n${content}`;
    return {
      id: `notion:${this.name}:${page.id}`,
      sourceType: "notion", sourceName: this.name, title,
      content: fullContent, contentType: "text", url: page.url,
      createdAt: page.created_time, updatedAt: page.last_edited_time,
      metadata: { notionPageId: page.id },
    };
  }

  private extractTitle(page: NotionPage): string {
    for (const prop of Object.values(page.properties)) {
      if (prop.type === "title" && prop.title) return prop.title.map((t) => t.plain_text).join("") || "Untitled";
    }
    return "Untitled";
  }

  private propertiesToMarkdown(properties: Record<string, NotionProperty>): string {
    const lines: string[] = [];
    for (const [name, prop] of Object.entries(properties)) {
      if (prop.type === "title") continue;
      const value = this.propertyValue(prop);
      if (value) lines.push(`- **${name}:** ${value}`);
    }
    return lines.join("\n");
  }

  private propertyValue(prop: NotionProperty): string {
    switch (prop.type) {
      case "rich_text": return prop.rich_text?.map((t) => t.plain_text).join("") || "";
      case "number": return prop.number != null ? String(prop.number) : "";
      case "select": return prop.select?.name || "";
      case "multi_select": return prop.multi_select?.map((s) => s.name).join(", ") || "";
      case "date": return prop.date ? (prop.date.end ? `${prop.date.start} → ${prop.date.end}` : prop.date.start) : "";
      case "checkbox": return prop.checkbox ? "Yes" : "No";
      case "url": return prop.url || "";
      case "email": return prop.email || "";
      default: return "";
    }
  }

  private blocksToMarkdown(blocks: NotionBlock[]): string {
    return blocks.map((b) => this.blockToMarkdown(b)).filter(Boolean).join("\n\n");
  }

  private blockToMarkdown(block: NotionBlock): string {
    const data = block[block.type] as Record<string, unknown> | undefined;
    if (!data) return "";
    const rt = (key: string) => this.richTextToString(
      (data as Record<string, unknown>)[key] as Array<{ plain_text: string }> | undefined
    );
    switch (block.type) {
      case "paragraph": return rt("rich_text");
      case "heading_1": return `# ${rt("rich_text")}`;
      case "heading_2": return `## ${rt("rich_text")}`;
      case "heading_3": return `### ${rt("rich_text")}`;
      case "bulleted_list_item": return `- ${rt("rich_text")}`;
      case "numbered_list_item": return `1. ${rt("rich_text")}`;
      case "to_do": return `- [${data.checked ? "x" : " "}] ${rt("rich_text")}`;
      case "code": return `\`\`\`${(data.language as string) || ""}\n${rt("rich_text")}\n\`\`\``;
      case "quote": case "callout": return `> ${rt("rich_text")}`;
      case "divider": return "---";
      default: return "";
    }
  }

  private richTextToString(richText: Array<{ plain_text: string }> | undefined): string {
    if (!richText) return "";
    return richText.map((t) => t.plain_text).join("");
  }
}
