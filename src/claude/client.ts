import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface ClaudeResponse {
  content: string;
  tokensUsed?: TokenUsage;
  model?: string;
}

/**
 * Get total token count from a response (input + output).
 */
export function totalTokens(response: ClaudeResponse): number {
  if (!response.tokensUsed) return 0;
  return response.tokensUsed.input + response.tokensUsed.output;
}

export interface ClaudeOptions {
  maxTokens?: number;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  /** Enable prompt caching for system prompt (reduces cost ~90% on repeated calls) */
  cacheSystemPrompt?: boolean;
}

const IMAGE_MEDIA_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Claude client using the Anthropic SDK.
 * Direct API calls with exact token tracking, streaming, and prompt caching.
 */
export class ClaudeClient {
  private client: Anthropic;
  private defaultModel: string;

  constructor(model: string = "claude-sonnet-4-20250514") {
    this.client = new Anthropic();
    this.defaultModel = model;
  }

  /**
   * Check if the API key is configured.
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Quick validation — just check we can create a minimal request
      const response = await this.client.messages.create({
        model: this.defaultModel,
        max_tokens: 10,
        messages: [{ role: "user", content: "ping" }],
      });
      return response.content.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Send a prompt to Claude and get a response.
   * Uses the Anthropic SDK for direct API access with exact token tracking.
   */
  async prompt(text: string, options?: ClaudeOptions): Promise<ClaudeResponse> {
    const model = options?.model ?? this.defaultModel;

    const systemParam = this.buildSystemParam(options);

    const response = await this.client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
      ...(systemParam && { system: systemParam }),
      messages: [{ role: "user", content: text }],
    });

    return this.formatResponse(response);
  }

  /**
   * Send a prompt with file context.
   * Reads files and includes them in the prompt with prompt caching.
   */
  async promptWithFiles(
    text: string,
    files: Array<{ path: string; content: string }>,
    options?: ClaudeOptions
  ): Promise<ClaudeResponse> {
    const model = options?.model ?? this.defaultModel;

    // Build system prompt with file context (cached — these rarely change)
    let fileContext = "";
    for (const file of files) {
      fileContext += `--- File: ${file.path} ---\n${file.content}\n\n`;
    }

    const systemBlocks: Anthropic.TextBlockParam[] = [];

    if (options?.systemPrompt) {
      systemBlocks.push({ type: "text", text: options.systemPrompt });
    }

    // File context as a cacheable block — saves ~90% on repeated queries
    systemBlocks.push({
      type: "text",
      text: fileContext,
      ...(options?.cacheSystemPrompt !== false && { cache_control: { type: "ephemeral" as const } }),
    });

    const response = await this.client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
      system: systemBlocks,
      messages: [{ role: "user", content: text }],
    });

    return this.formatResponse(response);
  }

  /**
   * Send a multi-turn conversation to Claude.
   * Used for ctx chat with conversation history.
   */
  async conversation(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    options?: ClaudeOptions
  ): Promise<ClaudeResponse> {
    const model = options?.model ?? this.defaultModel;

    const systemParam = this.buildSystemParam(options);

    const response = await this.client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
      ...(systemParam && { system: systemParam }),
      messages,
    });

    return this.formatResponse(response);
  }

  /**
   * Analyze an image using Claude's vision capabilities.
   * Reads the image file and sends it as base64.
   */
  async analyzeImage(
    imagePath: string,
    prompt: string,
    options?: ClaudeOptions
  ): Promise<ClaudeResponse> {
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

    const systemParam = this.buildSystemParam(options);

    const response = await this.client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      ...(systemParam && { system: systemParam }),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: base64,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    });

    return this.formatResponse(response);
  }

  /**
   * Get the default model name.
   */
  getModel(): string {
    return this.defaultModel;
  }

  /**
   * Build the system parameter, optionally with caching.
   */
  private buildSystemParam(
    options?: ClaudeOptions
  ): string | Anthropic.TextBlockParam[] | undefined {
    if (!options?.systemPrompt) return undefined;

    if (options.cacheSystemPrompt) {
      return [
        {
          type: "text" as const,
          text: options.systemPrompt,
          cache_control: { type: "ephemeral" as const },
        },
      ];
    }

    return options.systemPrompt;
  }

  /**
   * Format the API response into our standard format.
   */
  private formatResponse(response: Anthropic.Message): ClaudeResponse {
    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const usage = response.usage as unknown as Record<string, number>;

    return {
      content: textContent,
      tokensUsed: {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheCreation: usage.cache_creation_input_tokens ?? 0,
      },
      model: response.model,
    };
  }
}
