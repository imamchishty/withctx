import type { TextChunk, ChunkMetadata } from "../types/vector.js";

export interface ChunkerOptions {
  maxChunkSize?: number;    // max chars per chunk (default ~2048)
  overlapSize?: number;     // overlap chars between chunks (default ~200)
}

const DEFAULT_MAX_CHUNK_SIZE = 2048;
const DEFAULT_OVERLAP_SIZE = 200;

interface Section {
  heading: string | undefined;
  content: string;
}

/**
 * Split markdown content into sections based on headings.
 */
function splitIntoSections(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let currentHeading: string | undefined = undefined;
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      // Save previous section if it has content
      if (currentLines.length > 0) {
        sections.push({
          heading: currentHeading,
          content: currentLines.join("\n").trim(),
        });
      }
      currentHeading = headingMatch[2].trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  // Push final section
  if (currentLines.length > 0) {
    sections.push({
      heading: currentHeading,
      content: currentLines.join("\n").trim(),
    });
  }

  return sections;
}

/**
 * Split text into chunks, preserving code blocks.
 * Never splits in the middle of a code block.
 */
function splitTextIntoChunks(text: string, maxSize: number, overlapSize: number): string[] {
  if (text.length <= maxSize) {
    return [text];
  }

  const chunks: string[] = [];

  // Identify code block boundaries
  const codeBlockPattern = /```[\s\S]*?```/g;
  const codeBlocks: Array<{ start: number; end: number }> = [];
  let match;
  while ((match = codeBlockPattern.exec(text)) !== null) {
    codeBlocks.push({ start: match.index, end: match.index + match[0].length });
  }

  function isInsideCodeBlock(pos: number): boolean {
    return codeBlocks.some((block) => pos > block.start && pos < block.end);
  }

  function findSplitPoint(text: string, targetPos: number): number {
    // Try to split at paragraph boundary first
    for (let i = targetPos; i > targetPos - 200 && i > 0; i--) {
      if (text[i] === "\n" && text[i - 1] === "\n" && !isInsideCodeBlock(i)) {
        return i + 1;
      }
    }
    // Then try sentence boundary
    for (let i = targetPos; i > targetPos - 200 && i > 0; i--) {
      if ((text[i] === "." || text[i] === "!" || text[i] === "?") && text[i + 1] === " " && !isInsideCodeBlock(i)) {
        return i + 2;
      }
    }
    // Then try newline
    for (let i = targetPos; i > targetPos - 200 && i > 0; i--) {
      if (text[i] === "\n" && !isInsideCodeBlock(i)) {
        return i + 1;
      }
    }
    // Last resort: split at target position if not inside code block
    if (!isInsideCodeBlock(targetPos)) {
      return targetPos;
    }
    // If inside code block, find end of code block
    const block = codeBlocks.find((b) => targetPos > b.start && targetPos < b.end);
    return block ? block.end : targetPos;
  }

  let pos = 0;
  while (pos < text.length) {
    const remaining = text.length - pos;
    if (remaining <= maxSize) {
      chunks.push(text.slice(pos).trim());
      break;
    }

    const splitPos = findSplitPoint(text, pos + maxSize);
    chunks.push(text.slice(pos, splitPos).trim());

    // Move position back by overlap amount
    pos = Math.max(pos + 1, splitPos - overlapSize);
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Chunk a wiki page or document into TextChunks with metadata.
 */
export function chunkDocument(
  content: string,
  source: string,
  sourceType: "wiki" | "source" | "memory",
  title: string,
  options: ChunkerOptions = {}
): TextChunk[] {
  const maxChunkSize = options.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  const overlapSize = options.overlapSize ?? DEFAULT_OVERLAP_SIZE;

  const sections = splitIntoSections(content);
  const allChunks: TextChunk[] = [];

  for (const section of sections) {
    if (!section.content.trim()) continue;

    const textChunks = splitTextIntoChunks(section.content, maxChunkSize, overlapSize);

    for (const chunkText of textChunks) {
      allChunks.push({
        id: "", // Will be assigned below
        content: chunkText,
        metadata: {
          source,
          sourceType,
          title,
          section: section.heading,
          lastUpdated: new Date().toISOString(),
          chunkIndex: 0, // Will be assigned below
          totalChunks: 0, // Will be assigned below
        },
      });
    }
  }

  // Assign IDs and indices
  const totalChunks = allChunks.length;
  for (let i = 0; i < allChunks.length; i++) {
    allChunks[i].id = `${source}:${i}`;
    allChunks[i].metadata.chunkIndex = i;
    allChunks[i].metadata.totalChunks = totalChunks;
  }

  return allChunks;
}
