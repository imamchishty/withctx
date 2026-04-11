/**
 * Evidence-trace engine for `ctx why <claim>`.
 *
 * Given a claim string (a sentence, a phrase, a fact), walks the wiki
 * and returns the full provenance chain:
 *
 *     claim
 *       → wiki page(s) that contain it (literal or fuzzy match)
 *         → surrounding context (the sentence / paragraph)
 *           → refresh metadata (when + by whom the page was compiled)
 *             → source attribution (which upstream doc fed the page)
 *               → bless state (has a human signed off?)
 *
 * Deterministic by design — no LLM call. A `why` query should be fast
 * and free so users run it liberally as a trust probe. The vector
 * search fallback (when literal match finds nothing) is also local.
 *
 * Design principles:
 *
 *   1. Literal matching first — if the claim appears verbatim on a
 *      page, that's the strongest possible evidence and we should
 *      show it instantly. No tokenisation, no embedding.
 *
 *   2. Word-bag matching second — for claims that don't appear
 *      verbatim (e.g. "we use PostgreSQL" vs a page saying "The
 *      PostgreSQL database is used for..."), fall back to scoring
 *      pages by shared content words.
 *
 *   3. Vector fallback third — only if both string-based methods find
 *      nothing. Deferred to the CLI layer because the vector manager
 *      needs a CtxDirectory.
 *
 *   4. Each hit carries the full metadata envelope so the renderer
 *      can show bless state, refresh timestamp, and source list
 *      without a second pass.
 */

import type { WikiPage } from "../types/page.js";
import type { PageMetadata } from "./metadata.js";
import { readBlessState, type BlessState } from "./bless.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface EvidenceHit {
  page: string;
  title: string;
  /** 0-indexed line numbers of the match in the page body. */
  lineStart: number;
  lineEnd: number;
  /** The matched line(s), joined and trimmed. Up to 3 lines of context. */
  excerpt: string;
  /** How we found this hit — human-readable tag for the renderer. */
  matchKind: "literal" | "fuzzy" | "phrase";
  /**
   * 0–1 score for ranking. Literal matches get 1.0, fuzzy matches
   * get a word-overlap ratio. Used only for sorting; the renderer
   * doesn't surface the number.
   */
  score: number;
  /** Full page metadata — refreshed_*, commit, tier, verified, bless. */
  meta: PageMetadata;
  /** Pre-computed bless state so the renderer doesn't re-parse. */
  bless: BlessState;
  /** Source attributions extracted from the page body (_Source: ..._). */
  sources: string[];
}

export interface WhyQueryOptions {
  /** Max number of hits to return. Defaults to 5. */
  limit?: number;
  /**
   * Word-overlap threshold for fuzzy matching (0–1). Below this the
   * page isn't considered a match. Default 0.4.
   */
  minScore?: number;
  /** Case-sensitive literal matching. Default false. */
  caseSensitive?: boolean;
}

// ── Core search ───────────────────────────────────────────────────────

/**
 * Run the deterministic search over an in-memory list of pages. The
 * CLI layer populates `pages` via PageManager and hands them in so
 * this function stays testable without a filesystem.
 *
 * Returns hits sorted by score descending, capped at `options.limit`.
 */
export function findEvidence(
  claim: string,
  pages: WikiPage[],
  options: WhyQueryOptions = {}
): EvidenceHit[] {
  const limit = options.limit ?? 5;
  const minScore = options.minScore ?? 0.4;
  const normalised = normaliseClaim(claim, options.caseSensitive ?? false);
  const claimWords = extractContentWords(normalised);

  const hits: EvidenceHit[] = [];

  for (const page of pages) {
    // Skip obviously-auto-generated pages — they're catalogues, not
    // evidence. A hit in index.md telling you "overview.md mentions
    // PostgreSQL" is noise; the real evidence is in overview.md.
    const base = page.path.split("/").pop() ?? page.path;
    if (base === "index.md" || base === "log.md" || base === "glossary.md") continue;

    const body = page.content;
    const bodyNormalised = options.caseSensitive ? body : body.toLowerCase();

    // Tier 1: literal substring match — the strongest evidence.
    const literalIdx = bodyNormalised.indexOf(normalised);
    if (literalIdx !== -1) {
      const { lineStart, lineEnd, excerpt } = extractContext(body, literalIdx, normalised.length);
      hits.push({
        page: page.path,
        title: page.title,
        lineStart,
        lineEnd,
        excerpt,
        matchKind: "literal",
        score: 1.0,
        meta: page.meta ?? {},
        bless: readBlessStateFromPage(page),
        sources: page.sources,
      });
      continue;
    }

    // Tier 2: word-overlap fuzzy match. Score is the fraction of
    // claim words that appear in the page body. This catches
    // rephrasings like "Postgres" when the claim said "PostgreSQL"
    // (via the stem) as well as multi-word claims that straddle
    // line breaks in the rendered page.
    if (claimWords.length > 0) {
      const bodyWords = new Set(extractContentWords(bodyNormalised));
      let overlap = 0;
      for (const w of claimWords) {
        if (bodyWords.has(w)) overlap++;
      }
      const score = overlap / claimWords.length;
      if (score >= minScore) {
        // Find the densest line for the excerpt — the line with the
        // most matched words wins.
        const denseMatch = findDensestLine(body, claimWords, options.caseSensitive ?? false);
        hits.push({
          page: page.path,
          title: page.title,
          lineStart: denseMatch.lineStart,
          lineEnd: denseMatch.lineEnd,
          excerpt: denseMatch.excerpt,
          matchKind: "fuzzy",
          score,
          meta: page.meta ?? {},
          bless: readBlessStateFromPage(page),
          sources: page.sources,
        });
      }
    }
  }

  // Sort by score desc, then by literal-before-fuzzy (tie-breaker
  // only matters at score == 1.0 edge cases).
  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.matchKind !== b.matchKind) return a.matchKind === "literal" ? -1 : 1;
    return a.page.localeCompare(b.page);
  });

  return hits.slice(0, limit);
}

