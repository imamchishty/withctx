import { describe, it, expect } from 'vitest';
import { chunkDocument } from '../src/vector/chunker.js';

describe('chunkDocument', () => {
  it('chunks short content into a single chunk', () => {
    const chunks = chunkDocument('Hello world', 'doc1', 'wiki', 'Test Doc');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Hello world');
  });

  it('splits long content into multiple chunks', () => {
    // Create content larger than default maxChunkSize (2048)
    const longContent = 'A'.repeat(5000);
    const chunks = chunkDocument(longContent, 'doc1', 'wiki', 'Test Doc');
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('preserves code blocks — never splits inside ```', () => {
    const codeBlock = '```\n' + 'const x = 1;\n'.repeat(20) + '```';
    const content = 'Intro paragraph.\n\n' + codeBlock + '\n\nAfter code.';
    const chunks = chunkDocument(content, 'doc1', 'source', 'Code Doc', {
      maxChunkSize: 500,
    });

    // The code block should be kept intact in one chunk
    const chunkWithCode = chunks.find(c => c.content.includes('```'));
    expect(chunkWithCode).toBeDefined();
    const backtickCount = (chunkWithCode!.content.match(/```/g) || []).length;
    // Should have even number of ``` (complete code block)
    expect(backtickCount % 2).toBe(0);
  });

  it('assigns correct IDs (source:0, source:1, etc)', () => {
    const longContent = 'Word '.repeat(1000);
    const chunks = chunkDocument(longContent, 'my-source', 'wiki', 'Title');
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].id).toBe(`my-source:${i}`);
    }
  });

  it('sets correct chunkIndex and totalChunks', () => {
    const longContent = 'Word '.repeat(1000);
    const chunks = chunkDocument(longContent, 'doc1', 'wiki', 'Title');
    const total = chunks.length;
    expect(total).toBeGreaterThan(1);

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].metadata.chunkIndex).toBe(i);
      expect(chunks[i].metadata.totalChunks).toBe(total);
    }
  });

  it('handles empty content', () => {
    const chunks = chunkDocument('', 'doc1', 'wiki', 'Empty');
    expect(chunks).toHaveLength(0);
  });

  it('respects maxChunkSize option', () => {
    const content = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.\n\nParagraph four.';
    const chunks = chunkDocument(content, 'doc1', 'wiki', 'Title', {
      maxChunkSize: 30,
    });
    // With a very small maxChunkSize, we should get multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('splits on paragraph boundaries when possible', () => {
    // Build content with clear paragraph boundaries that exceeds maxChunkSize
    const para1 = 'First paragraph content here. ' .repeat(10).trim();
    const para2 = 'Second paragraph content here. '.repeat(10).trim();
    const content = para1 + '\n\n' + para2;

    const chunks = chunkDocument(content, 'doc1', 'wiki', 'Title', {
      maxChunkSize: 350,
    });

    if (chunks.length > 1) {
      // The first chunk should not end mid-word if paragraph split is possible
      // It should end cleanly (trimmed, no partial words at very end)
      expect(chunks[0].content).toBe(chunks[0].content.trim());
    }
  });

  it('sets correct metadata fields', () => {
    const chunks = chunkDocument('Some content', 'src/file.ts', 'source', 'My Title');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.source).toBe('src/file.ts');
    expect(chunks[0].metadata.sourceType).toBe('source');
    expect(chunks[0].metadata.title).toBe('My Title');
    expect(chunks[0].metadata.lastUpdated).toBeDefined();
  });

  it('handles content with markdown headings as sections', () => {
    const content = '# Section One\n\nContent for section one.\n\n# Section Two\n\nContent for section two.';
    const chunks = chunkDocument(content, 'doc1', 'wiki', 'Headed Doc');
    // Should produce chunks with section metadata
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].metadata.section).toBe('Section One');
    expect(chunks[1].metadata.section).toBe('Section Two');
  });
});
