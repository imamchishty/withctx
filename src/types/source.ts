export type SourceType =
  | "local"
  | "pdf"
  | "word"
  | "powerpoint"
  | "excel"
  | "github"
  | "jira"
  | "confluence"
  | "teams"
  | "sharepoint"
  | "cicd"
  | "coverage"
  | "pull-requests";

export interface SourceStatus {
  name: string;
  type: SourceType;
  status: "connected" | "syncing" | "error" | "disconnected";
  lastSyncAt?: string;
  itemCount?: number;
  error?: string;
}

export interface RawDocument {
  id: string;
  sourceType: SourceType;
  sourceName: string;
  title: string;
  content: string;
  contentType: "text" | "code" | "html" | "binary";
  url?: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata: Record<string, unknown>;
  images?: Array<{
    name: string;
    data: Buffer;
    mimeType: string;
  }>;
}

export interface FetchOptions {
  since?: Date;
  types?: string[];
  limit?: number;
}