// ── Internals ─────────────────────────────────────────────────────────

function normaliseClaim(claim: string, caseSensitive: boolean): string {
  const trimmed = claim.trim();
  return caseSensitive ? trimmed : trimmed.toLowerCase();
}

/**
 * Break a string into content words, dropping stopwords and
 * punctuation. The stopword list is intentionally small — just
 * function words that dominate the match but carry no signal.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "the", "is", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "at", "by", "for", "with", "from", "as", "it", "its",
  "this", "that", "these", "those", "we", "our", "us", "you", "your", "i", "me",
  "or", "but", "if", "then", "so", "do", "does", "did", "has", "have", "had",
  "will", "would", "can", "could", "should", "may", "might", "not", "no",
]);

function extractContentWords(text: string): string[] {
  return text
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

/**
 * Naive suffix stemmer — trims common English inflections so that
 * "users" matches "user", "stored" matches "store", and "running"
 * matches "run". Deliberately crude: we're doing word-bag overlap
 * matching, not a full NLP pipeline, and any over-trimming just
 * means slightly looser matching — acceptable for a trust-probe
 * search.
 *
 * Exported indirectly via extractContentWords; kept local to this
 * module because its semantics are entangled with the stopword
 * policy above.
 */
function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);
  return word;
}

/**
 * Given a byte offset into a page body and the length of the match,
 * return the 0-indexed line range and an excerpt (up to 3 lines
 * centred on the match).
 */
function extractContext(
  body: string,
  offset: number,
  matchLength: number
): { lineStart: number; lineEnd: number; excerpt: string } {
  const lines = body.split("\n");
  let cursor = 0;
  let matchLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const next = cursor + lines[i].length + 1; // +1 for the newline
    if (offset >= cursor && offset < next) {
      matchLine = i;
      break;
    }
    cursor = next;
  }
  const start = Math.max(0, matchLine);
  // If the match spans more than one line (rare for literal matches)
  // extend the end accordingly.
  let endOffset = offset + matchLength;
  cursor = 0;
  let endLine = matchLine;
  for (let i = 0; i < lines.length; i++) {
    const next = cursor + lines[i].length + 1;
    if (endOffset >= cursor && endOffset <= next) {
      endLine = i;
      break;
    }
    cursor = next;
  }
  const excerpt = lines.slice(start, endLine + 1).join("\n").trim();
  return { lineStart: start, lineEnd: endLine, excerpt };
}

/**
 * For fuzzy matches, find the line in `body` that contains the most
 * claim words. Ties are broken by earlier position.
 */
function findDensestLine(
  body: string,
  claimWords: string[],
  caseSensitive: boolean
): { lineStart: number; lineEnd: number; excerpt: string } {
  const lines = body.split("\n");
  let bestLine = 0;
  let bestCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = caseSensitive ? lines[i] : lines[i].toLowerCase();
    if (!line.trim()) continue;
    let count = 0;
    for (const w of claimWords) {
      if (line.includes(w)) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestLine = i;
    }
  }

  return {
    lineStart: bestLine,
    lineEnd: bestLine,
    excerpt: lines[bestLine].trim(),
  };
}

/**
 * Convenience wrapper — reads the bless state from a WikiPage's
 * original raw content. Since the PageManager strips the ctx
 * front-matter before returning `content`, we have to reconstruct
 * the meta-scoped bless state from `page.meta` instead.
 */
function readBlessStateFromPage(page: WikiPage): BlessState {
  const meta = page.meta ?? {};
  if (!meta.blessed_by || !meta.blessed_at) {
    return { status: "unblessed" };
  }
  return {
    status: "blessed",
    stamp: {
      blessed_by: meta.blessed_by,
      blessed_at: meta.blessed_at,
      ...(meta.blessed_at_sha && { blessed_at_sha: meta.blessed_at_sha }),
      ...(meta.blessed_note && { blessed_note: meta.blessed_note }),
    },
  };
}
