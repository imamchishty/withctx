import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { VectorStore, TextChunk, SearchResult, EmbeddingProvider } from "../../types/vector.js";

interface StoredChunk {
  id: string;
  content: string;
  metadata: TextChunk["metadata"];
  embedding: number[];
}

interface PersistentIndex {
  version: number;
  createdAt: string;
  updatedAt: string;
  chunks: StoredChunk[];
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * In-memory vector store with JSON persistence.
 * Zero external dependencies — works with no setup.
 * Persists to .ctx/vector/index.json.
 */
export class MemoryVectorStore implements VectorStore {
  private chunks: StoredChunk[] = [];
  private embeddingProvider: EmbeddingProvider;
  private persistPath: string;

  constructor(ctxDirPath: string, embeddingProvider: EmbeddingProvider) {
    this.embeddingProvider = embeddingProvider;
    this.persistPath = join(ctxDirPath, "vector", "index.json");
  }

  async initialize(): Promise<void> {
    // Load from disk if available
    if (existsSync(this.persistPath)) {
      try {
        const raw = readFileSync(this.persistPath, "utf-8");
        const index: PersistentIndex = JSON.parse(raw);
        this.chunks = index.chunks ?? [];
      } catch {
        // Corrupted index — start fresh
        this.chunks = [];
      }
    }
  }

  async addChunks(chunks: TextChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const texts = chunks.map((c) => c.content);
    const embeddings = await this.embeddingProvider.embed(texts);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const existing = this.chunks.findIndex((c) => c.id === chunk.id);

      const stored: StoredChunk = {
        id: chunk.id,
        content: chunk.content,
        metadata: chunk.metadata,
        embedding: embeddings[i],
      };

      if (existing >= 0) {
        this.chunks[existing] = stored;
      } else {
        this.chunks.push(stored);
      }
    }

    this.persist();
  }

  async search(
    query: string,
    limit: number = 5,
    filter?: Record<string, string>
  ): Promise<SearchResult[]> {
    if (this.chunks.length === 0) return [];

    const queryEmbedding = await this.embeddingProvider.embedQuery(query);

    let candidates = this.chunks;

    // Apply filters
    if (filter) {
      candidates = candidates.filter((chunk) => {
        for (const [key, value] of Object.entries(filter)) {
          const metaValue = (chunk.metadata as unknown as Record<string, unknown>)[key];
          if (String(metaValue) !== value) return false;
        }
        return true;
      });
    }

    // Score all candidates
    const scored = candidates.map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }));

    // Sort by score descending and take top N
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(({ chunk, score }) => ({
      chunk: {
        id: chunk.id,
        content: chunk.content,
        metadata: chunk.metadata,
      },
      score: Math.max(0, Math.min(1, score)),
      page: chunk.metadata.source,
    }));
  }

  async deleteBySource(source: string): Promise<void> {
    this.chunks = this.chunks.filter((c) => c.metadata.source !== source);
    this.persist();
  }

  async count(): Promise<number> {
    return this.chunks.length;
  }

  async clear(): Promise<void> {
    this.chunks = [];
    this.persist();
  }

  private persist(): void {
    const dir = dirname(this.persistPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const index: PersistentIndex = {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chunks: this.chunks,
    };

    writeFileSync(this.persistPath, JSON.stringify(index));
  }
}
