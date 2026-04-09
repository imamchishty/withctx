export interface LLMResponse {
  content: string;
  tokensUsed?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
  model?: string;
  provider?: string;
}

export interface LLMOptions {
  maxTokens?: number;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  cacheSystemPrompt?: boolean;
}

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMProvider {
  name: string;
  prompt(text: string, options?: LLMOptions): Promise<LLMResponse>;
  promptWithFiles(
    text: string,
    files: Array<{ path: string; content: string }>,
    options?: LLMOptions
  ): Promise<LLMResponse>;
  conversation(
    messages: LLMMessage[],
    options?: LLMOptions
  ): Promise<LLMResponse>;
  analyzeImage?(
    imagePath: string,
    prompt: string,
    options?: LLMOptions
  ): Promise<LLMResponse>;
  isAvailable(): Promise<boolean>;
}

export interface LLMConfig {
  provider: "anthropic" | "openai" | "google" | "ollama";
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  models?: Record<string, string>;
}
