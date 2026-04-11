/**
 * Page bless — the "I've read this and it's correct" human review gesture.
 *
 * Bless is the smallest possible unit of human trust in the wiki. It
 * stamps a page's YAML front-matter with:
 *
 *   blessed_by:     the reviewer's git email (or fallback actor)
 *   blessed_at:     ISO-8601 timestamp
 *   blessed_at_sha: git HEAD at bless time — used by `ctx lint` to
 *                   detect drift between the bless and the current
 *                   source tree
 *   blessed_note:   optional free-text note, persisted into the
 *                   refresh journal alongside the stamp
 *
 * Unlike `refreshed_*` (which records automated compilation), bless is
 * an explicit human signal that promotes a page from "Claude wrote it"
 * to "someone on the team verified it matches reality". It's the
 * mechanism that turns a passively-compiled wiki into a review-driven
 * knowledge base.
 *
 * The module has no dependencies on Commander, chalk, or any CLI I/O —
 * everything here is pure functions + git shell-outs, so it's trivial
 * to unit test and can be reused by `ctx lint`, `ctx status`, and the
 * MCP server.
 */

import { execFileSync } from "node:child_process";
import { parsePage, formatPage, type PageMetadata } from "./metadata.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface BlessStamp {
  blessed_by: string;
  blessed_at: string;
  blessed_at_sha?: string;
  blessed_note?: string;
}

export interface BlessOptions {
  /** Override the reviewer identity (otherwise detected from git). */
  blessedBy?: string;
  /** Override the current git HEAD (otherwise detected). */
  sha?: string;
  /** Override the timestamp (used by tests for determinism). */
  now?: Date;
  /** Optional free-text note to store alongside the bless. */
  note?: string;
  /** Working directory to resolve git from (defaults to process.cwd()). */
  cwd?: string;
}

export type BlessState =
  | { status: "unblessed" }
  | { status: "blessed"; stamp: BlessStamp };

// ── Git helpers ───────────────────────────────────────────────────────
//
// execFileSync wrappers that swallow errors and return undefined. Bless
// is a local, never-network operation so anything that fails simply
// degrades to "no git context" — we never block the user.

function runGit(args: string[], cwd: string): string | undefined {
  try {
    const out = execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      maxBuffer: 256 * 1024,
      encoding: "utf-8",
    });
    return out.trim();
  } catch {
    return undefined;
  }
}

/**
 * Detect the reviewer's git email. Falls back to the username returned
 * by git config, then to `${USER}@${hostname}` style, and finally to
 * `"unknown"` so a bless stamp is always creatable — we never refuse
 * the gesture just because git isn't configured.
 */
export function detectReviewer(cwd: string = process.cwd()): string {
  const email = runGit(["config", "user.email"], cwd);
  if (email && email.length > 0) return email;
  const name = runGit(["config", "user.name"], cwd);
  if (name && name.length > 0) return name;
  if (process.env.USER && process.env.HOSTNAME) {
    return `${process.env.USER}@${process.env.HOSTNAME}`;
  }
  if (process.env.USER) return process.env.USER;
  return "unknown";
}

/**
 * Current git HEAD for the cwd (short form). Returns undefined when
 * outside a git repo or git isn't installed.
 */
export function detectHeadSha(cwd: string = process.cwd()): string | undefined {
  return runGit(["rev-parse", "--short", "HEAD"], cwd);
}

// ── Core stamping ─────────────────────────────────────────────────────

/**
 * Stamp the bless block into a page's YAML front-matter. Preserves any
 * existing ctx metadata (refreshed_*, tier, verified, etc.) and any
 * user-authored non-ctx front-matter keys.
 *
 * Returns the new page content. Idempotent: calling twice with the
 * same arguments produces the same output.
 */
export function blessPage(content: string, options: BlessOptions = {}): string {
  const now = options.now ?? new Date();
  const cwd = options.cwd ?? process.cwd();

  const blessed_by = options.blessedBy ?? detectReviewer(cwd);
  const blessed_at = now.toISOString();
  const blessed_at_sha = options.sha ?? detectHeadSha(cwd);

  const parsed = parsePage(content);
  const merged: PageMetadata = {
    ...parsed.meta,
    blessed_by,
    blessed_at,
    ...(blessed_at_sha && { blessed_at_sha }),
    ...(options.note && { blessed_note: options.note }),
  };

  // Auto-promote the trust tier. Blessing is a human review signal
  // so the page should be at least "asserted" afterwards. We never
  // downgrade — a page already marked "verified" (passed assertions
  // via `ctx verify`) stays verified; "historical" and "manual"
  // pages are elevated to asserted because a human has now signed
  // off on them.
  const currentTier = merged.tier;
  if (currentTier !== "verified") {
    merged.tier = "asserted";
  }

  return formatPage(parsed.body, merged, parsed.otherFrontmatter);
}

