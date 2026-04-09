import type { EmbeddingProvider } from "../../types/vector.js";
import { createLocalEmbeddingProvider } from "./local.js";

/**
 * Anthropic does not currently offer an embeddings API.
 * This provider attempts to use OpenAI if OPENAI_API_KEY is set,
 * otherwise falls back to the local TF-IDF provider.
 */
export async function createAnthropicEmbeddingProvider(): Promise<EmbeddingProvider> {
  if (process.env.OPENAI_API_KEY) {
    const { createOpenAIEmbeddingProvider } = await import("./openai.js");
    return createOpenAIEmbeddingProvider();
  }

  console.warn(
    "Anthropic does not provide embeddings. Falling back to local TF-IDF provider. " +
    "Set OPENAI_API_KEY for higher quality embeddings."
  );
  return createLocalEmbeddingProvider();
}
