import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { CtxDirectory } from "./ctx-dir.js";
import type { RawDocument, SourceType } from "../types/source.js";

interface SourceMeta {
  name: string;
  type: SourceType;
  lastSyncAt: string;
  documentCount: number;
}

interface SourceIndex {
  sources: Record<string, SourceMeta>;
}

/**
 * Manages the .ctx/sources/ directory.
 * Caches raw documents for incremental sync and tracks last sync time.
 */
export class SourceCacheManager {
  private ctx: CtxDirectory;
  private indexPath: string;

  constructor(ctx: CtxDirectory) {
    this.ctx = ctx;
    this.indexPath = join(ctx.sourcesPath, "index.json");
  }

  /**
   * Ensure the sources directory exists.
   */
  initialize(): void {
    mkdirSync(this.ctx.sourcesPath, { recursive: true });
    if (!existsSync(this.indexPath)) {
      this.writeIndex({ sources: {} });
    }
  }

  /**
   * Cache a raw document from a source.
   */
  cacheDocument(doc: RawDocument): void {
    const sourceDir = join(this.ctx.sourcesPath, sanitizeName(doc.sourceName));
    mkdirSync(sourceDir, { recursive: true });

    const docPath = join(sourceDir, `${sanitizeName(doc.id)}.json`);
    // Strip binary image data before caching
    const cacheable = {
      ...doc,
      images: doc.images?.map((img) => ({
        name: img.name,
        mimeType: img.mimeType,
        dataLength: img.data.length,
      })),
    };
    writeFileSync(docPath, JSON.stringify(cacheable, null, 2));
  }

  /**
   * Read a cached document.
   */
  readCachedDocument(
    sourceName: string,
    docId: string
  ): RawDocument | null {
    const docPath = join(
      this.ctx.sourcesPath,
      sanitizeName(sourceName),
      `${sanitizeName(docId)}.json`
    );
    if (!existsSync(docPath)) return null;

    try {
      return JSON.parse(readFileSync(docPath, "utf-8"));
    } catch {
      return null;
    }
  }

  /**
   * List all cached document IDs for a source.
   */
  listCachedDocuments(sourceName: string): string[] {
    const sourceDir = join(this.ctx.sourcesPath, sanitizeName(sourceName));
    if (!existsSync(sourceDir)) return [];

    return readdirSync(sourceDir)
      .filter((f) => f.endsWith(".json") && f !== "index.json")
      .map((f) => f.replace(/\.json$/, ""));
  }

  /**
   * Update the last sync time for a source.
   */
  updateSyncTime(
    sourceName: string,
    sourceType: SourceType,
    documentCount: number
  ): void {
    const index = this.readIndex();
    index.sources[sourceName] = {
      name: sourceName,
      type: sourceType,
      lastSyncAt: new Date().toISOString(),
      documentCount,
    };
    this.writeIndex(index);
  }

  /**
   * Get the last sync time for a source.
   */
  getLastSyncTime(sourceName: string): string | null {
    const index = this.readIndex();
    return index.sources[sourceName]?.lastSyncAt ?? null;
  }

  /**
   * Get metadata for all sources.
   */
  getAllSourceMeta(): Record<string, SourceMeta> {
    return this.readIndex().sources;
  }

  /**
   * Get a map of source name to last sync ISO timestamp.
   * Useful for staleness checks.
   */
  getSourceFreshnessMap(): Record<string, string> {
    const index = this.readIndex();
    const map: Record<string, string> = {};
    for (const [name, meta] of Object.entries(index.sources)) {
      map[name] = meta.lastSyncAt;
    }
    return map;
  }

  private readIndex(): SourceIndex {
    if (!existsSync(this.indexPath)) {
      return { sources: {} };
    }
    try {
      return JSON.parse(readFileSync(this.indexPath, "utf-8"));
    } catch {
      return { sources: {} };
    }
  }

  private writeIndex(index: SourceIndex): void {
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
  }
}

/**
 * Sanitize a name for use as a filename.
 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}
