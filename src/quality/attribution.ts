import type { RawDocument } from "../types/source.js";

export interface Attribution {
  wikiPage: string;
  sources: Array<{
    id: string;
    sourceType: string;
    sourceName: string;
    title: string;
  }>;
  compiledAt: string;
}

/**
 * Create an attribution record linking a wiki page to its source documents.
 */
export function createAttributions(
  wikiPagePath: string,
  sourceDocs: RawDocument[]
): Attribution {
  return {
    wikiPage: wikiPagePath,
    sources: sourceDocs.map((doc) => ({
      id: doc.id,
      sourceType: doc.sourceType,
      sourceName: doc.sourceName,
      title: doc.title,
    })),
    compiledAt: new Date().toISOString().slice(0, 10),
  };
}

/**
 * Format an attribution as a markdown footer to append to wiki pages.
 *
 * Example output:
 * ---
 * _Sources: Jira PROJ-123, Confluence "Auth Design", Teams #engineering (compiled 2026-04-09)_
 */
export function formatAttributionFooter(attr: Attribution): string {
  if (attr.sources.length === 0) {
    return `\n\n---\n_Sources: none (compiled ${attr.compiledAt})_`;
  }

  const sourceLabels = attr.sources.map((s) => {
    const typeLabel =
      s.sourceType.charAt(0).toUpperCase() + s.sourceType.slice(1);
    return `${typeLabel} ${JSON.stringify(s.title)}`;
  });

  // Deduplicate labels in case the same source appears multiple times
  const uniqueLabels = [...new Set(sourceLabels)];

  return `\n\n---\n_Sources: ${uniqueLabels.join(", ")} (compiled ${attr.compiledAt})_`;
}