/**
 * Remove the bless block from a page. Used by `ctx bless --revoke`
 * when a reviewer realises a page they blessed is actually wrong.
 *
 * Preserves every other front-matter field — only the four bless_*
 * keys are cleared. If the page had no bless to begin with, the
 * content is returned unchanged.
 */
export function revokeBless(content: string): string {
  const parsed = parsePage(content);
  const had =
    parsed.meta.blessed_by !== undefined ||
    parsed.meta.blessed_at !== undefined ||
    parsed.meta.blessed_at_sha !== undefined ||
    parsed.meta.blessed_note !== undefined;
  if (!had) return content;

  // Build a fresh meta object without the bless keys — a plain
  // `delete` would work but an explicit rebuild keeps the shape
  // stable for downstream type checks.
  const next: PageMetadata = {};
  if (parsed.meta.refreshed_at !== undefined) next.refreshed_at = parsed.meta.refreshed_at;
  if (parsed.meta.refreshed_by !== undefined) next.refreshed_by = parsed.meta.refreshed_by;
  if (parsed.meta.commit !== undefined) next.commit = parsed.meta.commit;
  if (parsed.meta.sources !== undefined) next.sources = parsed.meta.sources;
  if (parsed.meta.model !== undefined) next.model = parsed.meta.model;
  if (parsed.meta.verified !== undefined) next.verified = parsed.meta.verified;

  // Tier downgrade on revoke: if the page's only claim to "asserted"
  // was the now-removed bless, demote it. We can't tell for sure —
  // the tier could have been set manually — so we use the rule:
  // if tier was "asserted" AND there are no verified assertions, the
  // bless is the only human signal, so demote to "manual". If the
  // tier was "verified", keep it (verification is independent).
  if (parsed.meta.tier === "asserted" && (!parsed.meta.verified || parsed.meta.verified.passed === 0)) {
    next.tier = "manual";
  } else if (parsed.meta.tier !== undefined) {
    next.tier = parsed.meta.tier;
  }

  return formatPage(parsed.body, next, parsed.otherFrontmatter);
}

/**
 * Inspect a page's current bless state. Used by `ctx status` to compute
 * the bless ratio and by `ctx lint` to detect drift.
 */
export function readBlessState(content: string): BlessState {
  const parsed = parsePage(content);
  const { blessed_by, blessed_at, blessed_at_sha, blessed_note } = parsed.meta;
  if (!blessed_by || !blessed_at) {
    return { status: "unblessed" };
  }
  return {
    status: "blessed",
    stamp: {
      blessed_by,
      blessed_at,
      ...(blessed_at_sha && { blessed_at_sha }),
      ...(blessed_note && { blessed_note }),
    },
  };
}

/**
 * Has the page drifted since its last bless? Returns true when:
 *   - the page is blessed AND
 *   - we have a blessed_at_sha AND
 *   - the current git HEAD differs AND
 *   - the path this page depends on has changed in git since the sha
 *
 * The third condition is intentionally coarse — a HEAD bump alone is
 * not drift (that would fire on every commit). A caller that wants
 * page-level precision should pass in `pageSourceFiles` so we only
 * report drift when THOSE files changed. Without that list we fall
 * back to "any change in the repo since the bless sha".
 *
 * Returns false (not drifted) when:
 *   - unblessed
 *   - blessed but no sha pinned
 *   - git isn't available
 *   - blessed_at_sha is the current HEAD
 */
export function hasDriftedSinceBless(
  state: BlessState,
  options: { cwd?: string; pageSourceFiles?: string[] } = {}
): boolean {
  if (state.status !== "blessed") return false;
  const { blessed_at_sha } = state.stamp;
  if (!blessed_at_sha) return false;

  const cwd = options.cwd ?? process.cwd();
  const head = detectHeadSha(cwd);
  if (!head) return false;
  if (head === blessed_at_sha) return false;

  // If the caller supplied a list of source files, check whether any
  // of them changed between the bless sha and HEAD. `git diff --name-only`
  // returns the list of paths that differ.
  if (options.pageSourceFiles && options.pageSourceFiles.length > 0) {
    const diff = runGit(
      ["diff", "--name-only", `${blessed_at_sha}..${head}`, "--", ...options.pageSourceFiles],
      cwd
    );
    if (diff === undefined) return false; // git failed — fail open
    const changedFiles = diff.split("\n").map((l) => l.trim()).filter(Boolean);
    return changedFiles.length > 0;
  }

  // No source-file filter — any change in the tree since the bless sha
  // counts as drift.
  return true;
}
