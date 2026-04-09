import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { LocalFilesConnector } from '../src/connectors/local-files.js';

describe('LocalFilesConnector', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `withctx-local-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates connector with name and path', () => {
    const connector = new LocalFilesConnector('test-source', tempDir);
    expect(connector.name).toBe('test-source');
    expect(connector.type).toBe('local');
  });

  it('validate() returns true for existing directory', async () => {
    const connector = new LocalFilesConnector('test', tempDir);
    const result = await connector.validate();
    expect(result).toBe(true);
  });

  it('validate() returns false for non-existent path', async () => {
    const connector = new LocalFilesConnector('test', '/tmp/nonexistent-path-' + randomUUID());
    const result = await connector.validate();
    expect(result).toBe(false);
  });

  it('fetch() yields RawDocument objects for text files', async () => {
    writeFileSync(join(tempDir, 'readme.md'), '# Hello\nWorld');
    writeFileSync(join(tempDir, 'app.ts'), 'const x = 1;');

    const connector = new LocalFilesConnector('test', tempDir);
    const docs: any[] = [];
    for await (const doc of connector.fetch()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(2);
    for (const doc of docs) {
      expect(doc).toHaveProperty('id');
      expect(doc).toHaveProperty('content');
      expect(doc).toHaveProperty('sourceType', 'local');
      expect(doc).toHaveProperty('sourceName', 'test');
      expect(doc).toHaveProperty('title');
      expect(doc).toHaveProperty('contentType');
      expect(doc).toHaveProperty('metadata');
    }
  });

  it('fetch() skips node_modules and .git directories', async () => {
    mkdirSync(join(tempDir, 'node_modules'), { recursive: true });
    writeFileSync(join(tempDir, 'node_modules', 'lib.js'), 'module.exports = {}');
    mkdirSync(join(tempDir, '.git'), { recursive: true });
    writeFileSync(join(tempDir, '.git', 'config'), '[core]');
    writeFileSync(join(tempDir, 'index.ts'), 'export {};');

    const connector = new LocalFilesConnector('test', tempDir);
    const docs: any[] = [];
    for await (const doc of connector.fetch()) {
      docs.push(doc);
    }

    expect(docs.length).toBe(1);
    expect(docs[0].title).toBe('index.ts');
  });

  it('fetch() respects file extensions — only reads scannable types', async () => {
    writeFileSync(join(tempDir, 'data.ts'), 'const a = 1;');
    writeFileSync(join(tempDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(tempDir, 'archive.zip'), Buffer.from([0x50, 0x4b]));

    const connector = new LocalFilesConnector('test', tempDir);
    const docs: any[] = [];
    for await (const doc of connector.fetch()) {
      docs.push(doc);
    }

    // Only the .ts file should be yielded; .png and .zip are not in TEXT_EXTENSIONS
    expect(docs.length).toBe(1);
    expect(docs[0].title).toBe('data.ts');
  });

  it('getStatus() returns correct status', async () => {
    const connector = new LocalFilesConnector('test', tempDir);
    let status = connector.getStatus();
    expect(status.name).toBe('test');
    expect(status.type).toBe('local');
    expect(status.status).toBe('disconnected');

    await connector.validate();
    status = connector.getStatus();
    expect(status.status).toBe('connected');
  });

  it('getStatus() returns error status for invalid path', async () => {
    const connector = new LocalFilesConnector('bad', '/tmp/no-such-dir-' + randomUUID());
    await connector.validate();
    const status = connector.getStatus();
    expect(status.status).toBe('error');
    expect(status.error).toBeDefined();
  });

  it('fetch() updates status after successful sync', async () => {
    writeFileSync(join(tempDir, 'file.md'), '# Doc');
    const connector = new LocalFilesConnector('test', tempDir);

    const docs: any[] = [];
    for await (const doc of connector.fetch()) {
      docs.push(doc);
    }

    const status = connector.getStatus();
    expect(status.status).toBe('connected');
    expect(status.lastSyncAt).toBeDefined();
    expect(status.itemCount).toBe(1);
  });
});
