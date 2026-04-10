import { GoogleGenerativeAI } from "@google/generative-ai";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type {
  LLMProvider,
  LLMResponse,
  LLMOptions,
  LLMMessage,
  LLMConfig,
} from "../types.js";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Google Gemini provider — supports Gemini 2.0 Flash and other Google models.
 */
export class GoogleProvider implements LLMProvider {
  readonly name = "google";
  private genAI: GoogleGenerativeAI;
  private defaultModel: string;
  private baseURL: string;
  private hasKey: boolean;

  constructor(config?: LLMConfig) {
    // Env var wins over config.apiKey — env is the canonical secret store,
    // config.apiKey is a fallback for solo/local use.
    const resolvedKey = process.env.GOOGLE_API_KEY ?? config?.apiKey ?? "";
    this.hasKey = resolvedKey !== "";
    this.defaultModel = config?.model ?? "gemini-2.0-flash";
    this.genAI = new GoogleGenerativeAI(resolvedKey);
    // The Google SDK doesn't expose a configurable base URL — we track it
    // for reporting parity with other providers.
    this.baseURL =
      config?.baseUrl ?? "https://generativelanguage.googleapis.com";
  }

  getModel(): string {
    return this.defaultModel;
  }

  getBaseURL(): string {
    return this.baseURL;
  }

  async prompt(text: string, options?: LLMOptions): Promise<LLMResponse> {
    const model = this.getGenerativeModel(options);

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text }] }],
      ...(options?.temperature !== undefined && {
        generationConfig: {
          temperature: options.temperature,
          maxOutputTokens: options?.maxTokens ?? 4096,
        },
      }),
      ...(!options?.temperature && {
        generationConfig: {
          maxOutputTokens: options?.maxTokens ?? 4096,
        },
      }),
    });

    return this.toResponse(result, options);
  }

  async promptWithFiles(
    text: string,
    files: Array<{ path: string; content: string }>,
    options?: LLMOptions
  ): Promise<LLMResponse> {
    const model = this.getGenerativeModel(options);

    // Build file context
    let fileContext = "";
    for (const file of files) {
      fileContext += `--- File: ${file.path} ---\n${file.content}\n\n`;
    }

    const fullPrompt = [options?.systemPrompt, fileContext, text]
      .filter(Boolean)
      .join("\n\n");

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
      generationConfig: {
        maxOutputTokens: options?.maxTokens ?? 4096,
        ...(options?.temperature !== undefined && {
          temperature: options.temperature,
        }),
      },
    });

    return this.toResponse(result, options);
  }

  async conversation(
    messages: LLMMessage[],
    options?: LLMOptions
  ): Promise<LLMResponse> {
    const model = this.getGenerativeModel(options);

    // Convert messages to Gemini format
    // Gemini doesn't have a system role in contents — prepend it as context
    const geminiContents: Array<{
      role: string;
      parts: Array<{ text: string }>;
    }> = [];

    let systemContext = options?.systemPrompt ?? "";

    for (const msg of messages) {
      if (msg.role === "system") {
        systemContext += (systemContext ? "\n\n" : "") + msg.content;
        continue;
      }

      // Gemini uses "user" and "model" roles
      const role = msg.role === "assistant" ? "model" : "user";
      geminiContents.push({ role, parts: [{ text: msg.content }] });
    }

    // Prepend system context to the first user message
    if (systemContext && geminiContents.length > 0) {
      const first = geminiContents[0];
      if (first.role === "user") {
        first.parts[0].text = `${systemContext}\n\n${first.parts[0].text}`;
      } else {
        geminiContents.unshift({
          role: "user",
          parts: [{ text: systemContext }],
        });
      }
    }

    const result = await model.generateContent({
      contents: geminiContents,
      generationConfig: {
        maxOutputTokens: options?.maxTokens ?? 4096,
        ...(options?.temperature !== undefined && {
          temperature: options.temperature,
        }),
      },
    });

    return this.toResponse(result, options);
  }

  async analyzeImage(
    imagePath: string,
    prompt: string,
    options?: LLMOptions
  ): Promise<LLMResponse> {
    const model = this.getGenerativeModel(options);
    const ext = extname(imagePath).toLowerCase();
    const mimeType = IMAGE_MIME_TYPES[ext];

    if (!mimeType) {
      throw new Error(
        `Unsupported image format: ${ext}. Supported: ${Object.keys(IMAGE_MIME_TYPES).join(", ")}`
      );
    }

    const imageData = readFileSync(imagePath);
    const base64 = imageData.toString("base64");

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64,
              },
            },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: options?.maxTokens ?? 4096,
        ...(options?.temperature !== undefined && {
          temperature: options.temperature,
        }),
      },
    });

    return this.toResponse(result, options);
  }

  async isAvailable(): Promise<boolean> {
    return this.hasKey;
  }

  private getGenerativeModel(options?: LLMOptions) {
    const modelName = options?.model ?? this.defaultModel;

    return this.genAI.getGenerativeModel({
      model: modelName,
      ...(options?.systemPrompt && !options?.model
        ? { systemInstruction: options.systemPrompt }
        : {}),
    });
  }

  private toResponse(
    result: Awaited<
      ReturnType<
        ReturnType<GoogleGenerativeAI["getGenerativeModel"]>["generateContent"]
      >
    >,
    options?: LLMOptions
  ): LLMResponse {
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    return {
      content: text,
      tokensUsed: usage
        ? {
            input: usage.promptTokenCount ?? 0,
            output: usage.candidatesTokenCount ?? 0,
          }
        : undefined,
      model: options?.model ?? this.defaultModel,
      provider: this.name,
    };
  }
}
