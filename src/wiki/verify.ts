/**
 * Page verification — turns "asserted" pages into "verified" pages.
 *
 * The trust pipeline runs in three tiers:
 *
 *     manual   →  someone wrote this and there's no automated check
 *     asserted →  a human has blessed it OR it carries claims a machine
 *                 could verify, but the verification hasn't run yet
 *     verified →  every assertion the page declares passed against the
 *                 live tree on the most recent run
 *
 * `ctx verify` is the gate that promotes a page from asserted → verified.
 * It is intentionally narrow and deterministic:
 *
 *   - No LLM call. Verification must be cheap, repeatable, and runnable
 *     in CI without an API key.
 *   - Two assertion sources:
 *       1. Auto-detected file paths in inline code spans. Any backticked
 *          token that looks like a path (contains `/` and an extension,
 *          or starts with `src/`, `tests/`, etc.) becomes a path-exists
 *          assertion. This catches the most common drift class — a
 *          renamed or deleted file the wiki still references.
 *       2. Explicit `ctx-assert` fenced blocks. These let a page author
 *          declare arbitrary checks: regex, grep, path-exists with
 *          custom paths, etc. Each line in the block is one assertion.
 *   - Results stamp into `ctx.verified = { passed, failed, last_run_at }`.
 *     If passed > 0 AND failed === 0 AND the page wasn't already
 *     verified by a stronger signal, we promote tier to "verified".
 *   - On any failure the tier is left as-is (or demoted from verified
 *     back to asserted) so a once-passing page that drifts gets caught.
 *
 * The module exports both pure analysis (`extractAssertions`,
 * `runAssertion`, `verifyPage`) and a stamping wrapper
 * (`applyVerification`) so callers can compose the pieces however they
 * want — the CLI uses `applyVerification`, but `ctx lint` and the MCP
 * server reach for the pure ones.
 */

import {
  existsSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
} from "node:fs";
import { resolve, join, isAbsolute, normalize, sep, relative, basename } from "node:path";
import { parsePage, formatPage, type PageMetadata } from "./metadata.js";

// ── Types ─────────────────────────────────────────────────────────────

export type AssertionKind = "path-exists" | "grep" | "regex" | "no-match";

export interface Assertion {
  kind: AssertionKind;
  /** The literal text that appears in the page (for error reporting). */
  source: string;
  /** Primary target — a file path for path-exists/grep/regex; ignored for no-match. */
  target: string;
  /** Optional second argument — pattern for grep/regex/no-match. */
  pattern?: string;
  /** 0-indexed line in the page body where the assertion was found. */
  line: number;
  /** "auto" if inferred from a code span, "explicit" if from a ctx-assert block. */
  origin: "auto" | "explicit";
}

export interface AssertionResult {
  assertion: Assertion;
  ok: boolean;
  /** Short human-readable failure reason; empty when ok. */
  reason: string;
}

export interface VerifyResult {
  /** All assertions found on the page. */
  assertions: Assertion[];
  /** Per-assertion outcomes, in the same order. */
  results: AssertionResult[];
  passed: number;
  failed: number;
  /** ISO timestamp of when verification ran. */
  ranAt: string;
}

export interface VerifyOptions {
  /** Project root that path assertions resolve against. Defaults to cwd. */
  projectRoot?: string;
  /** Override the timestamp for deterministic tests. */
  now?: Date;
  /**
   * Suppress auto-detected assertions — only run explicit ctx-assert
   * blocks. Useful for pages that mention paths in narrative prose
   * where false positives would be costly.
   */
  explicitOnly?: boolean;
  /** Maximum file size (bytes) to read for grep/regex. Defaults to 1 MiB. */
  maxFileBytes?: number;
}

// ── Assertion extraction ──────────────────────────────────────────────

const CTX_ASSERT_FENCE = /^```ctx-assert\s*\n([\s\S]*?)\n```/gm;

/**
 * Pull every assertion out of a page body. The body should be the
 * page CONTENT (not the raw file with front-matter) — pass the result
 * of `parsePage(...).body` if you have a raw page.
 */
