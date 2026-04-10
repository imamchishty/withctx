import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * A single entry in the sync hash index — tracks the content hash for
 * a given document so subsequent syncs can determine whether it changed.
 */
export interface SyncIndexEntry {
  documentId: string;
  contentHash: string; // SHA-256 of content (hex)
  lastSeenAt: string; // ISO timestamp
  wikiPages: string[]; // wiki pages that reference this doc
}

/**
 * Persisted sync index — maps document IDs to their content hashes
 * and the wiki pages they contribute to.
 */
export interface SyncIndex {
  version: 1;
  lastSync: string;
  entries: Record<string, SyncIndexEntry>;
}

/**
 * Diff between an old index and a new set of documents.
 */
export interface SyncDiff {
  unchanged: string[]; // document ids
  changed: string[];
  added: string[];
  removed: string[];
}

/**
 * Creates a fresh empty index.
 */
export function emptyIndex(): SyncIndex {
  return {
    version: 1,
    lastSync: new Date(0).toISOString(),
    entries: {},
  };
}

/**
 * Manages the persisted document hash index at `.ctx/sync-index.json`.
 *
 * Used by `ctx sync` to skip re-processing documents whose content
 * hasn't changed since the last run.
 */
export class HashIndex {
  private filePath: string;

  constructor(private ctxDir: string) {
    this.filePath = join(ctxDir, "sync-index.json");
  }

  /**
   * Load the existing index from disk, returning an empty index if the
   * file is missing or corrupt.
   */
  async load(): Promise<SyncIndex> {
    if (!existsSync(this.filePath)) {
      return emptyIndex();
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("version" in parsed) ||
        (parsed as { version: unknown }).version !== 1 ||
        !("entries" in parsed) ||
        typeof (parsed as { entries: unknown }).entries !== "object"
      ) {
        return emptyIndex();
      }
      const index = parsed as SyncIndex;
      if (!index.lastSync) index.lastSync = new Date(0).toISOString();
      if (!index.entries) index.entries = {};
      return index;
    } catch {
      return emptyIndex();
    }
  }

  /**
   * Save the index to disk, creating the directory if needed.
   */
  async save(index: SyncIndex): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const toWrite: SyncIndex = {
      version: 1,
      lastSync: index.lastSync ?? new Date().toISOString(),
      entries: index.entries ?? {},
    };
    writeFileSync(this.filePath, JSON.stringify(toWrite, null, 2));
  }

  /**
   * Compute a SHA-256 hex digest of content.
   */
  hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Classify a batch of new documents relative to an existing index.
   *
   * `newDocs` is a map of `documentId` to content hash (computed with
   * `hashContent`). The diff reports which ids are unchanged, which have
   * new hashes, which are new, and which were in the index but are gone.
   */
  diff(
    oldIndex: SyncIndex,
    newDocs: Map<string, string>
  ): SyncDiff {
    const unchanged: string[] = [];
    const changed: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];

    const oldEntries = oldIndex.entries ?? {};

    for (const [id, hash] of newDocs) {
      const existing = oldEntries[id];
      if (!existing) {
        added.push(id);
      } else if (existing.contentHash === hash) {
        unchanged.push(id);
      } else {
        changed.push(id);
      }
    }

    for (const id of Object.keys(oldEntries)) {
      if (!newDocs.has(id)) {
        removed.push(id);
      }
    }

    return { unchanged, changed, added, removed };
  }
}
