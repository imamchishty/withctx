import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ClaudeResponse {
  content: string;
  tokensUsed?: number;
}

export interface ClaudeOptions {
  maxTokens?: number;
  model?: string;
  systemPrompt?: string;
}

/**
 * Wrapper around the Claude CLI.
 * Shells out to `claude` command for all LLM operations.
 */
export class ClaudeClient {
  private model: string;

  constructor(model: string = "claude-sonnet-4") {
    this.model = model;
  }

  /**
   * Check if Claude CLI is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync("claude", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a prompt to Claude and get a response.
   * Uses `claude --print -p` for non-interactive mode.
   */
  async prompt(text: string, options?: ClaudeOptions): Promise<ClaudeResponse> {
    const args = ["--print"];

    // Add model if specified
    const model = options?.model ?? this.model;
    if (model) {
      args.push("--model", model);
    }

    // Add max tokens if specified
    if (options?.maxTokens) {
      args.push("--max-tokens", String(options.maxTokens));
    }

    // Add system prompt if specified
    if (options?.systemPrompt) {
      args.push("--system-prompt", options.systemPrompt);
    }

    // Add the prompt
    args.push("-p", text);

    try {
      const { stdout } = await execFileAsync("claude", args, {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 120_000, // 2 minute timeout
      });

      return {
        content: stdout.trim(),
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Claude CLI error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Send a prompt with file context.
   * Reads files and includes them in the prompt.
   */
  async promptWithFiles(
    text: string,
    files: Array<{ path: string; content: string }>,
    options?: ClaudeOptions
  ): Promise<ClaudeResponse> {
    let fullPrompt = "";

    for (const file of files) {
      fullPrompt += `--- File: ${file.path} ---\n${file.content}\n\n`;
    }

    fullPrompt += `--- Instructions ---\n${text}`;

    return this.prompt(fullPrompt, options);
  }

  /**
   * Send an image to Claude for vision analysis.
   */
  async analyzeImage(
    imagePath: string,
    prompt: string,
    options?: ClaudeOptions
  ): Promise<ClaudeResponse> {
    // Claude CLI supports image input via file path
    const fullPrompt = `[Image: ${imagePath}]\n\n${prompt}`;
    return this.prompt(fullPrompt, options);
  }
}