export function extractAssertions(
  body: string,
  options: { explicitOnly?: boolean } = {}
): Assertion[] {
  const assertions: Assertion[] = [];

  // 1. Explicit ctx-assert fenced blocks. We scan first so the line
  //    indices for auto-detection can skip lines we've already claimed.
  const claimedLines = new Set<number>();
  for (const match of body.matchAll(CTX_ASSERT_FENCE)) {
    const block = match[1];
    const blockStart = body.slice(0, match.index).split("\n").length - 1;
    const blockLines = block.split("\n");
    // Mark every line of the block (including the fences) as claimed.
    for (let i = 0; i <= blockLines.length + 1; i++) {
      claimedLines.add(blockStart + i);
    }
    blockLines.forEach((rawLine, i) => {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const parsed = parseAssertionLine(trimmed);
      if (!parsed) return;
      assertions.push({
        ...parsed,
        source: trimmed,
        line: blockStart + 1 + i, // +1 to skip the opening fence line
        origin: "explicit",
      });
    });
  }

  // 2. Auto-detected file paths from inline code spans. We deliberately
  //    skip code FENCES (```...```) so a Python snippet that imports
  //    `os.path` doesn't become a path assertion.
  if (!options.explicitOnly) {
    const lines = body.split("\n");
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (claimedLines.has(i)) continue;
      // Match `backticked tokens` — but only those that look path-ish.
      for (const span of line.matchAll(/`([^`\n]+)`/g)) {
        const token = span[1].trim();
        if (!looksLikePath(token)) continue;
        assertions.push({
          kind: "path-exists",
          source: token,
          target: token,
          line: i,
          origin: "auto",
        });
      }
    }
  }

  // De-dupe — the same path mentioned twice should only fire one
  // assertion. We key on (kind, target, pattern).
  const seen = new Set<string>();
  return assertions.filter((a) => {
    const key = `${a.kind}|${a.target}|${a.pattern ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parse a single line of an explicit ctx-assert block. The grammar is
 * deliberately tiny — one assertion per line, two or three
 * whitespace-separated tokens:
 *
 *     path-exists  src/cli/index.ts
 *     grep         package.json    "withctx"
 *     regex        src/foo.ts      /export\s+function/
 *     no-match     src/legacy.ts   "TODO"
 *
 * Returns null when the line isn't a recognised assertion form.
 */
function parseAssertionLine(line: string): Omit<Assertion, "source" | "line" | "origin"> | null {
  // Tokenise with quoted-string support.
  const tokens = tokenize(line);
  if (tokens.length < 2) return null;
  const [kind, target, ...rest] = tokens;
  if (kind === "path-exists") {
    return { kind: "path-exists", target };
  }
  if (kind === "grep" || kind === "regex" || kind === "no-match") {
    if (rest.length === 0) return null;
    return { kind, target, pattern: rest.join(" ") };
  }
  return null;
}

function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && i + 1 < line.length) {
        cur += line[++i];
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Heuristic: does this backticked token look like a path we should
 * verify? We want to catch `src/cli/index.ts`, `tests/foo.test.ts`,
 * `docs/guide/01-quickstart.md`, but NOT `useState`, `Array.from`,
 * `git status`, `--help`, etc.
 *
 * Rules:
 *   - Must contain a `/` (excludes most function calls).
 *   - First segment must be a known top-level dir name OR the token
 *     must end in a recognised file extension.
 *   - Cannot contain spaces or shell-y characters.
 *   - Cannot start with `-` (that's a flag).
 *   - Cannot start with a URL scheme.
 */
const KNOWN_TOP_DIRS = new Set([
  "src", "tests", "test", "docs", "scripts", "lib", "app",
  "packages", "examples", "tools", "config", "internal", "cmd",
  ".ctx", ".github",
]);

const PATH_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|md|mdx|json|ya?ml|toml|sh|py|go|rs|java|kt|swift|rb|cs|php|sql|css|scss|html?|svelte|vue|astro|prisma|graphql|gql|env)$/;

export function looksLikePath(token: string): boolean {
  if (!token) return false;
  if (/\s/.test(token)) return false;
  if (token.startsWith("-") || token.startsWith("/")) return false;
  if (/^[a-z]+:\/\//.test(token)) return false;
  if (!token.includes("/")) return false;
  const head = token.split("/")[0];
  if (KNOWN_TOP_DIRS.has(head)) return true;
  if (PATH_EXT_RE.test(token)) return true;
  return false;
}

// ── Assertion runners ─────────────────────────────────────────────────

export function runAssertion(
  assertion: Assertion,
  options: VerifyOptions = {}
): AssertionResult {
  const projectRoot = options.projectRoot ?? process.cwd();
  const maxBytes = options.maxFileBytes ?? 1024 * 1024;

  // Resolve the target path safely — never escape the project root.
  let absPath: string;
  try {
    absPath = resolveSafe(projectRoot, assertion.target);
  } catch (err) {
    return {
      assertion,
      ok: false,
      reason: err instanceof Error ? err.message : "invalid path",
    };
  }

  switch (assertion.kind) {
    case "path-exists":
      if (!existsSync(absPath)) {
        return { assertion, ok: false, reason: "path does not exist" };
      }
      return { assertion, ok: true, reason: "" };

    case "grep": {
      if (!assertion.pattern) {
        return { assertion, ok: false, reason: "grep requires a pattern" };
      }
      const text = readFileBounded(absPath, maxBytes);
      if (text === null) {
        return { assertion, ok: false, reason: "could not read target file" };
      }
      return text.includes(assertion.pattern)
        ? { assertion, ok: true, reason: "" }
        : { assertion, ok: false, reason: `substring "${assertion.pattern}" not found` };
    }

    case "regex": {
      if (!assertion.pattern) {
        return { assertion, ok: false, reason: "regex requires a pattern" };
      }
      const text = readFileBounded(absPath, maxBytes);
      if (text === null) {
        return { assertion, ok: false, reason: "could not read target file" };
      }
      const re = compileRegex(assertion.pattern);
      if (!re) {
        return { assertion, ok: false, reason: "invalid regex" };
      }
      return re.test(text)
        ? { assertion, ok: true, reason: "" }
        : { assertion, ok: false, reason: "regex did not match" };
    }

    case "no-match": {
      if (!assertion.pattern) {
        return { assertion, ok: false, reason: "no-match requires a pattern" };
      }
      const text = readFileBounded(absPath, maxBytes);
      if (text === null) {
        return { assertion, ok: false, reason: "could not read target file" };
      }
      return text.includes(assertion.pattern)
        ? { assertion, ok: false, reason: `forbidden substring "${assertion.pattern}" found` }
        : { assertion, ok: true, reason: "" };
    }

    default:
      return { assertion, ok: false, reason: "unknown assertion kind" };
  }
}

function readFileBounded(path: string, maxBytes: number): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) {
      // Read just the head — large files almost always show their
      // truth in the first MiB and we don't want a 50 MB lockfile to
      // freeze the run.
      const buf = Buffer.alloc(maxBytes);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buf, 0, maxBytes, 0);
      } finally {
        closeSync(fd);
      }
      return buf.toString("utf-8");
    }
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Parse a `/pattern/flags` literal or a bare pattern. Returns null on
 * a syntactically invalid regex so the runner can report it cleanly.
 */
function compileRegex(input: string): RegExp | null {
  try {
    const m = input.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m) return new RegExp(m[1], m[2]);
    return new RegExp(input);
  } catch {
    return null;
  }
}

