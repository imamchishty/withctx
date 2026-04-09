import { createHash } from "node:crypto";
import type { RawDocument } from "../types/source.js";

export interface DedupResult {
  unique: RawDocument[];
  duplicates: Array<{ doc: RawDocument; duplicateOf: string }>;
}

/**
 * Deduplicate documents by content hash.
 *
 * - Different sources, same hash: keep the one updated most recently.
 * - Same source, same hash: keep the first one encountered.
 */
export function deduplicateDocs(docs: RawDocument[]): DedupResult {
  const unique: RawDocument[] = [];
  const duplicates: Array<{ doc: RawDocument; duplicateOf: string }> = [];

  // Map: hash -> { doc, index in unique[] }
  const seen = new Map<string, { doc: RawDocument; index: number }>();

  for (const doc of docs) {
    const hash = createHash("sha256")
      .update(doc.content)
      .digest("hex")
      .slice(0, 16);

    const existing = seen.get(hash);

    if (!existing) {
      // First time seeing this content
      const index = unique.length;
      unique.push(doc);
      seen.set(hash, { doc, index });
      continue;
    }

    // Duplicate found — decide which to keep
    if (doc.sourceName === existing.doc.sourceName) {
      // Same source: keep the first one (existing), discard this one
      duplicates.push({ doc, duplicateOf: existing.doc.id });
    } else {
      // Different sources: keep the one updated most recently
      const existingDate = existing.doc.updatedAt
        ? new Date(existing.doc.updatedAt).getTime()
        : 0;
      const newDate = doc.updatedAt
        ? new Date(doc.updatedAt).getTime()
        : 0;

      if (newDate > existingDate) {
        // New doc is more recent — replace the existing one
        duplicates.push({ doc: existing.doc, duplicateOf: doc.id });
        unique[existing.index] = doc;
        seen.set(hash, { doc, index: existing.index });
      } else {
        // Existing is more recent (or equal) — discard new one
        duplicates.push({ doc, duplicateOf: existing.doc.id });
      }
    }
  }

  return { unique, duplicates };
}
