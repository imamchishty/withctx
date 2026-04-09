import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";
import type { JiraSource } from "../types/config.js";
import { resilientFetch } from "./resilient-fetch.js";

interface JiraIssue {
  key: string;
  id: string;
  self: string;
  fields: {
    summary: string;
    description: string | null;
    status: { name: string };
    issuetype: { name: string };
    priority?: { name: string };
    assignee?: { displayName: string; emailAddress?: string } | null;
    reporter?: { displayName: string; emailAddress?: string } | null;
    labels: string[];
    components: Array<{ name: string }>;
    fixVersions: Array<{ name: string }>;
    created: string;
    updated: string;
    resolution?: { name: string } | null;
    parent?: { key: string; fields?: { summary?: string } };
    comment?: {
      comments: Array<{
        author: { displayName: string };
        body: string;
        created: string;
        updated: string;
      }>;
      total: number;
    };
    issuelinks?: Array<{
      type: { name: string; inward: string; outward: string };
      inwardIssue?: { key: string; fields?: { summary?: string } };
      outwardIssue?: { key: string; fields?: { summary?: string } };
    }>;
  };
}

interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
  startAt: number;
  maxResults: number;
}

/**
 * Connector for Jira.
 * Uses Atlassian REST API v2 (fetch-based, no SDK).
 * Supports JQL queries, project/epic/component filtering.
 */
export class JiraConnector implements SourceConnector {
  readonly type = "jira" as const;
  readonly name: string;
  private baseUrl: string;
  private email?: string;
  private token: string;
  private project?: string;
  private jql?: string;
  private epic?: string;
  private component?: string;
  private exclude?: {
    type?: string[];
    status?: string[];
    label?: string[];
  };
  private status: SourceStatus;

  constructor(config: JiraSource) {
    this.name = config.name;
    this.baseUrl = config.base_url.replace(/\/$/, "");
    this.email = config.email;
    this.token = config.token;
    this.project = config.project;
    this.jql = config.jql;
    this.epic = config.epic;
    this.component = config.component;
    this.exclude = config.exclude;
    this.status = {
      name: config.name,
      type: "jira",
      status: "disconnected",
    };
  }