/**
 * Files and directories that assertions must never read, even if they
 * live inside the project root. The trust pipeline already blocks LLM-
 * generated assertions at compile time via `stripCtxAssertBlocks`, so
 * the only way an assertion reaches this function is by a human author
 * writing one — but a careless `grep .env AWS_SECRET` assertion would
 * still turn the assertion runner into a side-channel oracle that leaks
 * one bit per run. Rather than relying on authors to be careful, we
 * refuse to touch any file whose path segment matches one of these
 * patterns at all.
 *
 * Patterns are applied to:
 *   1. every segment of the *relative* path from the project root
 *   2. the final basename (for exact matches like `.netrc`)
 *
 * Keep this list tight — the point is "obvious secrets", not "anything
 * that could possibly be sensitive". If the list gets too broad it
 * becomes a foot-gun for legitimate page-author assertions.
 */
const SENSITIVE_PATH_SEGMENTS = [
  /^\.env(\..*)?$/i,              // .env, .env.local, .env.production
  /^\.netrc$/i,
  /^credentials(\..*)?$/i,        // credentials, credentials.json
  /^\.npmrc$/i,                   // often contains auth tokens
  /^\.pypirc$/i,
  /^id_rsa(\..*)?$/i,
  /^id_ed25519(\..*)?$/i,
  /^id_ecdsa(\..*)?$/i,
  /^id_dsa(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.kdbx$/i,
];

/**
 * Directories whose entire subtree is off limits. Matched against any
 * path segment, so `foo/.ssh/config` is just as blocked as `.ssh/config`.
 */
const SENSITIVE_PATH_DIRS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".config",  // fallback — ~/.config stores tokens for gcloud, gh, etc.
]);

