import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { MemoryVectorStore } from '../src/vector/stores/memory.js';
import type { EmbeddingProvider, TextChunk } from '../src/types/vector.js';

/**
 * Mock embedding provider that returns predictable vectors.
 * Each text gets a vector based on its character sum, normalized to unit length.
 */
function createMockEmbeddingProvider(): EmbeddingProvider {
  const dims = 8;

  function textToVector(text: string): number[] {
    const vec = new Array(dims).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % dims] += text.charCodeAt(i);
    }
    // Normalize
    const norm = Math.sqrt(vec.reduce((sum: number, v: number) => sum + v * v, 0));
    return norm > 0 ? vec.map((v: number) => v / norm) : vec;
  }

  return {
    dimensions: dims,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(textToVector);
    },
    async embedQuery(text: string): Promise<number[]> {
      return textToVector(text);
    },
  };
}

function makeChunk(id: string, content: string, source: string): TextChunk {
  return {
    id,
    content,
    metadata: {
      source,
      sourceType: 'wiki',
      title: `Title for ${id}`,
      lastUpdated: new Date().toISOString(),
      chunkIndex: 0,
      totalChunks: 1,
    },
  };
}

describe('MemoryVectorStore', () => {
  let tempDir: string;
  let store: MemoryVectorStore;
  let embeddingProvider: EmbeddingProvider;

  beforeEach(() => {
    tempDir = join(tmpdir(), `withctx-mem-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    embeddingProvider = createMockEmbeddingProvider();
    store = new MemoryVectorStore(tempDir, embeddingProvider);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('initialize() loads from disk if file exists', async () => {
    // Write a pre-existing index
    const indexDir = join(tempDir, 'vector');
    mkdirSync(indexDir, { recursive: true });
    const existingIndex = {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chunks: [
        {
          id: 'existing:0',
          content: 'Pre-existing chunk',
          metadata: {
            source: 'existing',
            sourceType: 'wiki',
            title: 'Existing',
            lastUpdated: new Date().toISOString(),
            chunkIndex: 0,
            totalChunks: 1,
          },
          embedding: [1, 0, 0, 0, 0, 0, 0, 0],
        },
      ],
    };
    writeFileSync(join(indexDir, 'index.json'), JSON.stringify(existingIndex));

    await store.initialize();
    const count = await store.count();
    expect(count).toBe(1);
  });

  it('initialize() starts fresh when no file exists', async () => {
    await store.initialize();
    const count = await store.count();
    expect(count).toBe(0);
  });

  it('addChunks() stores chunks', async () => {
    await store.initialize();
    const chunks = [
      makeChunk('doc:0', 'Hello world', 'doc'),
      makeChunk('doc:1', 'Goodbye world', 'doc'),
    ];
    await store.addChunks(chunks);
    const count = await store.count();
    expect(count).toBe(2);
  });

  it('search() returns results sorted by similarity', async () => {
    await store.initialize();
    const chunks = [
      makeChunk('a:0', 'TypeScript programming language', 'a'),
      makeChunk('b:0', 'JavaScript programming language', 'b'),
      makeChunk('c:0', 'Cooking recipes and food', 'c'),
    ];
    await store.addChunks(chunks);

    const results = await store.search('TypeScript programming');
    expect(results.length).toBeGreaterThan(0);
    // Results should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('search() respects limit parameter', async () => {
    await store.initialize();
    const chunks = [
      makeChunk('a:0', 'First document content', 'a'),
      makeChunk('b:0', 'Second document content', 'b'),
      makeChunk('c:0', 'Third document content', 'c'),
      makeChunk('d:0', 'Fourth document content', 'd'),
    ];
    await store.addChunks(chunks);

    const results = await store.search('document content', 2);
    expect(results.length).toBe(2);
  });

  it('deleteBySource() removes chunks by source', async () => {
    await store.initialize();
    const chunks = [
      makeChunk('a:0', 'Content A', 'source-a'),
      makeChunk('b:0', 'Content B', 'source-b'),
      makeChunk('b:1', 'More B content', 'source-b'),
    ];
    await store.addChunks(chunks);
    expect(await store.count()).toBe(3);

    await store.deleteBySource('source-b');
    expect(await store.count()).toBe(1);
  });

  it('count() returns correct count', async () => {
    await store.initialize();
    expect(await store.count()).toBe(0);

    await store.addChunks([makeChunk('x:0', 'Chunk one', 'x')]);
    expect(await store.count()).toBe(1);

    await store.addChunks([makeChunk('y:0', 'Chunk two', 'y')]);
    expect(await store.count()).toBe(2);
  });

  it('clear() removes all chunks', async () => {
    await store.initialize();
    await store.addChunks([
      makeChunk('a:0', 'Content A', 'a'),
      makeChunk('b:0', 'Content B', 'b'),
    ]);
    expect(await store.count()).toBe(2);

    await store.clear();
    expect(await store.count()).toBe(0);
  });

  it('persists data to disk after addChunks', async () => {
    await store.initialize();
    await store.addChunks([makeChunk('p:0', 'Persisted content', 'p')]);

    const indexPath = join(tempDir, 'vector', 'index.json');
    expect(existsSync(indexPath)).toBe(true);
  });

  it('addChunks() updates existing chunk with same ID', async () => {
    await store.initialize();
    await store.addChunks([makeChunk('doc:0', 'Original content', 'doc')]);
    expect(await store.count()).toBe(1);

    await store.addChunks([makeChunk('doc:0', 'Updated content', 'doc')]);
    expect(await store.count()).toBe(1);
  });
});
