import type { WikiPage } from "../types/page.js";

/**
 * RAG-ready export formats for vector databases, LangChain, LlamaIndex, etc.
 */

// --- Types ---

interface RAGChunk {
  id: string;
  content: string;
  metadata: {
    source: string;
    title: string;
    section?: string;
    updatedAt: string;
    project: string;
    chunkIndex: number;
    totalChunks: number;
  };
}

interface LangChainDocument {
  page_content: string;
  metadata: Record<string, unknown>;
  type: "Document";
}

interface LlamaIndexTextNode {
  id_: string;
  text: string;
  metadata: Record<string, unknown>;
  excluded_embed_metadata_keys: string[];
  excluded_llm_metadata_keys: string[];
  relationships: Record<string, unknown>;
  class_name: "TextNode";
}

// --- Chunking ---

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_OVERLAP = 50;

function chunkText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_OVERLAP
): string[] {
  const chunks: string[] = [];
  const words = text.split(/\s+/);

  if (words.length <= chunkSize) {
    return [text];
  }

  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push(words.slice(start, end).join(" "));
    start = end - overlap;
    if (start >= words.length) break;
  }

  return chunks;
}

function splitBySection(content: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  const lines = content.split("\n");
  let currentHeading = "";
  let currentBody: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      if (currentBody.length > 0) {
        sections.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
      }
      currentHeading = headingMatch[1];
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }

  if (currentBody.length > 0) {
    sections.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
  }

  return sections.filter((s) => s.body.length > 0);
}

// --- Export: JSON Chunks ---

export function exportJsonChunks(
  pages: WikiPage[],
  project: string,
  chunkSize?: number
): string {
  const chunks: RAGChunk[] = [];

  for (const page of pages) {
    const sections = splitBySection(page.content);

    for (const section of sections) {
      const textChunks = chunkText(section.body, chunkSize);

      for (let i = 0; i < textChunks.length; i++) {
        chunks.push({
          id: `${page.path}:${section.heading || "root"}:${i}`,
          content: textChunks[i],
          metadata: {
            source: page.path,
            title: page.title,
            section: section.heading || undefined,
            updatedAt: page.updatedAt,
            project,
            chunkIndex: i,
            totalChunks: textChunks.length,
          },
        });
      }
    }
  }

  return JSON.stringify({ chunks, total: chunks.length, project, exportedAt: new Date().toISOString() }, null, 2);
}

// --- Export: LangChain Documents ---

export function exportLangChainDocuments(
  pages: WikiPage[],
  project: string,
  chunkSize?: number
): string {
  const documents: LangChainDocument[] = [];

  for (const page of pages) {
    const sections = splitBySection(page.content);

    for (const section of sections) {
      const textChunks = chunkText(section.body, chunkSize);

      for (let i = 0; i < textChunks.length; i++) {
        documents.push({
          page_content: textChunks[i],
          metadata: {
            source: page.path,
            title: page.title,
            section: section.heading || undefined,
            updated_at: page.updatedAt,
            project,
            chunk_index: i,
            total_chunks: textChunks.length,
          },
          type: "Document",
        });
      }
    }
  }

  return JSON.stringify(documents, null, 2);
}

// --- Export: LlamaIndex TextNodes ---

export function exportLlamaIndexNodes(
  pages: WikiPage[],
  project: string,
  chunkSize?: number
): string {
  const nodes: LlamaIndexTextNode[] = [];

  for (const page of pages) {
    const sections = splitBySection(page.content);
    let prevNodeId: string | undefined;

    for (const section of sections) {
      const textChunks = chunkText(section.body, chunkSize);

      for (let i = 0; i < textChunks.length; i++) {
        const nodeId = `${page.path}:${section.heading || "root"}:${i}`;
        const relationships: Record<string, unknown> = {};

        // Link to source document
        relationships["1"] = {
          node_id: page.path,
          node_type: "4",
          metadata: { title: page.title },
          class_name: "RelatedNodeInfo",
        };

        // Link to previous node
        if (prevNodeId) {
          relationships["2"] = {
            node_id: prevNodeId,
            node_type: "1",
            class_name: "RelatedNodeInfo",
          };
        }

        // Link to next node (set on previous node)
        if (nodes.length > 0 && prevNodeId) {
          const prev = nodes[nodes.length - 1];
          prev.relationships["3"] = {
            node_id: nodeId,
            node_type: "1",
            class_name: "RelatedNodeInfo",
          };
        }

        nodes.push({
          id_: nodeId,
          text: textChunks[i],
          metadata: {
            source: page.path,
            title: page.title,
            section: section.heading || undefined,
            updated_at: page.updatedAt,
            project,
            chunk_index: i,
            total_chunks: textChunks.length,
          },
          excluded_embed_metadata_keys: ["chunk_index", "total_chunks"],
          excluded_llm_metadata_keys: [],
          relationships,
          class_name: "TextNode",
        });

        prevNodeId = nodeId;
      }
    }
  }

  return JSON.stringify(nodes, null, 2);
}
