import type { RawDocument } from "../types/source.js";
import { validateBatch } from "./validator.js";
import { deduplicateDocs } from "./dedup.js";
import { scoreFreshness } from "./freshness.js";

export interface QualityPipelineResult {
  documents: RawDocument[];
  stats: {
    inputCount: number;
    validCount: number;
    dedupedCount: number;
    rejectedCount: number;
    freshness: { fresh: number; aging: number; stale: number; unknown: number };
    warnings: string[];
  };
}

/**
 * Run the full quality pipeline: validate -> deduplicate -> score freshness.
 * Returns clean documents and aggregate stats.
 */
export function runQualityPipeline(docs: RawDocument[]): QualityPipelineResult {
  const warnings: string[] = [];

  // Step 1: Validate
  const { docs: validDocs, stats: validationStats } = validateBatch(docs);

  if (validationStats.rejected > 0) {
    const reasonSummary = Object.entries(validationStats.reasons)
      .map(([reason, count]) => `${reason} (${count})`)
      .join(", ");
    warnings.push(
      `Rejected ${validationStats.rejected} documents: ${reasonSummary}`
    );
  }

  if (validationStats.warnings > 0) {
    warnings.push(
      `${validationStats.warnings} documents had validation warnings`
    );
  }

  // Step 2: Deduplicate
  const { unique, duplicates } = deduplicateDocs(validDocs);

  if (duplicates.length > 0) {
    warnings.push(
      `Removed ${duplicates.length} duplicate documents`
    );
  }

  // Step 3: Score freshness
  const freshnessScores = scoreFreshness(unique);
  const freshness = { fresh: 0, aging: 0, stale: 0, unknown: 0 };
  for (const score of freshnessScores) {
    freshness[score.score]++;
  }

  if (freshness.stale > 0) {
    warnings.push(`${freshness.stale} documents are stale (>30 days old)`);
  }

  return {
    documents: unique,
    stats: {
      inputCount: docs.length,
      validCount: validationStats.valid,
      dedupedCount: duplicates.length,
      rejectedCount: validationStats.rejected,
      freshness,
      warnings,
    },
  };
}

// Re-export submodules for direct access
export { validateDocument, validateBatch } from "./validator.js";
export type { ValidationResult, ValidationStats } from "./validator.js";
export { deduplicateDocs } from "./dedup.js";
export type { DedupResult } from "./dedup.js";
export { scoreFreshness, scoreWikiFreshness } from "./freshness.js";
export type { FreshnessScore } from "./freshness.js";
export { createAttributions, formatAttributionFooter } from "./attribution.js";
export type { Attribution } from "./attribution.js";
