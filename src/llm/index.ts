import type { LLMProvider, LLMConfig } from "./types.js";
import type { CtxConfig } from "../types/config.js";
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
 * Build an LLMProvider from a loaded `ctx.yaml` config, honouring the
 * full precedence chain:
 *
 *   provider  = config.ai.provider            (default: "anthropic")
 *   model     = config.ai.model
 *             ?? config.costs.model           (legacy location)
 *             ?? provider-specific default
 *   base_url  = config.ai.base_url            (passes through to the SDK)
 *   apiKey    = env var first (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
 *             ?? config.ai.api_key            (yaml fallback — escape hatch
 *                                              for solo/local use; env still
 *                                              wins in CI and teams)
 *
 * If `operation` is given and `config.ai.models[operation]` is set, that
 * model override wins — including auto-switching to a *different* provider
 * when the override model name belongs elsewhere (e.g. `ingest: gpt-4o-mini`
 * under an Anthropic default will route ingest through OpenAI).
 *
 * This is the single entry point every CLI command and server route should
 * use — do not `new ClaudeClient(...)` directly.
 */
export function createLLMFromCtxConfig(
  config: CtxConfig | null | undefined,
  operation?: string
): LLMProvider {
  const ai = config?.ai;
  const provider: LLMConfig["provider"] = ai?.provider ?? "anthropic";

  // Legacy: costs.model was the original model setting, still honoured so we
  // don't break existing ctx.yaml files.
  const baseModel = ai?.model ?? config?.costs?.model;

  // Treat empty strings as unset — the loader's ${VAR} interpolation
  // resolves missing env vars to "", and we don't want that to leak
  // through as an empty apiKey or baseUrl that downstream SDKs will
  // happily try to use (producing confusing auth errors).
  const apiKey = ai?.api_key && ai.api_key.trim() !== "" ? ai.api_key : undefined;
  const baseUrl = ai?.base_url && ai.base_url.trim() !== "" ? ai.base_url : undefined;

  // Same "drop empties" treatment for ai.headers — an interpolated
  // ${MISSING_VAR} shouldn't result in sending a header with value "".
  const headers = ai?.headers
    ? Object.fromEntries(
        Object.entries(ai.headers).filter(([, v]) => typeof v === "string" && v.trim() !== "")
      )
    : undefined;
  const headersClean = headers && Object.keys(headers).length > 0 ? headers : undefined;

  const llmConfig: LLMConfig = {
    provider,
    ...(baseModel !== undefined && { model: baseModel }),
    ...(baseUrl !== undefined && { baseUrl }),
    ...(apiKey !== undefined && { apiKey }),
    ...(ai?.models !== undefined && { models: ai.models }),
    ...(headersClean !== undefined && { headers: headersClean }),
  };

  // Per-operation override — may switch providers entirely.
  if (operation && ai?.models?.[operation]) {
    const { provider: selected, model } = getProviderForOperation(
      llmConfig,
      operation
    );
    // getProviderForOperation doesn't know about base_url fall-through, so
    // if the override stays on the same provider we don't need to do anything
    // extra; if it crossed providers the new one uses its own defaults. This
    // matches user expectation: base_url is scoped to the *primary* provider.
    if (model && selected.getModel() !== model) {
      // The returned provider instance may have been created without the
      // override model baked in — re-create with it.
      return createProviderByName(
        detectProviderForModel(model) ?? provider,
        { ...llmConfig, model }
      );
    }
    return selected;
  }

  return createProviderByName(provider, llmConfig);
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
