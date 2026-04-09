import { createHash } from "node:crypto";
import type { RawDocument } from "../types/source.js";

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
  doc: RawDocument;
}

export interface ValidationStats {
  total: number;
  valid: number;
  warnings: number;
  rejected: number;
  reasons: Record<string, number>;
}

/**
 * Validate a single raw document before compilation.
 */
export function validateDocument(doc: RawDocument): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Missing sourceType — reject
  if (!doc.sourceType) {
    errors.push("Missing sourceType");
  }

  // Empty content — reject
  if (!doc.content || doc.content.trim().length === 0) {
    errors.push("Empty content");
  }

  // Binary content with no text — reject
  if (doc.contentType === "binary" && (!doc.content || doc.content.trim().length === 0)) {
    errors.push("Binary content with no text");
  }

  // Too short — warn
  if (doc.content && doc.content.trim().length > 0 && doc.content.trim().length < 50) {
    warnings.push(`Content too short (${doc.content.trim().length} chars)`);
  }

  // Too long — warn
  if (doc.content && doc.content.length > 100_000) {
    warnings.push(`Content too long (${doc.content.length} chars, may need splitting)`);
  }

  // Missing title — warn and use id as fallback
  if (!doc.title || doc.title.trim().length === 0) {
    warnings.push("Missing title, using id as fallback");
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
    doc: !doc.title || doc.title.trim().length === 0
      ? { ...doc, title: doc.id }
      : doc,
  };
}

/**
 * Validate a batch of documents, returning only valid ones plus stats.
 */
export function validateBatch(
  docs: RawDocument[]
): { docs: RawDocument[]; stats: ValidationStats } {
  const stats: ValidationStats = {
    total: docs.length,
    valid: 0,
    warnings: 0,
    rejected: 0,
    reasons: {},
  };

  const validDocs: RawDocument[] = [];
  const seenHashes = new Map<string, string>(); // hash -> doc id

  for (const doc of docs) {
    const result = validateDocument(doc);

    if (!result.valid) {
      stats.rejected++;
      for (const err of result.errors) {
        stats.reasons[err] = (stats.reasons[err] ?? 0) + 1;
      }
      continue;
    }

    // Duplicate detection via content hash
    const hash = createHash("sha256")
      .update(result.doc.content)
      .digest("hex")
      .slice(0, 16);

    if (seenHashes.has(hash)) {
      const reason = `Duplicate content (same as ${seenHashes.get(hash)})`;
      result.warnings.push(reason);
      stats.reasons["Duplicate content"] = (stats.reasons["Duplicate content"] ?? 0) + 1;
    } else {
      seenHashes.set(hash, result.doc.id);
    }

    if (result.warnings.length > 0) {
      stats.warnings++;
    }

    stats.valid++;
    validDocs.push(result.doc);
  }

  return { docs: validDocs, stats };
}
