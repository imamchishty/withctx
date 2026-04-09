import type {
  TextChunk,
  SearchResult,
  VectorStore,
  VectorStoreConfig,
  EmbeddingProvider,
} from "../types/vector.js";
import { chunkDocument } from "./chunker.js";
import { createEmbeddingProvider } from "./embeddings/index.js";
import { createVectorStore } from "./stores/index.js";
import { CtxDirectory } from "../storage/ctx-dir.js";
import { PageManager } from "../wiki/pages.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface VectorManagerOptions {
  config?: Partial<VectorStoreConfig>;
  ctxDir: CtxDirectory;
}

export interface EmbedStats {
  totalChunks: number;
  pagesEmbedded: number;
  storeType: string;
  embeddingProvider: string;
  dimensions: number;
  lastEmbeddedAt: string;
}

interface EmbedMeta {
  lastEmbeddedAt: string;
  pages: Record<string, { updatedAt: string; chunkCount: number }>;
}

/**
 * Main vector manager — orchestrates chunking, embedding, and search.
 */
export class VectorManager {
  private ctxDir: CtxDirectory;
  private config: Partial<VectorStoreConfig>;
  private store: VectorStore | null = null;
  private embedder: EmbeddingProvider | null = null;
  private metaPath: string;

  constructor(options: VectorManagerOptions) {
    this.ctxDir = options.ctxDir;
    this.config = options.config ?? {};
    this.metaPath = join(this.ctxDir.path, "vector", "meta.json");
  }

  /**
   * Initialize embedding provider and vector store.
   */
  async initialize(): Promise<void> {
    this.embedder = await createEmbeddingProvider(this.config);
    this.store = await createVectorStore(this.config, this.embedder, this.ctxDir.path);
  }

  /**
   * Embed all wiki pages.
   */
  async embedAll(
    onProgress?: (page: string, index: number, total: number) => void
  ): Promise<EmbedStats> {
    await this.ensureInitialized();

    const pageManager = new PageManager(this.ctxDir);
    const allPages = pageManager.list();
    const meta = this.readMeta();

    let totalChunks = 0;

    for (let i = 0; i < allPages.length; i++) {
      const pagePath = allPages[i];
      if (pagePath === "log.md") continue;

      onProgress?.(pagePath, i, allPages.length);

      const page = pageManager.read(pagePath);
      if (!page) continue;

      const chunks = chunkDocument(
        page.content,
        pagePath,
        "wiki",
        page.title
      );

      if (chunks.length > 0) {
        await this.store!.addChunks(chunks);
        totalChunks += chunks.length;

        meta.pages[pagePath] = {
          updatedAt: page.updatedAt,
          chunkCount: chunks.length,
        };
      }
    }

    meta.lastEmbeddedAt = new Date().toISOString();
    this.writeMeta(meta);

    return {
      totalChunks,
      pagesEmbedded: allPages.filter((p) => p !== "log.md").length,
      storeType: this.getStoreType(),
      embeddingProvider: this.getEmbeddingProviderName(),
      dimensions: this.embedder!.dimensions,
      lastEmbeddedAt: meta.lastEmbeddedAt,
    };
  }

  /**
   * Embed a single page (for incremental updates).
   */
  async embedPage(pagePath: string): Promise<number> {
    await this.ensureInitialized();

    const pageManager = new PageManager(this.ctxDir);
    const page = pageManager.read(pagePath);
    if (!page) return 0;

    // Delete old chunks for this page
    await this.store!.deleteBySource(pagePath);

    const chunks = chunkDocument(page.content, pagePath, "wiki", page.title);

    if (chunks.length > 0) {
      await this.store!.addChunks(chunks);
    }

    // Update meta
    const meta = this.readMeta();
    meta.pages[pagePath] = {
      updatedAt: page.updatedAt,
      chunkCount: chunks.length,
    };
    meta.lastEmbeddedAt = new Date().toISOString();
    this.writeMeta(meta);

    return chunks.length;
  }

  /**
   * Re-embed only pages changed since last embedding.
   */
  async refresh(
    onProgress?: (page: string, index: number, total: number) => void
  ): Promise<{ updated: number; skipped: number; totalChunks: number }> {
    await this.ensureInitialized();

    const pageManager = new PageManager(this.ctxDir);
    const allPages = pageManager.list();
    const meta = this.readMeta();

    let updated = 0;
    let skipped = 0;
    let totalChunks = 0;

    for (let i = 0; i < allPages.length; i++) {
      const pagePath = allPages[i];
      if (pagePath === "log.md") continue;

      const page = pageManager.read(pagePath);
      if (!page) continue;

      const existing = meta.pages[pagePath];

      // Skip if page hasn't changed
      if (existing && existing.updatedAt === page.updatedAt) {
        skipped++;
        totalChunks += existing.chunkCount;
        continue;
      }

      onProgress?.(pagePath, updated, allPages.length);

      await this.store!.deleteBySource(pagePath);

      const chunks = chunkDocument(page.content, pagePath, "wiki", page.title);

      if (chunks.length > 0) {
        await this.store!.addChunks(chunks);
        totalChunks += chunks.length;
      }

      meta.pages[pagePath] = {
        updatedAt: page.updatedAt,
        chunkCount: chunks.length,
      };

      updated++;
    }

    meta.lastEmbeddedAt = new Date().toISOString();
    this.writeMeta(meta);

    return { updated, skipped, totalChunks };
  }

  /**
   * Search across all embedded content.
   */
  async search(
    query: string,
    options?: { limit?: number; threshold?: number; filter?: Record<string, string> }
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();

    const limit = options?.limit ?? 5;
    const threshold = options?.threshold ?? 0;

    const results = await this.store!.search(query, limit, options?.filter);

    // Filter by threshold
    return results.filter((r) => r.score >= threshold);
  }

  /**
   * Get embedding stats.
   */
  async getStats(): Promise<EmbedStats> {
    await this.ensureInitialized();

    const meta = this.readMeta();
    const totalChunks = await this.store!.count();

    return {
      totalChunks,
      pagesEmbedded: Object.keys(meta.pages).length,
      storeType: this.getStoreType(),
      embeddingProvider: this.getEmbeddingProviderName(),
      dimensions: this.embedder!.dimensions,
      lastEmbeddedAt: meta.lastEmbeddedAt,
    };
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.store || !this.embedder) {
      await this.initialize();
    }
  }

  private readMeta(): EmbedMeta {
    if (existsSync(this.metaPath)) {
      try {
        return JSON.parse(readFileSync(this.metaPath, "utf-8"));
      } catch {
        // Corrupted meta
      }
    }
    return { lastEmbeddedAt: "", pages: {} };
  }

  private writeMeta(meta: EmbedMeta): void {
    const dir = dirname(this.metaPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.metaPath, JSON.stringify(meta, null, 2));
  }

  private getStoreType(): string {
    if (!this.store) return "unknown";
    return this.store.constructor.name === "ChromaVectorStore" ? "chroma" : "memory";
  }

  private getEmbeddingProviderName(): string {
    if (!this.config.embeddingProvider) {
      return process.env.OPENAI_API_KEY ? "openai" : "local";
    }
    return this.config.embeddingProvider;
  }
}
