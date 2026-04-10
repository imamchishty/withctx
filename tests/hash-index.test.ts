import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { HashIndex, emptyIndex, type SyncIndex } from "../src/sync/hash-index.js";

describe("HashIndex", () => {
  let tempDir: string;
  let hashIndex: HashIndex;

  beforeEach(() => {
    tempDir = join(tmpdir(), `withctx-hash-index-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    hashIndex = new HashIndex(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("hashContent", () => {
    it("produces stable SHA-256 hex digests for the same input", () => {
      const a = hashIndex.hashContent("hello world");
      const b = hashIndex.hashContent("hello world");
      expect(a).toBe(b);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    it("produces different hashes for different inputs", () => {
      const a = hashIndex.hashContent("hello");
      const b = hashIndex.hashContent("world");
      expect(a).not.toBe(b);
    });

    it("produces a known SHA-256 hash for 'hello world'", () => {
      const hash = hashIndex.hashContent("hello world");
      // Known SHA-256 digest for the string "hello world"
      expect(hash).toBe(
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
      );
    });
  });

  describe("diff", () => {
    it("classifies everything as added when the index is empty", () => {
      const index = emptyIndex();
      const newDocs = new Map<string, string>([
        ["doc1", "hash1"],
        ["doc2", "hash2"],
      ]);
      const diff = hashIndex.diff(index, newDocs);

      expect(diff.added.sort()).toEqual(["doc1", "doc2"]);
      expect(diff.unchanged).toEqual([]);
      expect(diff.changed).toEqual([]);
      expect(diff.removed).toEqual([]);
    });

    it("classifies unchanged docs correctly when hashes match", () => {
      const index: SyncIndex = {
        version: 1,
        lastSync: "2025-01-01T00:00:00.000Z",
        entries: {
          doc1: {
            documentId: "doc1",
            contentHash: "hash1",
            lastSeenAt: "2025-01-01T00:00:00.000Z",
            wikiPages: ["page-a.md"],
          },
          doc2: {
            documentId: "doc2",
            contentHash: "hash2",
            lastSeenAt: "2025-01-01T00:00:00.000Z",
            wikiPages: ["page-b.md"],
          },
        },
      };
      const newDocs = new Map([
        ["doc1", "hash1"],
        ["doc2", "hash2"],
      ]);

      const diff = hashIndex.diff(index, newDocs);
      expect(diff.unchanged.sort()).toEqual(["doc1", "doc2"]);
      expect(diff.changed).toEqual([]);
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
    });

    it("detects content changes when hashes differ", () => {
      const index: SyncIndex = {
        version: 1,
        lastSync: "2025-01-01T00:00:00.000Z",
        entries: {
          doc1: {
            documentId: "doc1",
            contentHash: "old-hash",
            lastSeenAt: "2025-01-01T00:00:00.000Z",
            wikiPages: ["page-a.md"],
          },
        },
      };
      const newDocs = new Map([["doc1", "new-hash"]]);

      const diff = hashIndex.diff(index, newDocs);
      expect(diff.changed).toEqual(["doc1"]);
      expect(diff.unchanged).toEqual([]);
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
    });

    it("detects removed docs that are in the index but not in new docs", () => {
      const index: SyncIndex = {
        version: 1,
        lastSync: "2025-01-01T00:00:00.000Z",
        entries: {
          doc1: {
            documentId: "doc1",
            contentHash: "hash1",
            lastSeenAt: "2025-01-01T00:00:00.000Z",
            wikiPages: ["page-a.md"],
          },
          doc2: {
            documentId: "doc2",
            contentHash: "hash2",
            lastSeenAt: "2025-01-01T00:00:00.000Z",
            wikiPages: ["page-b.md"],
          },
        },
      };
      const newDocs = new Map([["doc1", "hash1"]]);

      const diff = hashIndex.diff(index, newDocs);
      expect(diff.removed).toEqual(["doc2"]);
      expect(diff.unchanged).toEqual(["doc1"]);
      expect(diff.changed).toEqual([]);
      expect(diff.added).toEqual([]);
    });

    it("handles a mixed scenario with unchanged, changed, added, and removed docs", () => {
      const index: SyncIndex = {
        version: 1,
        lastSync: "2025-01-01T00:00:00.000Z",
        entries: {
          keep: {
            documentId: "keep",
            contentHash: "hash-keep",
            lastSeenAt: "2025-01-01T00:00:00.000Z",
            wikiPages: [],
          },
          update: {
            documentId: "update",
            contentHash: "old-hash",
            lastSeenAt: "2025-01-01T00:00:00.000Z",
            wikiPages: [],
          },
          gone: {
            documentId: "gone",
            contentHash: "hash-gone",
            lastSeenAt: "2025-01-01T00:00:00.000Z",
            wikiPages: [],
          },
        },
      };
      const newDocs = new Map([
        ["keep", "hash-keep"],
        ["update", "new-hash"],
        ["brand-new", "hash-new"],
      ]);

      const diff = hashIndex.diff(index, newDocs);
      expect(diff.unchanged).toEqual(["keep"]);
      expect(diff.changed).toEqual(["update"]);
      expect(diff.added).toEqual(["brand-new"]);
      expect(diff.removed).toEqual(["gone"]);
    });
  });

  describe("save/load", () => {
    it("roundtrips an index through disk without losing data", async () => {
      const original: SyncIndex = {
        version: 1,
        lastSync: "2025-06-15T12:34:56.000Z",
        entries: {
          "doc-1": {
            documentId: "doc-1",
            contentHash: "abc123",
            lastSeenAt: "2025-06-15T12:34:56.000Z",
            wikiPages: ["architecture.md", "overview.md"],
          },
        },
      };

      await hashIndex.save(original);
      const loaded = await hashIndex.load();

      expect(loaded).toEqual(original);
    });

    it("writes the version field to disk", async () => {
      const index: SyncIndex = {
        version: 1,
        lastSync: "2025-06-15T12:34:56.000Z",
        entries: {},
      };

      await hashIndex.save(index);

      const raw = readFileSync(join(tempDir, "sync-index.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.lastSync).toBe("2025-06-15T12:34:56.000Z");
    });

    it("creates the parent directory if it does not exist", async () => {
      const nestedDir = join(tempDir, "nested", "sub");
      const nested = new HashIndex(nestedDir);
      const index: SyncIndex = {
        version: 1,
        lastSync: "2025-01-01T00:00:00.000Z",
        entries: {},
      };

      await nested.save(index);
      expect(existsSync(join(nestedDir, "sync-index.json"))).toBe(true);
    });

    it("returns an empty index when the file does not exist", async () => {
      const loaded = await hashIndex.load();
      expect(loaded.version).toBe(1);
      expect(loaded.entries).toEqual({});
    });

    it("gracefully handles a corrupt/invalid index file", async () => {
      writeFileSync(join(tempDir, "sync-index.json"), "not valid json {{");
      const loaded = await hashIndex.load();
      expect(loaded.version).toBe(1);
      expect(loaded.entries).toEqual({});
    });

    it("gracefully handles an index file with the wrong shape", async () => {
      writeFileSync(
        join(tempDir, "sync-index.json"),
        JSON.stringify({ foo: "bar" })
      );
      const loaded = await hashIndex.load();
      expect(loaded.version).toBe(1);
      expect(loaded.entries).toEqual({});
    });
  });
});
