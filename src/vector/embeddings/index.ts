import type { EmbeddingProvider, VectorStoreConfig } from "../../types/vector.js";

/**
 * Create an embedding provider based on configuration.
 *
 * Auto-detection order:
 * 1. If config specifies a provider, use it
 * 2. If OPENAI_API_KEY is set, use OpenAI
 * 3. Fall back to local TF-IDF
 */
export async function createEmbeddingProvider(
  config?: Partial<VectorStoreConfig>
): Promise<EmbeddingProvider> {
  const providerName = config?.embeddingProvider ?? detectProvider();

  switch (providerName) {
    case "openai": {
      const { createOpenAIEmbeddingProvider } = await import("./openai.js");
      return createOpenAIEmbeddingProvider(config?.embeddingModel);
    }
    case "anthropic": {
      const { createAnthropicEmbeddingProvider } = await import("./anthropic.js");
      return createAnthropicEmbeddingProvider();
    }
    case "local":
    default: {
      const { createLocalEmbeddingProvider } = await import("./local.js");
      return createLocalEmbeddingProvider();
    }
  }
}

/**
 * Auto-detect which embedding provider to use.
 */
function detectProvider(): "openai" | "local" {
  if (process.env.OPENAI_API_KEY) {
    return "openai";
  }
  return "local";
}
