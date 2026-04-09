import type { LLMProvider, LLMConfig } from "./types.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { GoogleProvider } from "./providers/google.js";
import { OllamaProvider } from "./providers/ollama.js";

export type { LLMProvider, LLMConfig, LLMResponse, LLMOptions, LLMMessage } from "./types.js";
export { AnthropicProvider } from "./providers/anthropic.js";
export { OpenAIProvider } from "./providers/openai.js";
export { GoogleProvider } from "./providers/google.js";
export { OllamaProvider } from "./providers/ollama.js";

/**
 * Create an LLM provider from explicit config.
 * If no config is provided, auto-detects based on available API keys.
 *
 * Detection order: ANTHROPIC_API_KEY -> OPENAI_API_KEY -> GOOGLE_API_KEY -> Ollama running
 */
export function createLLMProvider(config?: LLMConfig): LLMProvider {
  if (config) {
    return createProviderByName(config.provider, config);
  }

  // Auto-detect based on environment
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider();
  }

  if (process.env.OPENAI_API_KEY) {
    return new OpenAIProvider();
  }

  if (process.env.GOOGLE_API_KEY) {
    return new GoogleProvider();
  }

  // Ollama — we can't synchronously check if it's running,
  // so we return it as a fallback. The caller can use isAvailable()
  // to verify before making requests.
  return new OllamaProvider();
}

/**
 * Get the right provider and model for a specific operation.
 * Uses per-operation model overrides from config if available.
 *
 * Example config:
 *   ai:
 *     provider: anthropic
 *     models:
 *       ingest: gpt-4o-mini
 *       query: claude-sonnet-4
 *       review: gemini-2.0-flash
 *
 * If the model override specifies a model from a different provider,
 * the appropriate provider is automatically selected.
 */
export function getProviderForOperation(
  config: LLMConfig | undefined,
  operation: string
): { provider: LLMProvider; model?: string } {
  const modelOverride = config?.models?.[operation];

  if (!modelOverride) {
    // No override — use the default provider
    const provider = createLLMProvider(config);
    return { provider, model: config?.model };
  }

  // Detect which provider the model belongs to
  const detectedProvider = detectProviderForModel(modelOverride);

  if (detectedProvider && detectedProvider !== (config?.provider ?? "anthropic")) {
    // Model belongs to a different provider — create that provider
    const provider = createProviderByName(detectedProvider, {
      ...config,
      provider: detectedProvider,
    });
    return { provider, model: modelOverride };
  }

  // Same provider, just a different model
  const provider = createLLMProvider(config);
  return { provider, model: modelOverride };
}

/**
 * Detect which provider a model name belongs to.
 */
function detectProviderForModel(
  model: string
): LLMConfig["provider"] | null {
  const lower = model.toLowerCase();

  if (
    lower.startsWith("claude") ||
    lower.startsWith("anthropic")
  ) {
    return "anthropic";
  }

  if (
    lower.startsWith("gpt") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  ) {
    return "openai";
  }

  if (lower.startsWith("gemini")) {
    return "google";
  }

  if (
    lower.startsWith("llama") ||
    lower.startsWith("mistral") ||
    lower.startsWith("codellama") ||
    lower.startsWith("deepseek") ||
    lower.startsWith("phi") ||
    lower.startsWith("qwen")
  ) {
    return "ollama";
  }

  return null;
}

/**
 * Create a provider by name.
 */
function createProviderByName(
  name: LLMConfig["provider"],
  config?: LLMConfig
): LLMProvider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai":
      return new OpenAIProvider(config);
    case "google":
      return new GoogleProvider(config);
    case "ollama":
      return new OllamaProvider(config);
    default:
      throw new Error(`Unknown LLM provider: ${name}`);
  }
}
