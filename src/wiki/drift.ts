/**
 * Drift detection — which wiki pages does a diff invalidate?
 *
 * When a PR touches `src/auth/session.ts`, any wiki page that references
 * that path, mentions the symbol it exports, or was blessed before the
 * change is "drifted" — its trust signal no longer reflects reality.
 *
 * This module does the pure, LLM-free half of `ctx review`:
 *
 *     diff  ──┐
 *             │
 *     pages ──┼──▶  findAffectedPages()  ──▶  [ {page, reasons} ... ]
 *             │                                          │
 *     git   ──┘                                          ▼
 *                                              classifyDrift() per hit
 *                                                          │
 *                                                          ▼
 *                                              fresh / stale / drifted / unblessed
 *
 * The module is deliberately decoupled from Commander, git, and any
 * LLM client. Callers supply a list of changed files and a WikiPage[];
 * the module returns structured matches. `ctx review --drift` wraps
 * this in CLI plumbing; `ctx lint` re-uses the same core for its
 * blessed-drift rule.
 *
 * Matching is done in three passes, each cheaper than the last:
 *
 *   1. Literal path mention. The strongest signal — if a wiki page
 *      has `src/auth/session.ts` in a backtick, any change to that
 *      file touches the page's claims.
 *   2. Parent directory mention. Pages that document `src/auth/`
 *      broadly should surface when any file below that dir changes.
 *   3. Basename match. A page mentioning `session.ts` (without the
 *      leading dir) still counts — catches drift for wikis that use
 *      shorthand.
 *
 * We never call the LLM here. If a user wants semantic drift (a page
 * that talks about "authentication" when auth.ts changes) they reach
 * for `ctx review` without `--drift`, which runs the full Claude pass.
 */

import type { WikiPage } from "../types/page.js";
import { readBlessState, type BlessState } from "./bless.js";

// ── Types ─────────────────────────────────────────────────────────────

export type DriftClass = "fresh" | "stale" | "drifted" | "unblessed";

export interface DriftReason {
  /** The changed file that triggered the match. */
  changedFile: string;
  /** How we matched it: literal path, directory, or basename. */
  kind: "literal" | "directory" | "basename";
  /** 0-indexed line number in the page body where the match occurred. */
  line: number;
  /** The matched text excerpt (trimmed). */
  excerpt: string;
}

export interface AffectedPage {
  page: WikiPage;
  /** Reasons this page is flagged — ordered by match strength. */
  reasons: DriftReason[];
  /** Classification computed from meta + bless state. */
  classification: DriftClass;
  /** Bless state (pre-computed so the renderer doesn't re-parse). */
  bless: BlessState;
}

export interface FindAffectedOptions {
  /** Skip pages with these basenames (default: index / log / glossary). */
  skipCatalogues?: boolean;
  /** Maximum excerpts per page (default 5). Higher counts add noise. */
  maxReasonsPerPage?: number;
}

// ── Core ──────────────────────────────────────────────────────────────

/**
 * Walk the wiki and return every page that references any of the
 * changed files. The order of returned pages is:
 *
 *   1. Literal matches first
 *   2. Directory matches second
 *   3. Basename-only matches last
 *
 * Within each bucket, pages are sorted by number of reasons descending,
 * then path ascending for determinism.
 */
