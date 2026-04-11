/**
 * Offline provider detection — the Setup-axis item for users who want
 * to try withctx without paying Anthropic on turn one. If `ollama
 * serve` is running on the standard port, we offer it as a free local
 * alternative during `ctx setup`.
 *
 * The probe is best-effort and short-timeout (500ms) so it never
 * blocks setup when Ollama isn't installed. Failure is silent — we
 * just fall through to the default Anthropic provider.
 */

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const PROBE_TIMEOUT_MS = 500;

export interface OllamaProbe {
  available: boolean;
  baseUrl: string;
  models: string[];
}

/**
 * Pick a sensible default model from the list of installed ones.
 * Preference order tracks the "it just works for wiki compilation"
 * axis — we want a general-purpose mid-size instruct model.
 */
const MODEL_PREFERENCE = [
  "llama3.2",
  "llama3.1",
  "llama3",
  "qwen2.5",
  "qwen2",
  "mistral",
  "phi3",
];

function pickPreferredModel(models: string[]): string | null {
  for (const preferred of MODEL_PREFERENCE) {
    const match = models.find((m) => m.startsWith(preferred));
    if (match) return match;
  }
  return models[0] ?? null;
}

/**
 * Probe the local Ollama server. Returns `{ available: false }`
 * whenever anything goes wrong — DNS, timeout, bad JSON, no models,
 * whatever. Callers should never see a throw.
 */
export async function probeOllama(
  baseUrl: string = DEFAULT_OLLAMA_URL
): Promise<OllamaProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });
    if (!res.ok) return { available: false, baseUrl, models: [] };

    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    const models =
      json.models
        ?.map((m) => m.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0) ?? [];

    if (models.length === 0) return { available: false, baseUrl, models: [] };
    return { available: true, baseUrl, models };
  } catch {
    return { available: false, baseUrl, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

export function pickOllamaModel(probe: OllamaProbe): string | null {
  if (!probe.available) return null;
  return pickPreferredModel(probe.models);
}
