import type { VectorStore, TextChunk, SearchResult, VectorStoreConfig, EmbeddingProvider } from "../../types/vector.js";

/**
 * ChromaDB vector store implementation.
 * Requires a running Chroma instance (default http://localhost:8000).
 */
export class ChromaVectorStore implements VectorStore {
  private config: VectorStoreConfig;
  private embeddingProvider: EmbeddingProvider;
  private client: any;
  private collection: any;

  constructor(config: VectorStoreConfig, embeddingProvider: EmbeddingProvider) {
    this.config = config;
    this.embeddingProvider = embeddingProvider;
  }

  async initialize(): Promise<void> {
    const { ChromaClient } = await import("chromadb");
    const url = this.config.chromaUrl ?? "http://localhost:8000";

    this.client = new ChromaClient({ path: url });
    this.collection = await this.client.getOrCreateCollection({
      name: this.config.collectionName ?? "withctx",
      metadata: { "hnsw:space": "cosine" },
    });
  }

  async addChunks(chunks: TextChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const texts = chunks.map((c) => c.content);
    const embeddings = await this.embeddingProvider.embed(texts);

    const ids = chunks.map((c) => c.id);
    const documents = texts;
    const metadatas = chunks.map((c) => ({
      source: c.metadata.source,
      sourceType: c.metadata.sourceType,
      title: c.metadata.title,
      section: c.metadata.section ?? "",
      filePath: c.metadata.filePath ?? "",
      lastUpdated: c.metadata.lastUpdated,
      chunkIndex: c.metadata.chunkIndex,
      totalChunks: c.metadata.totalChunks,
    }));

    // Chroma has batch limits, process in chunks of 500
    const batchSize = 500;
    for (let i = 0; i < ids.length; i += batchSize) {
      const end = Math.min(i + batchSize, ids.length);
      await this.collection.upsert({
        ids: ids.slice(i, end),
        documents: documents.slice(i, end),
        embeddings: embeddings.slice(i, end),
        metadatas: metadatas.slice(i, end),
      });
    }
  }

  async search(
    query: string,
    limit: number = 5,
    filter?: Record<string, string>
  ): Promise<SearchResult[]> {
    const queryEmbedding = await this.embeddingProvider.embedQuery(query);

    const where = filter
      ? Object.entries(filter).reduce(
          (acc, [key, value]) => ({ ...acc, [key]: value }),
          {} as Record<string, string>
        )
      : undefined;

    const results = await this.collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit,
      where: where && Object.keys(where).length > 0 ? where : undefined,
    });

    if (!results.ids || results.ids.length === 0 || results.ids[0].length === 0) {
      return [];
    }

    return results.ids[0].map((id: string, idx: number) => {
      const metadata = results.metadatas?.[0]?.[idx] ?? {};
      const distance = results.distances?.[0]?.[idx] ?? 1;
      // Chroma returns cosine distance; convert to similarity
      const score = 1 - distance;

      return {
        chunk: {
          id,
          content: results.documents?.[0]?.[idx] ?? "",
          metadata: {
            source: metadata.source ?? "",
            sourceType: metadata.sourceType ?? "wiki",
            title: metadata.title ?? "",
            section: metadata.section || undefined,
            filePath: metadata.filePath || undefined,
            lastUpdated: metadata.lastUpdated ?? "",
            chunkIndex: metadata.chunkIndex ?? 0,
            totalChunks: metadata.totalChunks ?? 0,
          },
        },
        score: Math.max(0, Math.min(1, score)),
        page: metadata.source,
      } satisfies SearchResult;
    });
  }

  async deleteBySource(source: string): Promise<void> {
    await this.collection.delete({
      where: { source },
    });
  }

  async count(): Promise<number> {
    return this.collection.count();
  }

  async clear(): Promise<void> {
    // Delete and recreate collection
    const name = this.config.collectionName ?? "withctx";
    await this.client.deleteCollection({ name });
    this.collection = await this.client.getOrCreateCollection({
      name,
      metadata: { "hnsw:space": "cosine" },
    });
  }
}
