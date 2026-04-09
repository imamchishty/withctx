export interface ChunkMetadata {
  source: string;        // wiki page path or source doc id
  sourceType: string;    // "wiki" | "source" | "memory"
  title: string;
  section?: string;      // heading within the page
  filePath?: string;     // original source file
  lastUpdated: string;
  chunkIndex: number;
  totalChunks: number;
}

export interface TextChunk {
  id: string;
  content: string;
  metadata: ChunkMetadata;
  embedding?: number[];
}

export interface SearchResult {
  chunk: TextChunk;
  score: number;         // similarity score 0-1
  page?: string;         // wiki page path
}

export interface VectorStoreConfig {
  provider: "chroma" | "memory";  // start with chroma + in-memory fallback
  collectionName?: string;
  chromaUrl?: string;     // default http://localhost:8000
  embeddingProvider?: "anthropic" | "openai" | "local";
  embeddingModel?: string;
}

export interface VectorStore {
  initialize(): Promise<void>;
  addChunks(chunks: TextChunk[]): Promise<void>;
  search(query: string, limit?: number, filter?: Record<string, string>): Promise<SearchResult[]>;
  deleteBySource(source: string): Promise<void>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  dimensions: number;
}
