import type { EmbeddingProvider } from "../../types/vector.js";

/**
 * Local TF-IDF based embedding provider.
 * No API keys needed — runs entirely locally.
 * Uses term frequency-inverse document frequency vectors with cosine similarity.
 */

const DIMENSIONS = 512; // Fixed vocabulary size for TF-IDF vectors

/**
 * Tokenize text into normalized terms.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 50);
}

/**
 * Simple hash function to map terms to fixed-size vector indices.
 */
function hashTerm(term: string, size: number): number {
  let hash = 0;
  for (let i = 0; i < term.length; i++) {
    const char = term.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash) % size;
}

/**
 * Compute term frequency vector for a text using hashing trick.
 */
function computeTFVector(text: string, dimensions: number): number[] {
  const tokens = tokenize(text);
  const vector = new Array(dimensions).fill(0);

  if (tokens.length === 0) return vector;

  // Count term frequencies
  const termCounts = new Map<string, number>();
  for (const token of tokens) {
    termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
  }

  // Build TF vector using hashing trick
  for (const [term, count] of termCounts) {
    const idx = hashTerm(term, dimensions);
    // TF = log(1 + count) to dampen high-frequency terms
    vector[idx] += Math.log(1 + count);
  }

  // Also add bigrams for better semantic capture
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]}_${tokens[i + 1]}`;
    const idx = hashTerm(bigram, dimensions);
    vector[idx] += Math.log(1 + 1) * 0.5; // Lower weight for bigrams
  }

  // L2 normalize
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= magnitude;
    }
  }

  return vector;
}

/**
 * Compute IDF weights from a corpus of documents.
 */
function computeIDFWeights(documents: string[], dimensions: number): number[] {
  const docCount = documents.length;
  const docFrequency = new Array(dimensions).fill(0);

  for (const doc of documents) {
    const tokens = new Set(tokenize(doc));
    for (const token of tokens) {
      const idx = hashTerm(token, dimensions);
      docFrequency[idx]++;
    }
  }

  // IDF = log(N / (1 + df))
  return docFrequency.map((df) => Math.log(docCount / (1 + df)));
}

export function createLocalEmbeddingProvider(): EmbeddingProvider {
  let idfWeights: number[] | null = null;

  return {
    dimensions: DIMENSIONS,

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      // Compute IDF weights from the batch (acts as the corpus)
      idfWeights = computeIDFWeights(texts, DIMENSIONS);

      return texts.map((text) => {
        const tfVector = computeTFVector(text, DIMENSIONS);

        // Apply IDF weighting if available
        if (idfWeights) {
          for (let i = 0; i < tfVector.length; i++) {
            tfVector[i] *= idfWeights[i];
          }

          // Re-normalize after IDF weighting
          const magnitude = Math.sqrt(tfVector.reduce((sum, val) => sum + val * val, 0));
          if (magnitude > 0) {
            for (let i = 0; i < tfVector.length; i++) {
              tfVector[i] /= magnitude;
            }
          }
        }

        return tfVector;
      });
    },

    async embedQuery(text: string): Promise<number[]> {
      const tfVector = computeTFVector(text, DIMENSIONS);

      // Apply stored IDF weights if available
      if (idfWeights) {
        for (let i = 0; i < tfVector.length; i++) {
          tfVector[i] *= idfWeights[i];
        }

        // Re-normalize
        const magnitude = Math.sqrt(tfVector.reduce((sum, val) => sum + val * val, 0));
        if (magnitude > 0) {
          for (let i = 0; i < tfVector.length; i++) {
            tfVector[i] /= magnitude;
          }
        }
      }

      return tfVector;
    },
  };
}
