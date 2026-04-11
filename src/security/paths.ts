/**
 * Path-safety helpers for user-supplied paths that flow into
 * filesystem operations.
 *
 * Every call site that takes a path from ctx.yaml, CLI argv, a wiki
 * page, or an environment variable MUST run it through one of these
 * helpers before handing it to `fs.*`. The helpers enforce two rules:
 *
 *   1. The resolved path must stay inside an allowed root. We use
 *      `path.resolve` to canonicalise the input, then compare against
 *      the root with a trailing separator so that prefix-collision
 *      attacks (`/var/foo-attacker` vs `/var/foo`) don't slip through.
 *
 *   2. No `..` segments, absolute paths, or special device paths
 *      (`/dev/stdin`, `/proc/*`, `file://`, UNC `\\host\share`) are
 *      accepted before resolution. We want a clear error at the edge
 *      rather than a surprising stat of `/etc/passwd` deep in a
 *      connector.
 *
 * This file is deliberately tiny and dependency-free so it can be
 * imported from commands, connectors, and storage without a cycle.
 */

import { isAbsolute, normalize, resolve, sep } from "node:path";

/**
 * Error thrown when a user-supplied path escapes its allowed root.
 *
 * Commands catch this and re-throw as a `CtxError` with an
 * actionable `next` hint (e.g. "Check sources[0].path in ctx.yaml").
 */
export class UnsafePathError extends Error {
  public readonly input: string;
  public readonly root: string;

  constructor(input: string, root: string, reason: string) {
    super(`Path "${input}" is unsafe: ${reason} (root: ${root})`);
    this.name = "UnsafePathError";
    this.input = input;
    this.root = root;
  }
}

/**
 * Resolve `input` against `root` and guarantee the result stays inside
 * `root`. Throws `UnsafePathError` on any violation.
 *
 * Accepts:
 *   - Relative paths (`src/auth`, `./docs`, `subdir/file.md`)
 *   - Absolute paths that are themselves inside `root`
 *
 * Rejects:
 *   - Paths containing `..` segments that escape `root`
 *   - Device / special paths (`/dev/stdin`, `/proc/*`, `\\?\`, `\\host\`)
 *   - Empty strings
 */
export function resolveInsideRoot(input: string, root: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new UnsafePathError(String(input), root, "path is empty");
  }

  // Reject obviously hostile device-style paths before we even resolve.
  // We want a clean error at the edge rather than implicit platform
  // semantics kicking in.
  if (/^\\\\|^\/dev\/|^\/proc\/|^\/sys\//.test(input)) {
    throw new UnsafePathError(input, root, "device / special path");
  }

  // URL schemes (file://, http://) don't belong in filesystem args.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    throw new UnsafePathError(input, root, "URL scheme in path");
  }

  const normalisedRoot = resolve(root);
  const resolved = isAbsolute(input)
    ? resolve(input)
    : resolve(normalisedRoot, normalize(input));

  // The classic containment check: `resolved` is inside `root` iff it
  // equals `root` or starts with `root + sep`. Plain `startsWith(root)`
  // lets `/var/foo-evil` through when root is `/var/foo`.
  if (resolved !== normalisedRoot && !resolved.startsWith(normalisedRoot + sep)) {
    throw new UnsafePathError(input, normalisedRoot, "path escapes root");
  }

  return resolved;
}

/**
 * Like `resolveInsideRoot` but never throws — returns `null` on any
 * safety violation. Useful in loops where a single bad entry shouldn't
 * abort the whole operation (e.g., walking a list of configured
 * sources where one has a bad `path`).
 */
export function safeResolve(input: string, root: string): string | null {
  try {
    return resolveInsideRoot(input, root);
  } catch {
    return null;
  }
}

/**
 * Lightweight page-path validator for CLI args like `ctx approve <page>`
 * and `ctx verify <page>`. Enforces:
 *
 *   - No `..` anywhere in the raw input (checked BEFORE prefix stripping
 *     so `.ctx/context/../../../etc/passwd.md` is rejected).
 *   - No leading `/`.
 *   - Result ends in `.md` (auto-appended if missing).
 *
 * Returns the cleaned path, relative to `.ctx/context/`.
 *
 * NOTE: this is intentionally stricter than `resolveInsideRoot` — we
 * never want a page path to be absolute or to escape the context
 * directory, and we want the check to run before any path
 * normalisation so we can't be tricked by clever prefix stripping.
 */
export function normalizeSafePagePath(input: string): string {
  let p = (input ?? "").trim();
  if (p.length === 0) {
    throw new UnsafePathError(input, ".ctx/context", "page path is empty");
  }

  // Check for `..` BEFORE stripping any prefix. If we stripped first we
  // could be fooled by `.ctx/context/../../../etc/passwd.md` →
  // `../../../etc/passwd.md`, which the downstream `..` check would
  // still catch but only by luck. Doing the check here makes the
  // invariant obvious.
  if (p.includes("..")) {
    throw new UnsafePathError(input, ".ctx/context", "page path contains ..");
  }

  if (isAbsolute(p) || p.startsWith("/")) {
    throw new UnsafePathError(input, ".ctx/context", "page path is absolute");
  }

  if (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith(".ctx/context/")) p = p.slice(".ctx/context/".length);
  if (p.startsWith("context/")) p = p.slice("context/".length);

  if (!p.endsWith(".md")) p = `${p}.md`;

  return p;
}