function isSensitivePath(relPath: string): boolean {
  // Use forward slash for consistency — path.sep is `\` on Windows but
  // the ctx-assert grammar and every page is checked in with `/`.
  const segments = relPath.split(/[\\/]/).filter((s) => s && s !== ".");
  for (const segment of segments) {
    if (SENSITIVE_PATH_DIRS.has(segment)) return true;
    if (SENSITIVE_PATH_SEGMENTS.some((re) => re.test(segment))) return true;
  }
  return false;
}

/**
 * Resolve a target path against the project root and return the
 * absolute path, refusing anything that:
 *
 *   1. is absolute — assertions use project-relative paths only
 *   2. resolves outside the project tree via `..` or symlinks
 *   3. lands on a known-sensitive file (see SENSITIVE_PATH_SEGMENTS)
 *
 * The containment check runs BEFORE and AFTER `resolve` so a relative
 * path like `foo/../../etc/passwd` is rejected even on case-insensitive
 * filesystems where a naive `startsWith` comparison would fail (e.g.
 * APFS where `/Users` and `/users` are equal under lookup but not
 * under string comparison).
 *
 * When the resolved path already exists we also run it through
 * `realpathSync` so a symlink sitting inside the project tree cannot
 * be used to reach `/etc/passwd`. Non-existent paths skip the realpath
 * check — `path-exists` assertions legitimately check paths that might
 * not exist yet, and rejecting them here would break that workflow.
 */
function resolveSafe(root: string, target: string): string {
  if (typeof target !== "string" || target === "") {
    throw new Error("assertion target must be a non-empty string");
  }
  if (isAbsolute(target)) {
    throw new Error("absolute paths are not allowed in assertions");
  }
  // NUL bytes in paths are a classic filesystem bypass — Node's
  // `readFileSync` truncates at the NUL on some platforms, which
  // could let `foo.ts\0.txt` read `foo.ts` while appearing in logs
  // as `foo.ts\0.txt`. Refuse outright.
  if (target.includes("\0")) {
    throw new Error("assertion target contains a NUL byte");
  }

  const normalised = normalize(target);
  if (normalised.startsWith("..") || normalised === "..") {
    throw new Error("path escapes the project root");
  }

  // Resolve both the root and the target so the containment check
  // compares apples to apples. `resolve` collapses `..` segments, so
  // `foo/../../etc/passwd` becomes `/etc/passwd` here and fails the
  // startsWith test below.
  const absRoot = resolve(root);
  const absPath = resolve(absRoot, normalised);

  // Containment check. Must either equal the root exactly or start
  // with `root + sep` — plain `startsWith(root)` would accept e.g.
  // `/home/alice-evil/file` as being inside `/home/alice`.
  if (absPath !== absRoot && !absPath.startsWith(absRoot + sep)) {
    throw new Error("path escapes the project root");
  }

  // Symlink containment: if the path (or any ancestor) is a symlink
  // pointing outside the project tree, `realpathSync` exposes that.
  // Only run it when the path actually exists — a not-yet-created
  // file can't be a symlink to anywhere.
  if (existsSync(absPath)) {
    try {
      const real = realpathSync(absPath);
      const realRoot = realpathSync(absRoot);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new Error("path escapes the project root via a symlink");
      }
    } catch (err) {
      // If realpath itself fails (permission denied on a parent dir,
      // etc.) treat that as a containment failure — we'd rather a
      // false negative than a silent escape.
      if (err instanceof Error && err.message.includes("escapes")) throw err;
      throw new Error("could not verify path containment");
    }
  }

  // Sensitive-file blocklist. Run this last so the containment check
  // has already proved the path is local to the repo — the blocklist
  // is defence in depth against a mistaken or malicious ctx-assert
  // block that tries to turn the verifier into a secret-leak oracle.
  const rel = relative(absRoot, absPath);
  if (isSensitivePath(rel) || isSensitivePath(basename(absPath))) {
    throw new Error(
      `refusing to verify a sensitive path (${rel || basename(absPath)}) — ` +
        `assertions must not target secrets, credentials, or key material`
    );
  }

  return absPath;
}

