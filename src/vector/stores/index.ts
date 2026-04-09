import type { VectorStore, VectorStoreConfig, EmbeddingProvider } from "../../types/vector.js";
import { MemoryVectorStore } from "./memory.js";

/**
 * Create a vector store based on configuration.
 *
 * Auto-detection order:
 * 1. If config specifies a provider, use it
 * 2. Try to connect to Chroma — if reachable, use it
 * 3. Fall back to in-memory store
 */
export async function createVectorStore(
  config: Partial<VectorStoreConfig>,
  embeddingProvider: EmbeddingProvider,
  ctxDirPath: string
): Promise<VectorStore> {
  if (config.provider === "chroma") {
    return tryCreateChroma(config as VectorStoreConfig, embeddingProvider, ctxDirPath);
  }

  if (config.provider === "memory") {
    const store = new MemoryVectorStore(ctxDirPath, embeddingProvider);
    await store.initialize();
    return store;
  }

  // Auto-detect: try Chroma first, fall back to memory
  return tryCreateChroma(
    { ...config, provider: "chroma" } as VectorStoreConfig,
    embeddingProvider,
    ctxDirPath
  );
}

async function tryCreateChroma(
  config: VectorStoreConfig,
  embeddingProvider: EmbeddingProvider,
  ctxDirPath: string
): Promise<VectorStore> {
  try {
    const { ChromaVectorStore } = await import("./chroma.js");
    const store = new ChromaVectorStore(config, embeddingProvider);
    await store.initialize();
    return store;
  } catch {
    // Chroma not available — fall back to memory store
    const store = new MemoryVectorStore(ctxDirPath, embeddingProvider);
    await store.initialize();
    return store;
  }
}
