import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createLLMProvider,
  createLLMFromCtxConfig,
  AnthropicProvider,
  OpenAIProvider,
  GoogleProvider,
  OllamaProvider,
} from "../src/llm/index.js";
import type { CtxConfig } from "../src/types/config.js";

/**
 * These tests exercise the central provider factory — the thing every
 * CLI command and server route now uses instead of `new ClaudeClient(...)`.
 *
 * The goal is to pin down the config-precedence rules so changing
 * `ai.provider` in ctx.yaml really does re-route traffic.
 */

const envBackup: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GOOGLE_API_KEY",
];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    envBackup[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envBackup[key] !== undefined) {
      process.env[key] = envBackup[key];
    } else {
      delete process.env[key];
    }
  }
});

describe("createLLMProvider — auto-detect", () => {
  it("returns AnthropicProvider when only ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const p = createLLMProvider();
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.name).toBe("anthropic");
  });

  it("returns OpenAIProvider when only OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const p = createLLMProvider();
    expect(p).toBeInstanceOf(OpenAIProvider);
  });

  it("returns GoogleProvider when only GOOGLE_API_KEY is set", () => {
    process.env.GOOGLE_API_KEY = "google-test";
    const p = createLLMProvider();
    expect(p).toBeInstanceOf(GoogleProvider);
  });

  it("falls back to OllamaProvider when no API keys are present", () => {
    const p = createLLMProvider();
    expect(p).toBeInstanceOf(OllamaProvider);
  });

  it("Anthropic first wins over OpenAI when both are set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const p = createLLMProvider();
    expect(p).toBeInstanceOf(AnthropicProvider);
  });
});

describe("createLLMFromCtxConfig — provider selection", () => {
  it("defaults to Anthropic when config is null", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const p = createLLMFromCtxConfig(null);
    expect(p.name).toBe("anthropic");
  });

  it("honours ai.provider: openai with ai.base_url", () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const config = {
      project: "demo",
      ai: {
        provider: "openai" as const,
        base_url: "https://api.core42.ai/v1",
      },
    } as unknown as CtxConfig;
    const p = createLLMFromCtxConfig(config);
    expect(p.name).toBe("openai");
    expect(p.getBaseURL()).toBe("https://api.core42.ai/v1");
  });

  it("honours ai.provider: ollama with custom base_url", () => {
    const config = {
      project: "demo",
      ai: {
        provider: "ollama" as const,
        model: "llama3:70b",
        base_url: "http://gpu-box.local:11434",
      },
    } as unknown as CtxConfig;
    const p = createLLMFromCtxConfig(config);
    expect(p.name).toBe("ollama");
    expect(p.getModel()).toBe("llama3:70b");
    expect(p.getBaseURL()).toBe("http://gpu-box.local:11434");
  });

  it("falls back from ai.model to costs.model for legacy configs", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const config = {
      project: "demo",
      costs: { model: "claude-haiku-3.5-20241022" },
    } as unknown as CtxConfig;
    const p = createLLMFromCtxConfig(config);
    expect(p.name).toBe("anthropic");
    expect(p.getModel()).toBe("claude-haiku-3.5-20241022");
  });

  it("ai.model wins over costs.model when both are set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const config = {
      project: "demo",
      ai: {
        provider: "anthropic" as const,
        model: "claude-sonnet-4-20250514",
      },
      costs: { model: "claude-haiku-3.5-20241022" },
    } as unknown as CtxConfig;
    const p = createLLMFromCtxConfig(config);
    expect(p.getModel()).toBe("claude-sonnet-4-20250514");
  });

  it("per-operation override auto-switches provider by model name", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const config = {
      project: "demo",
      ai: {
        provider: "anthropic" as const,
        models: { ingest: "gpt-4o-mini" },
      },
    } as unknown as CtxConfig;

    const ingestProvider = createLLMFromCtxConfig(config, "ingest");
    expect(ingestProvider.name).toBe("openai");
    expect(ingestProvider.getModel()).toBe("gpt-4o-mini");

    // Without the operation hint, still Anthropic.
    const defaultProvider = createLLMFromCtxConfig(config);
    expect(defaultProvider.name).toBe("anthropic");
  });
});

describe("LLMProvider.getBaseURL defaults", () => {
  it("Anthropic defaults to api.anthropic.com", () => {
    const p = new AnthropicProvider();
    expect(p.getBaseURL()).toBe("https://api.anthropic.com");
  });

  it("OpenAI defaults to api.openai.com/v1", () => {
    const p = new OpenAIProvider();
    expect(p.getBaseURL()).toBe("https://api.openai.com/v1");
  });

  it("Google defaults to generativelanguage.googleapis.com", () => {
    const p = new GoogleProvider();
    expect(p.getBaseURL()).toBe("https://generativelanguage.googleapis.com");
  });

  it("Ollama defaults to localhost:11434", () => {
    const p = new OllamaProvider();
    expect(p.getBaseURL()).toBe("http://localhost:11434");
  });
});
