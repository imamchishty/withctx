/**
 * Git-aware freshness.
 *
 * The wiki today detects staleness by mtime ("last ingested N days
 * ago"). That's cheap but dumb: a page can sit untouched for weeks
 * while its upstream sources quietly change. Users bail on the wiki
 * as soon as they catch it lying about something they just rewrote.
 *
 * This module adds a second, stronger signal: per-source git commit
 * snapshots. When we compile a page, we record "these source files
 * were at commit X, Y, Z". Next time, we re-snapshot and compare; if
 * any SHA moved, the page is stale — not in calendar time, but in
 * content — and we can flag it, recompile it, or refuse to serve it
 * stale.
 *
 * The whole module shells out to `git` via `execFileSync`. No git
 * library, no libgit2 binary, no extra dep. It assumes `git` is on
 * PATH — same assumption `ctx repos add` already makes. Every call is
 * scoped to a directory so monorepos with submodules work.
 *
 * Best-effort: any shell error is swallowed and treated as "no data"
 * (returns undefined). Callers must not depend on a snapshot always
 * being available — a fresh clone, a detached checkout, a tarball
 * extraction, or a source file outside any git repo all legitimately
 * return empty snapshots.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────

/**
 * A freshness snapshot captured at wiki-compile time. Stamped into
 * page metadata so a future run can compare and detect drift.
 */
export interface FreshnessSnapshot {
  /** HEAD commit SHA of the root repo at capture time. May be undefined. */
  head?: string;
  /**
   * Per-file last-commit SHA map. Keys are paths RELATIVE TO rootDir
   * so the snapshot stays portable across clones of the same repo.
   * Files that are untracked, outside any repo, or unreadable are
   * simply absent — the caller shouldn't treat absence as "changed".
   */
  files: Record<string, string>;
  /** ISO timestamp of when this snapshot was taken. */
  capturedAt: string;
}

/**
 * Result of comparing a stored snapshot against a freshly captured one.
 */
export interface FreshnessDiff {
  /**
   * Files whose last-commit SHA moved (new commit landed since the
   * snapshot was taken). These are the "meaningful stale" files.
   */
  changed: string[];
  /** Files present in the stored snapshot but missing from the current one. */
  removed: string[];
  /** Files present in the current snapshot but not the stored one. */
  added: string[];
  /** Files whose SHA is identical in both snapshots. */
  unchanged: string[];
  /**
   * True if the root repo HEAD moved since the stored snapshot was
   * taken. Useful as a fast "has anything changed at all?" check
   * before iterating files.
   */
  headMoved: boolean;
}

// ── Low-level git helpers ─────────────────────────────────────────────

/**
 * Run a git command from a directory and return stdout as a string.
 * Returns undefined on any failure (not a git repo, git not on PATH,
 * non-zero exit, etc.) — callers MUST handle undefined.
 */
function runGit(args: string[], cwd: string): string | undefined {
  try {
    const out = execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      // Hard cap on time + size — a runaway git call should never
      // hang an ingest.
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return out.trim();
  } catch {
    return undefined;
  }
}

/**
 * Walk up from `startDir` looking for a `.git` directory. Returns the
 * repo root (directory containing `.git`) or undefined if we hit the
 * filesystem root without finding one. Used so snapshots can be keyed
 * consistently even when called with a subdirectory.
 */
