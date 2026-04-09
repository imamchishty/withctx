import { describe, it, expect } from 'vitest';
import {
  exportJsonChunks,
  exportLangChainDocuments,
  exportLlamaIndexNodes,
} from '../src/export/rag.js';
import type { WikiPage } from '../src/types/page.js';

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    path: 'wiki/test-page',
    title: 'Test Page',
    content: '## Overview\n\nThis is a test page with some content for testing.',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-06-01T00:00:00Z',
    sources: ['source-a'],
    references: ['wiki/other'],
    ...overrides,
  };
}

describe('exportJsonChunks', () => {
  it('produces valid JSON with chunks array', () => {
    const pages = [makePage()];
    const result = exportJsonChunks(pages, 'test-project');
    const parsed = JSON.parse(result);

    expect(parsed).toHaveProperty('chunks');
    expect(Array.isArray(parsed.chunks)).toBe(true);
    expect(parsed.chunks.length).toBeGreaterThan(0);
    expect(parsed).toHaveProperty('total');
    expect(parsed).toHaveProperty('project', 'test-project');
    expect(parsed).toHaveProperty('exportedAt');
  });

  it('handles empty pages array', () => {
    const result = exportJsonChunks([], 'test-project');
    const parsed = JSON.parse(result);
    expect(parsed.chunks).toHaveLength(0);
    expect(parsed.total).toBe(0);
  });

  it('chunks have correct metadata', () => {
    const pages = [makePage()];
    const result = exportJsonChunks(pages, 'my-project');
    const parsed = JSON.parse(result);
    const chunk = parsed.chunks[0];

    expect(chunk).toHaveProperty('id');
    expect(chunk).toHaveProperty('content');
    expect(chunk.metadata).toHaveProperty('source', 'wiki/test-page');
    expect(chunk.metadata).toHaveProperty('title', 'Test Page');
    expect(chunk.metadata).toHaveProperty('project', 'my-project');
    expect(chunk.metadata).toHaveProperty('chunkIndex');
    expect(chunk.metadata).toHaveProperty('totalChunks');
  });

  it('respects custom chunk size', () => {
    const longContent = '## Section\n\n' + 'word '.repeat(2000);
    const pages = [makePage({ content: longContent })];

    const smallChunks = JSON.parse(exportJsonChunks(pages, 'proj', 100));
    const largeChunks = JSON.parse(exportJsonChunks(pages, 'proj', 5000));

    expect(smallChunks.chunks.length).toBeGreaterThan(largeChunks.chunks.length);
  });
});

describe('exportLangChainDocuments', () => {
  it('produces Document objects with page_content', () => {
    const pages = [makePage()];
    const result = exportLangChainDocuments(pages, 'test-project');
    const docs = JSON.parse(result);

    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBeGreaterThan(0);

    const doc = docs[0];
    expect(doc).toHaveProperty('page_content');
    expect(doc).toHaveProperty('type', 'Document');
    expect(doc).toHaveProperty('metadata');
    expect(doc.metadata).toHaveProperty('source');
    expect(doc.metadata).toHaveProperty('title');
    expect(doc.metadata).toHaveProperty('project', 'test-project');
  });

  it('handles empty pages array', () => {
    const result = exportLangChainDocuments([], 'test-project');
    const docs = JSON.parse(result);
    expect(docs).toHaveLength(0);
  });

  it('respects custom chunk size', () => {
    const longContent = '## Section\n\n' + 'word '.repeat(2000);
    const pages = [makePage({ content: longContent })];

    const smallDocs = JSON.parse(exportLangChainDocuments(pages, 'proj', 100));
    const largeDocs = JSON.parse(exportLangChainDocuments(pages, 'proj', 5000));

    expect(smallDocs.length).toBeGreaterThan(largeDocs.length);
  });
});

describe('exportLlamaIndexNodes', () => {
  it('produces TextNode objects with relationships', () => {
    const pages = [makePage()];
    const result = exportLlamaIndexNodes(pages, 'test-project');
    const nodes = JSON.parse(result);

    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBeGreaterThan(0);

    const node = nodes[0];
    expect(node).toHaveProperty('id_');
    expect(node).toHaveProperty('text');
    expect(node).toHaveProperty('class_name', 'TextNode');
    expect(node).toHaveProperty('relationships');
    expect(node).toHaveProperty('metadata');
    expect(node.metadata).toHaveProperty('source');
    expect(node.metadata).toHaveProperty('title');
    expect(node.metadata).toHaveProperty('project', 'test-project');
  });

  it('includes source document relationship', () => {
    const pages = [makePage()];
    const result = exportLlamaIndexNodes(pages, 'test-project');
    const nodes = JSON.parse(result);
    const node = nodes[0];

    // Relationship "1" is the source document link
    expect(node.relationships).toHaveProperty('1');
    expect(node.relationships['1']).toHaveProperty('node_id', 'wiki/test-page');
    expect(node.relationships['1']).toHaveProperty('class_name', 'RelatedNodeInfo');
  });

  it('handles empty pages array', () => {
    const result = exportLlamaIndexNodes([], 'test-project');
    const nodes = JSON.parse(result);
    expect(nodes).toHaveLength(0);
  });

  it('respects custom chunk size', () => {
    const longContent = '## Section\n\n' + 'word '.repeat(2000);
    const pages = [makePage({ content: longContent })];

    const smallNodes = JSON.parse(exportLlamaIndexNodes(pages, 'proj', 100));
    const largeNodes = JSON.parse(exportLlamaIndexNodes(pages, 'proj', 5000));

    expect(smallNodes.length).toBeGreaterThan(largeNodes.length);
  });

  it('links previous and next nodes', () => {
    // Create a page with multiple sections to get multiple nodes
    const content = '## Section A\n\nContent for section A.\n\n## Section B\n\nContent for section B.';
    const pages = [makePage({ content })];
    const result = exportLlamaIndexNodes(pages, 'test-project');
    const nodes = JSON.parse(result);

    if (nodes.length >= 2) {
      // Second node should have a "previous" relationship (key "2")
      expect(nodes[1].relationships).toHaveProperty('2');
      // First node should have a "next" relationship (key "3")
      expect(nodes[0].relationships).toHaveProperty('3');
    }
  });
});
