import { ClaudeClient } from "../../claude/client.js";
import type {
  LLMProvider,
  LLMResponse,
  LLMOptions,
  LLMMessage,
  LLMConfig,
  LLMStreamHandle,
} from "../types.js";

/**
 * Anthropic provider — wraps the existing ClaudeClient.
 * Keeps prompt caching as a competitive advantage over other providers.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: ClaudeClient;
  private hasKey: boolean;

  constructor(config?: LLMConfig) {
    const model = config?.model ?? "claude-sonnet-4-20250514";

    // Env var wins over config.apiKey — that's the whole point of env
    // vars. config.apiKey is only a fallback for users who prefer a
    // single committed ctx.yaml. We never mutate process.env; we pass
    // the resolved key through ClaudeClient options instead.
    const resolvedKey = process.env.ANTHROPIC_API_KEY ?? config?.apiKey;
    this.hasKey = !!resolvedKey;

    this.client = new ClaudeClient(model, {
      baseURL: config?.baseUrl,
      ...(resolvedKey !== undefined && { apiKey: resolvedKey }),
      ...(config?.headers && { defaultHeaders: config.headers }),
    });
  }

  async prompt(text: string, options?: LLMOptions): Promise<LLMResponse> {
    const response = await this.client.prompt(text, {
      maxTokens: options?.maxTokens,
      model: options?.model,
      systemPrompt: options?.systemPrompt,
      temperature: options?.temperature,
      cacheSystemPrompt: options?.cacheSystemPrompt,
    });

    return this.toResponse(response);
  }

  async promptWithFiles(
    text: string,
    files: Array<{ path: string; content: string }>,
    options?: LLMOptions
  ): Promise<LLMResponse> {
    const response = await this.client.promptWithFiles(text, files, {
      maxTokens: options?.maxTokens,
      model: options?.model,
      systemPrompt: options?.systemPrompt,
      temperature: options?.temperature,
      cacheSystemPrompt: options?.cacheSystemPrompt ?? true,
    });

    return this.toResponse(response);
  }

  promptStream(text: string, options?: LLMOptions): LLMStreamHandle {
    const handle = this.client.promptStream(text, {
      maxTokens: options?.maxTokens,
      model: options?.model,
      systemPrompt: options?.systemPrompt,
      temperature: options?.temperature,
      cacheSystemPrompt: options?.cacheSystemPrompt,
    });
    return {
      textStream: handle.textStream,
      finalResponse: handle.finalResponse.then((r) => this.toResponse(r)),
    };
  }

  async conversation(
    messages: LLMMessage[],
    options?: LLMOptions
  ): Promise<LLMResponse> {
    // Filter out system messages — Anthropic uses a separate system param
    const conversationMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // Extract system message if present
    const systemMessage = messages.find((m) => m.role === "system");
    const systemPrompt =
      options?.systemPrompt ?? systemMessage?.content ?? undefined;

    const response = await this.client.conversation(conversationMessages, {
      maxTokens: options?.maxTokens,
      model: options?.model,
      systemPrompt,
      temperature: options?.temperature,
      cacheSystemPrompt: options?.cacheSystemPrompt,
    });

    return this.toResponse(response);
  }

  async analyzeImage(
    imagePath: string,
    prompt: string,
    options?: LLMOptions
  ): Promise<LLMResponse> {
    const response = await this.client.analyzeImage(imagePath, prompt, {
      maxTokens: options?.maxTokens,
      model: options?.model,
      systemPrompt: options?.systemPrompt,
      temperature: options?.temperature,
      cacheSystemPrompt: options?.cacheSystemPrompt,
    });

    return this.toResponse(response);
  }

  async isAvailable(): Promise<boolean> {
    // Env var OR yaml fallback — both count as "configured".
    return this.hasKey;
  }

  getModel(): string {
    return this.client.getModel();
  }

  getBaseURL(): string {
    return this.client.getBaseURL();
  }

  private toResponse(response: {
    content: string;
    tokensUsed?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheCreation?: number;
    };
    model?: string;
  }): LLMResponse {
    return {
      content: response.content,
      tokensUsed: response.tokensUsed,
      model: response.model,
      provider: this.name,
    };
  }
}