export function findRepoRoot(startDir: string): string | undefined {
  let dir = isAbsolute(startDir) ? startDir : join(process.cwd(), startDir);
  // Guard: avoid infinite loop on weird filesystems.
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Get the current HEAD commit SHA of the repo containing `dir`.
 * Returns undefined if the directory isn't in a git repo.
 */
export function getGitHead(dir: string): string | undefined {
  const root = findRepoRoot(dir);
  if (!root) return undefined;
  return runGit(["rev-parse", "HEAD"], root);
}

/**
 * Get the SHA of the most recent commit that touched `relPath`
 * (relative to `repoRoot`). Returns undefined if the file is
 * untracked, doesn't exist, or the repo has no history.
 */
export function getFileCommit(repoRoot: string, relPath: string): string | undefined {
  // `git log -n 1 --format=%H -- <path>` is the canonical way to get
  // the last commit that touched a path. Empty output means
  // "untracked / no commit ever touched it" — we treat that as
  // "unknown", not "error".
  const out = runGit(
    ["log", "-n", "1", "--format=%H", "--", relPath],
    repoRoot
  );
  if (!out) return undefined;
  return out;
}

// ── Snapshot API ──────────────────────────────────────────────────────

/**
 * Build a freshness snapshot for a set of source files. Paths may be
 * absolute or relative to `rootDir`; keys in the returned snapshot are
 * always relative to `rootDir` (so the snapshot is portable).
 *
 * Files outside the detected git repo, or files with no commit
 * history, are silently omitted — the snapshot is a best-effort
 * record, not an audit log.
 */
export function buildFreshnessSnapshot(
  rootDir: string,
  filePaths: string[]
): FreshnessSnapshot {
  const repoRoot = findRepoRoot(rootDir);
  const snapshot: FreshnessSnapshot = {
    files: {},
    capturedAt: new Date().toISOString(),
  };

  if (!repoRoot) {
    // Not in a repo at all — snapshot is just the timestamp.
    return snapshot;
  }

  const head = runGit(["rev-parse", "HEAD"], repoRoot);
  if (head) snapshot.head = head;

  for (const raw of filePaths) {
    // Normalise to a path relative to the REPO root (which is where
    // `git log -- <path>` resolves from). We key the snapshot map by
    // path-relative-to-rootDir because that's what the caller knows
    // about; we translate to repo-relative only for the git call.
    const absPath = isAbsolute(raw) ? raw : join(rootDir, raw);
    const relToRoot = relative(rootDir, absPath);
    // Skip paths that escape rootDir (`..`-prefixed) — the caller
    // shouldn't be pointing at files outside the project.
    if (relToRoot.startsWith("..")) continue;

    const relToRepo = relative(repoRoot, absPath);
    if (relToRepo.startsWith("..")) continue;

    const sha = getFileCommit(repoRoot, relToRepo);
    if (sha) snapshot.files[relToRoot] = sha;
  }

  return snapshot;
}

/**
 * Compare a stored snapshot against a freshly captured one. Used by
 * freshness-aware lint / status commands to flag pages whose upstream
 * sources have moved since the last compile.
 */
export function diffFreshnessSnapshots(
  stored: FreshnessSnapshot,
  current: FreshnessSnapshot
): FreshnessDiff {
  const changed: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  const unchanged: string[] = [];

  // Walk the union of keys — each file is in exactly one bucket.
  const allFiles = new Set<string>([
    ...Object.keys(stored.files),
    ...Object.keys(current.files),
  ]);

  for (const file of allFiles) {
    const storedSha = stored.files[file];
    const currentSha = current.files[file];
    if (storedSha && !currentSha) {
      removed.push(file);
    } else if (!storedSha && currentSha) {
      added.push(file);
    } else if (storedSha && currentSha && storedSha !== currentSha) {
      changed.push(file);
    } else if (storedSha && currentSha && storedSha === currentSha) {
      unchanged.push(file);
    }
  }

  const headMoved =
    stored.head !== undefined &&
    current.head !== undefined &&
    stored.head !== current.head;

  return { changed, removed, added, unchanged, headMoved };
}

/**
 * Check whether a stored snapshot is still current. Convenience
 * wrapper over `diffFreshnessSnapshots` — returns true if any file
 * SHA moved or a file was added/removed. HEAD-only movement (no file
 * delta) is NOT considered stale because HEAD can advance for reasons
 * unrelated to the page's sources.
 */
export function isSnapshotStale(
  stored: FreshnessSnapshot,
  current: FreshnessSnapshot
): boolean {
  const diff = diffFreshnessSnapshots(stored, current);
  return diff.changed.length > 0 || diff.added.length > 0 || diff.removed.length > 0;
}

// ── Encoded form (for page metadata) ──────────────────────────────────

/**
 * Serialise a snapshot to a compact JSON string suitable for stamping
 * into page front-matter. Kept small because ingest may stamp this
 * into hundreds of pages — long front-matter slows `ctx status`.
 */
export function encodeSnapshot(snap: FreshnessSnapshot): string {
  return JSON.stringify({
    h: snap.head ?? null,
    f: snap.files,
    t: snap.capturedAt,
  });
}

/**
 * Inverse of encodeSnapshot. Returns undefined on any parse error so
 * callers can fall back to mtime-based freshness without a try/catch.
 */
export function decodeSnapshot(encoded: string): FreshnessSnapshot | undefined {
  try {
    const parsed = JSON.parse(encoded) as {
      h?: string | null;
      f?: Record<string, string>;
      t?: string;
    };
    if (!parsed || typeof parsed !== "object") return undefined;
    return {
      ...(parsed.h && { head: parsed.h }),
      files: parsed.f ?? {},
      capturedAt: parsed.t ?? new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
}
