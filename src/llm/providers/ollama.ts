import { readFileSync } from "node:fs";
import type {
  LLMProvider,
  LLMResponse,
  LLMOptions,
  LLMMessage,
  LLMConfig,
} from "../types.js";

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama provider — local LLM inference via the Ollama REST API.
 * No API key required. Ollama must be running locally.
 */
export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  private baseUrl: string;
  private defaultModel: string;

  constructor(config?: LLMConfig) {
    this.defaultModel = config?.model ?? "llama3";
    this.baseUrl = config?.baseUrl ?? "http://localhost:11434";
  }

  async prompt(text: string, options?: LLMOptions): Promise<LLMResponse> {
    const messages: OllamaChatMessage[] = [];

    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }

    messages.push({ role: "user", content: text });

    return this.chat(messages, options);
  }

  async promptWithFiles(
    text: string,
    files: Array<{ path: string; content: string }>,
    options?: LLMOptions
  ): Promise<LLMResponse> {
    // Build file context
    let fileContext = "";
    for (const file of files) {
      fileContext += `--- File: ${file.path} ---\n${file.content}\n\n`;
    }

    const systemContent = [options?.systemPrompt, fileContext]
      .filter(Boolean)
      .join("\n\n");

    const messages: OllamaChatMessage[] = [];

    if (systemContent) {
      messages.push({ role: "system", content: systemContent });
    }

    messages.push({ role: "user", content: text });

    return this.chat(messages, options);
  }

  async conversation(
    messages: LLMMessage[],
    options?: LLMOptions
  ): Promise<LLMResponse> {
    const ollamaMessages: OllamaChatMessage[] = [];

    if (options?.systemPrompt) {
      ollamaMessages.push({ role: "system", content: options.systemPrompt });
    }

    for (const msg of messages) {
      ollamaMessages.push({ role: msg.role, content: msg.content });
    }

    return this.chat(ollamaMessages, options);
  }

  async analyzeImage(
    imagePath: string,
    prompt: string,
    options?: LLMOptions
  ): Promise<LLMResponse> {
    const imageData = readFileSync(imagePath);
    const base64 = imageData.toString("base64");

    const messages: OllamaChatMessage[] = [];

    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }

    messages.push({
      role: "user",
      content: prompt,
      images: [base64],
    });

    return this.chat(messages, options);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async chat(
    messages: OllamaChatMessage[],
    options?: LLMOptions
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          ...(options?.temperature !== undefined && {
            temperature: options.temperature,
          }),
          ...(options?.maxTokens !== undefined && {
            num_predict: options.maxTokens,
          }),
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as OllamaChatResponse;

    return {
      content: data.message.content,
      tokensUsed: {
        input: data.prompt_eval_count ?? 0,
        output: data.eval_count ?? 0,
      },
      model: data.model,
      provider: this.name,
    };
  }
}
