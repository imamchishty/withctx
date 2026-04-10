import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type {
  LLMProvider,
  LLMResponse,
  LLMOptions,
  LLMMessage,
  LLMConfig,
} from "../types.js";

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * OpenAI provider — supports GPT-4o and other OpenAI models.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private client: OpenAI;
  private defaultModel: string;
  private baseURL: string;
  private hasKey: boolean;

  constructor(config?: LLMConfig) {
    this.defaultModel = config?.model ?? "gpt-4o";
    // Env var wins over config.apiKey. The OpenAI SDK throws if apiKey is
    // empty at construction time, so for `ctx doctor` and tests — where
    // we want to instantiate the provider without a key just to read
    // getBaseURL()/getModel() — we pass a placeholder. Any real request
    // still fails with a clear "unauthorized" error from the endpoint.
    const resolvedKey =
      process.env.OPENAI_API_KEY ?? config?.apiKey ?? "missing-api-key";
    this.hasKey = resolvedKey !== "missing-api-key";
    this.client = new OpenAI({
      apiKey: resolvedKey,
      ...(config?.baseUrl && { baseURL: config.baseUrl }),
    });
    // Track the effective base URL so `ctx doctor` can report traffic routing.
    this.baseURL =
      config?.baseUrl ??
      process.env.OPENAI_BASE_URL ??
      "https://api.openai.com/v1";
  }

  getModel(): string {
    return this.defaultModel;
  }

  getBaseURL(): string {
    return this.baseURL;
  }

  async prompt(text: string, options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;

    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }

    messages.push({ role: "user", content: text });

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined && {
        temperature: options.temperature,
      }),
      messages,
    });

    return this.toResponse(response);
  }

  async promptWithFiles(
    text: string,
    files: Array<{ path: string; content: string }>,
    options?: LLMOptions
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;

    // Build file context as a system message
    let fileContext = "";
    for (const file of files) {
      fileContext += `--- File: ${file.path} ---\n${file.content}\n\n`;
    }

    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    const systemContent = [options?.systemPrompt, fileContext]
      .filter(Boolean)
      .join("\n\n");

    if (systemContent) {
      messages.push({ role: "system", content: systemContent });
    }

    messages.push({ role: "user", content: text });

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined && {
        temperature: options.temperature,
      }),
      messages,
    });

    return this.toResponse(response);
  }

  async conversation(
    messages: LLMMessage[],
    options?: LLMOptions
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;

    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];

    // Add system prompt from options if present
    if (options?.systemPrompt) {
      openaiMessages.push({ role: "system", content: options.systemPrompt });
    }

    // Map messages — OpenAI supports system role natively
    for (const msg of messages) {
      openaiMessages.push({ role: msg.role, content: msg.content });
    }

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined && {
        temperature: options.temperature,
      }),
      messages: openaiMessages,
    });

    return this.toResponse(response);
  }

  async analyzeImage(
    imagePath: string,
    prompt: string,
    options?: LLMOptions
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;
    const ext = extname(imagePath).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];

    if (!mediaType) {
      throw new Error(
        `Unsupported image format: ${ext}. Supported: ${Object.keys(IMAGE_MEDIA_TYPES).join(", ")}`
      );
    }

    const imageData = readFileSync(imagePath);
    const base64 = imageData.toString("base64");
    const dataUrl = `data:${mediaType};base64,${base64}`;

    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }

    messages.push({
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: dataUrl },
        },
        {
          type: "text",
          text: prompt,
        },
      ],
    });

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      messages,
    });

    return this.toResponse(response);
  }

  async isAvailable(): Promise<boolean> {
    return this.hasKey;
  }

  private toResponse(
    response: OpenAI.ChatCompletion
  ): LLMResponse {
    const choice = response.choices[0];
    const content = choice?.message?.content ?? "";

    return {
      content,
      tokensUsed: response.usage
        ? {
            input: response.usage.prompt_tokens,
            output: response.usage.completion_tokens,
          }
        : undefined,
      model: response.model,
      provider: this.name,
    };
  }
}
