import type { RawDocument } from "../types/source.js";
import type { WikiPage } from "../types/page.js";

export interface FreshnessScore {
  source: string;
  title: string;
  updatedAt: string | undefined;
  ageInDays: number;
  score: "fresh" | "aging" | "stale" | "unknown";
}

/**
 * Calculate the age in days from a date string to now.
 */
function ageInDays(dateStr: string | undefined): number {
  if (!dateStr) return -1;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return -1;
  const now = Date.now();
  return Math.floor((now - date.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Map age in days to a freshness score.
 */
function toScore(days: number): FreshnessScore["score"] {
  if (days < 0) return "unknown";
  if (days < 7) return "fresh";
  if (days <= 30) return "aging";
  return "stale";
}

/**
 * Score freshness of raw documents.
 */
export function scoreFreshness(docs: RawDocument[]): FreshnessScore[] {
  return docs.map((doc) => {
    const days = ageInDays(doc.updatedAt);
    return {
      source: doc.sourceName,
      title: doc.title,
      updatedAt: doc.updatedAt,
      ageInDays: days < 0 ? 0 : days,
      score: toScore(days),
    };
  });
}

/**
 * Score freshness of wiki pages.
 */
export function scoreWikiFreshness(pages: WikiPage[]): FreshnessScore[] {
  return pages.map((page) => {
    const days = ageInDays(page.updatedAt);
    return {
      source: page.path,
      title: page.title,
      updatedAt: page.updatedAt,
      ageInDays: days < 0 ? 0 : days,
      score: toScore(days),
    };
  });
}
