import type { LLMProvider, LLMResponse } from "../llm/types.js";
import { existsSync } from "node:fs";

/**
 * Process an image using the configured LLM provider's vision capabilities.
 * Extracts text descriptions suitable for inclusion in wiki pages.
 *
 * Requires a provider that implements `analyzeImage` (Anthropic, OpenAI,
 * Google — all do out of the box; Ollama only with vision-capable models).
 *
 * @param imagePath - Absolute path to the image file
 * @param context  - Additional context about what the image represents
 * @param llm      - The LLMProvider to route the vision call through.
 * @returns Text description of the image content
 */
export async function processImage(
  imagePath: string,
  context: string,
  llm: LLMProvider
): Promise<string> {
  if (!existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`);
  }

  if (!llm.analyzeImage) {
    return `_Image: ${imagePath} (provider "${llm.name}" does not support vision)_`;
  }

  const prompt = buildVisionPrompt(context);

  let response: LLMResponse;
  try {
    response = await llm.analyzeImage(imagePath, prompt);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Vision analysis failed for ${imagePath}: ${message}`);
  }

  const content = response.content.trim();
  if (!content) {
    return `_Image: ${imagePath} (no content extracted)_`;
  }

  return content;
}

/**
 * Build the prompt used for vision analysis.
 */
function buildVisionPrompt(context: string): string {
  const base = `Describe this image for inclusion in a technical wiki page. Focus on:
- Architecture diagrams: List all components, connections, and data flows.
- Screenshots: Describe the UI layout, key elements, and any visible data.
- Code snippets: Transcribe the code accurately with proper formatting.
- Flowcharts: Describe each step and decision point.
- Database schemas: List tables, columns, and relationships.

Output structured markdown. Use headings, bullet points, and code blocks as appropriate.
Do NOT include phrases like "This image shows..." — just describe the content directly.`;

  if (context) {
    return `${base}\n\nAdditional context: ${context}`;
  }

  return base;
}
