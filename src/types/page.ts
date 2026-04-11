import type { PageMetadata } from "../wiki/metadata.js";

export interface WikiPage {
  path: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  sources: string[];
  references: string[];
  /**
   * Parsed `ctx` front-matter. Empty object when the page predates the
   * freshness-header system or has no metadata block.
   */
  meta?: PageMetadata;
}

export interface IndexEntry {
  path: string;
  title: string;
  summary: string;
  updatedAt: string;
}

export interface LogEntry {
  timestamp: string;
  action: "ingest" | "sync" | "add" | "lint" | "compile" | "prune";
  detail: string;
  pagesAffected?: string[];
}

export interface LintIssue {
  type: "contradiction" | "stale" | "orphan" | "missing" | "bless-drift" | "unblessed";
  severity: "warning" | "error";
  page: string;
  message: string;
  relatedPage?: string;
  suggestion?: string;
}

export interface LintReport {
  timestamp: string;
  pagesChecked: number;
  issues: LintIssue[];
  summary: {
    contradictions: number;
    stale: number;
    orphans: number;
    missing: number;
    /** Pages blessed at an old git sha whose tree has since changed. */
    blessDrift: number;
  };
}

export interface QueryResult {
  answer: string;
  sources: Array<{
    page: string;
    relevance: number;
  }>;
  tokenCount: number;
}

export interface PackOptions {
  format: "claude-md" | "system-prompt" | "markdown";
  budget?: number;
  scope?: string;
  query?: string;
  output?: string;
}

export interface ExportResult {
  format: string;
  content: string;
  tokenCount: number;
  pagesIncluded: number;
}