  async validate(): Promise<boolean> {
    try {
      const response = await this.apiGet("/rest/api/2/myself");
      if (response.ok) {
        this.status.status = "connected";
        return true;
      }
      this.status.status = "error";
      this.status.error = `Jira auth failed: HTTP ${response.status}`;
      return false;
    } catch (error) {
      this.status.status = "error";
      this.status.error = `Failed to connect to Jira: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";
    let count = 0;

    try {
      const jql = this.buildJql(options?.since);
      const fields = [
        "summary", "description", "status", "issuetype", "priority",
        "assignee", "reporter", "labels", "components", "fixVersions",
        "created", "updated", "resolution", "parent", "comment", "issuelinks",
      ].join(",");

      let startAt = 0;
      const maxResults = 50;
      let total = Infinity;

      while (startAt < total) {
        const response = await this.apiGet(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=${fields}&startAt=${startAt}&maxResults=${maxResults}`
        );

        if (!response.ok) {
          throw new Error(`Jira search failed: HTTP ${response.status} — ${await response.text()}`);
        }

        const data = await response.json() as JiraSearchResponse;
        total = data.total;

        for (const issue of data.issues) {
          // Apply exclusion filters
          if (this.shouldExclude(issue)) continue;

          count++;
          yield this.issueToDocument(issue);
          if (options?.limit && count >= options.limit) break;
        }

        if (options?.limit && count >= options.limit) break;
        startAt += maxResults;
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

  private buildJql(since?: Date): string {
    // If user provided raw JQL, use that as the base
    if (this.jql) {
      let jql = this.jql;
      if (since) {
        jql += ` AND updated >= "${this.formatJiraDate(since)}"`;
      }
      return jql;
    }

    const clauses: string[] = [];

    if (this.project) {
      clauses.push(`project = "${this.project}"`);
    }
    if (this.epic) {
      clauses.push(`"Epic Link" = "${this.epic}" OR parent = "${this.epic}"`);
    }
    if (this.component) {
      clauses.push(`component = "${this.component}"`);
    }
    if (since) {
      clauses.push(`updated >= "${this.formatJiraDate(since)}"`);
    }

    const jql = clauses.length > 0 ? clauses.join(" AND ") : "ORDER BY updated DESC";
    return clauses.length > 0 ? `${jql} ORDER BY updated DESC` : jql;
  }

  private formatJiraDate(date: Date): string {
    return date.toISOString().split("T")[0];
  }

  private shouldExclude(issue: JiraIssue): boolean {
    if (!this.exclude) return false;

    if (this.exclude.type?.includes(issue.fields.issuetype.name)) return true;
    if (this.exclude.status?.includes(issue.fields.status.name)) return true;
    if (this.exclude.label?.some((l) => issue.fields.labels.includes(l))) return true;

    return false;
  }

  private issueToDocument(issue: JiraIssue): RawDocument {
    const f = issue.fields;

    // Build structured content
    const parts: string[] = [];
    parts.push(`# ${issue.key}: ${f.summary}`);
    parts.push("");
    parts.push(`**Type:** ${f.issuetype.name}`);
    parts.push(`**Status:** ${f.status.name}`);
    if (f.priority) parts.push(`**Priority:** ${f.priority.name}`);
    if (f.assignee) parts.push(`**Assignee:** ${f.assignee.displayName}`);
    if (f.reporter) parts.push(`**Reporter:** ${f.reporter.displayName}`);
    if (f.labels.length > 0) parts.push(`**Labels:** ${f.labels.join(", ")}`);
    if (f.components.length > 0) parts.push(`**Components:** ${f.components.map((c) => c.name).join(", ")}`);
    if (f.fixVersions.length > 0) parts.push(`**Fix Versions:** ${f.fixVersions.map((v) => v.name).join(", ")}`);
    if (f.resolution) parts.push(`**Resolution:** ${f.resolution.name}`);
    if (f.parent) parts.push(`**Parent:** ${f.parent.key}${f.parent.fields?.summary ? ` — ${f.parent.fields.summary}` : ""}`);

    parts.push("");
    parts.push("## Description");
    parts.push(f.description || "(no description)");

    // Links
    if (f.issuelinks && f.issuelinks.length > 0) {
      parts.push("");
      parts.push("## Links");
      for (const link of f.issuelinks) {
        if (link.outwardIssue) {
          parts.push(`- ${link.type.outward}: ${link.outwardIssue.key}${link.outwardIssue.fields?.summary ? ` — ${link.outwardIssue.fields.summary}` : ""}`);
        }
        if (link.inwardIssue) {
          parts.push(`- ${link.type.inward}: ${link.inwardIssue.key}${link.inwardIssue.fields?.summary ? ` — ${link.inwardIssue.fields.summary}` : ""}`);
        }
      }
    }

    // Comments
    if (f.comment && f.comment.comments.length > 0) {
      parts.push("");
      parts.push("## Comments");
      for (const comment of f.comment.comments) {
        parts.push("");
        parts.push(`**${comment.author.displayName}** (${comment.created}):`);
        parts.push(comment.body);
      }
    }

    return {
      id: `jira:${this.name}:${issue.key}`,
      sourceType: "jira",
      sourceName: this.name,
      title: `${issue.key}: ${f.summary}`,
      content: parts.join("\n"),
      contentType: "text",
      url: `${this.baseUrl}/browse/${issue.key}`,
      author: f.reporter?.displayName,
      createdAt: f.created,
      updatedAt: f.updated,
      metadata: {
        key: issue.key,
        issueType: f.issuetype.name,
        status: f.status.name,
        priority: f.priority?.name,
        assignee: f.assignee?.displayName,
        labels: f.labels,
        components: f.components.map((c) => c.name),
        commentCount: f.comment?.total || 0,
        linkCount: f.issuelinks?.length || 0,
      },
    };
  }

  private async apiGet(path: string): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (this.email) {
      // Atlassian Cloud: Basic auth with email:token
      headers["Authorization"] = `Basic ${Buffer.from(`${this.email}:${this.token}`).toString("base64")}`;
    } else {
      // Jira Server/Data Center: Bearer token
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    return resilientFetch(url, { headers });
  }
}