// ── High-level facade ─────────────────────────────────────────────────

/**
 * Run every assertion on a page and return a structured result. Does
 * NOT mutate the page — `applyVerification` does that.
 */
export function verifyPage(content: string, options: VerifyOptions = {}): VerifyResult {
  const parsed = parsePage(content);
  const assertions = extractAssertions(parsed.body, { explicitOnly: options.explicitOnly });
  const results = assertions.map((a) => runAssertion(a, options));
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const ranAt = (options.now ?? new Date()).toISOString();
  return { assertions, results, passed, failed, ranAt };
}

/**
 * Run verification AND stamp the result into the page's front-matter.
 * Returns the new page content alongside the structured result so
 * callers can render the run report and write the file in a single
 * pass.
 *
 * Tier promotion rules:
 *   - all assertions passed AND there is at least one assertion →
 *     promote tier to "verified"
 *   - any assertion failed AND tier was previously "verified" →
 *     demote to "asserted" so the page no longer flies a green flag
 *     while it's broken
 *   - no assertions found → leave the tier alone
 */
export function applyVerification(
  content: string,
  options: VerifyOptions = {}
): { content: string; result: VerifyResult } {
  const result = verifyPage(content, options);
  const parsed = parsePage(content);

  // Decide the new tier first so we can build the merged object in
  // canonical key order (matches normalizeMeta) — that keeps the
  // serialized YAML stable across repeat runs.
  let nextTier = parsed.meta.tier;
  if (result.assertions.length > 0) {
    if (result.failed === 0 && result.passed > 0) {
      nextTier = "verified";
    } else if (result.failed > 0 && parsed.meta.tier === "verified") {
      nextTier = "asserted";
    }
  }

  const merged: PageMetadata = {};
  if (parsed.meta.refreshed_at !== undefined) merged.refreshed_at = parsed.meta.refreshed_at;
  if (parsed.meta.refreshed_by !== undefined) merged.refreshed_by = parsed.meta.refreshed_by;
  if (parsed.meta.commit !== undefined) merged.commit = parsed.meta.commit;
  if (parsed.meta.sources !== undefined) merged.sources = parsed.meta.sources;
  if (parsed.meta.model !== undefined) merged.model = parsed.meta.model;
  if (nextTier !== undefined) merged.tier = nextTier;
  merged.verified = {
    passed: result.passed,
    failed: result.failed,
    last_run_at: result.ranAt,
  };
  if (parsed.meta.blessed_by !== undefined) merged.blessed_by = parsed.meta.blessed_by;
  if (parsed.meta.blessed_at !== undefined) merged.blessed_at = parsed.meta.blessed_at;
  if (parsed.meta.blessed_at_sha !== undefined) merged.blessed_at_sha = parsed.meta.blessed_at_sha;
  if (parsed.meta.blessed_note !== undefined) merged.blessed_note = parsed.meta.blessed_note;

  return {
    content: formatPage(parsed.body, merged, parsed.otherFrontmatter),
    result,
  };
}
