import type { EmbeddingProvider } from "../../types/vector.js";

const EMBEDDING_MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;
const MAX_BATCH_SIZE = 2048;

/**
 * OpenAI text-embedding-3-small provider.
 * Requires OPENAI_API_KEY environment variable.
 */
export function createOpenAIEmbeddingProvider(model?: string): EmbeddingProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required for OpenAI embeddings");
  }

  const selectedModel = model ?? EMBEDDING_MODEL;

  async function callEmbeddingAPI(texts: string[]): Promise<number[][]> {
    // Dynamically import openai to avoid hard dependency if not used
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });

    const results: number[][] = [];

    // Process in batches
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      const response = await client.embeddings.create({
        model: selectedModel,
        input: batch,
      });

      // Sort by index to maintain order
      const sorted = response.data.sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        results.push(item.embedding);
      }
    }

    return results;
  }

  return {
    dimensions: DIMENSIONS,

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      return callEmbeddingAPI(texts);
    },

    async embedQuery(text: string): Promise<number[]> {
      const results = await callEmbeddingAPI([text]);
      return results[0];
    },
  };
}