export function findAffectedPages(
  changedFiles: string[],
  pages: WikiPage[],
  options: FindAffectedOptions = {}
): AffectedPage[] {
  if (changedFiles.length === 0 || pages.length === 0) return [];

  const skipCatalogues = options.skipCatalogues ?? true;
  const maxReasons = options.maxReasonsPerPage ?? 5;

  // Pre-compute per-changed-file lookup structures so we don't rebuild
  // them for every wiki page. `dirs` is every ancestor directory of a
  // changed file (e.g. `src/auth/session.ts` → src, src/auth).
  const paths = new Set<string>();
  const dirs = new Set<string>();
  const basenames = new Map<string, string>(); // basename → original path
  for (const f of changedFiles) {
    const norm = normalisePath(f);
    paths.add(norm);
    const parts = norm.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
    const base = parts[parts.length - 1];
    if (base && !basenames.has(base)) basenames.set(base, norm);
  }

  const results: AffectedPage[] = [];

  for (const page of pages) {
    if (skipCatalogues) {
      const base = page.path.split("/").pop() ?? page.path;
      if (base === "index.md" || base === "log.md" || base === "glossary.md") {
        continue;
      }
    }

    const reasons: DriftReason[] = [];
    const lines = page.content.split("\n");

    // Walk each line; within each line inspect any backticked tokens
    // and flat text occurrences. We stop adding reasons for a page
    // once we hit maxReasons to keep output readable.
    for (let lineIdx = 0; lineIdx < lines.length && reasons.length < maxReasons; lineIdx++) {
      const raw = lines[lineIdx];

      // Inline code spans — most direct signal.
      for (const span of raw.matchAll(/`([^`\n]+)`/g)) {
        const token = normalisePath(span[1].trim());
        if (!token) continue;
        const hit = matchToken(token, paths, dirs, basenames);
        if (hit) {
          reasons.push({
            changedFile: hit.changedFile,
            kind: hit.kind,
            line: lineIdx,
            excerpt: raw.trim(),
          });
          if (reasons.length >= maxReasons) break;
        }
      }

      if (reasons.length >= maxReasons) break;

      // Plain-text mentions: only check when the line has no backticks
      // we already inspected, so we don't double-report the same span.
      // We intentionally only scan for LITERAL path matches in prose,
      // not basename/directory — those produce far too many false
      // positives when words happen to match a filename.
      if (!raw.includes("`")) {
        for (const path of paths) {
          if (raw.includes(path)) {
            reasons.push({
              changedFile: path,
              kind: "literal",
              line: lineIdx,
              excerpt: raw.trim(),
            });
            if (reasons.length >= maxReasons) break;
          }
        }
      }
    }

    if (reasons.length === 0) continue;

    const bless = readBlessStateFromPage(page);
    results.push({
      page,
      reasons,
      classification: classifyDrift(page, bless),
      bless,
    });
  }

  // Sort: literal matches first, then directory, then basename. Ties
  // are broken by total match count desc, then page path asc. We
  // compute a "strength score" per page — lower is better — by taking
  // the rank of the strongest reason on the page (0 for literal,
  // 1 for directory, 2 for basename).
  const kindRank = (k: DriftReason["kind"]): number =>
    k === "literal" ? 0 : k === "directory" ? 1 : 2;
  results.sort((a, b) => {
    const aStrength = Math.min(...a.reasons.map((r) => kindRank(r.kind)));
    const bStrength = Math.min(...b.reasons.map((r) => kindRank(r.kind)));
    if (aStrength !== bStrength) return aStrength - bStrength;
    if (a.reasons.length !== b.reasons.length) return b.reasons.length - a.reasons.length;
    return a.page.path.localeCompare(b.page.path);
  });

  return results;
}

/**
 * Classify a page's drift state based on its meta + bless stamp.
 *
 *   - drifted   : blessed AT ALL (the change post-dates the bless so
 *                 the human review is now out of date)
 *   - stale     : not blessed but has a refreshed_at (the automated
 *                 compile is now lagging reality)
 *   - unblessed : not blessed and never refreshed (probably a manual
 *                 page that never saw `ctx sync`)
 *   - fresh     : shouldn't occur in drift output but returned as a
 *                 safe default for pages that somehow pass every
 *                 freshness check
 *
 * NOTE: This function does NOT re-check git history. The caller is
 * assumed to have supplied only pages that ARE affected — so any
 * bless stamp is, by definition, older than the changes being
 * evaluated.
 */
export function classifyDrift(page: WikiPage, bless: BlessState): DriftClass {
  if (bless.status === "blessed") return "drifted";
  if (page.meta?.refreshed_at) return "stale";
  return "unblessed";
}

// ── Internals ─────────────────────────────────────────────────────────

function normalisePath(p: string): string {
  let out = p.trim();
  if (out.startsWith("./")) out = out.slice(2);
  // Strip trailing slashes so `src/auth/` and `src/auth` normalise
  // to the same key, but preserve the bare root `/` as empty.
  while (out.endsWith("/") && out.length > 1) out = out.slice(0, -1);
  return out;
}

/**
 * Given a token from a wiki page, decide if it matches a changed file.
 * Order of preference: literal path > directory > basename.
 */
function matchToken(
  token: string,
  paths: Set<string>,
  dirs: Set<string>,
  basenames: Map<string, string>
): { changedFile: string; kind: "literal" | "directory" | "basename" } | null {
  if (paths.has(token)) {
    return { changedFile: token, kind: "literal" };
  }
  if (dirs.has(token)) {
    return { changedFile: token, kind: "directory" };
  }
  // Check whether the token is the BASENAME of any changed file.
  const base = token.split("/").pop() ?? token;
  if (basenames.has(base)) {
    return { changedFile: basenames.get(base)!, kind: "basename" };
  }
  return null;
}

/**
 * Re-implements what `why.ts` does — reads a bless stamp out of a
 * WikiPage's meta. Kept local to this module so drift.ts has no
 * dependency on why.ts.
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

// ── Re-export the state type the CLI wants to render ─────────────────

export { readBlessState };
