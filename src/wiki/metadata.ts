/**
 * Page-level freshness metadata — the Info-axis cornerstone.
 *
 * Every wiki page carries a YAML front-matter block namespaced under
 * `ctx`. It records when the page was compiled, by whom, against which
 * commit, how many source documents contributed, and how many assertion
 * checks were run / passed. That gives both humans (raw-view readers,
 * GitHub renderers) and machines (`ctx status`, `ctx verify`, `ctx
 * lint`) a single source of truth for "is this page still worth
 * trusting?".
 *
 * We use YAML front-matter rather than HTML comments or JSON because:
 *   - GitHub renders it as a table in the blob view
 *   - Static site generators, VS Code, IntelliJ and `mdsvex` all
 *     recognise it for free
 *   - `git diff` remains human-readable
 *   - It survives round-tripping through any markdown parser
 *
 * The block is ALWAYS scoped under a single top-level `ctx` key so we
 * never stomp on user-authored front-matter (e.g. `title`, `tags`,
 * `draft`).
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Runtime shape of page metadata. All fields optional because older
 * pages and user-authored manual notes may not carry every field.
 */
export interface PageMetadata {
  /** ISO-8601 UTC timestamp of the last compile/refresh for this page. */
  refreshed_at?: string;
  /** `user@host` or `ci:<workflow>` — matches the refresh journal. */
  refreshed_by?: string;
  /** Git commit SHA the page was compiled against (short form). */
  commit?: string;
  /** Number of source documents that contributed to this page. */
  sources?: number;
  /** Model that compiled the page, e.g. `claude-sonnet-4-20250514`. */
  model?: string;
  /** Trust tier — see docs/STANDARDS.md § Info. */
  tier?: "verified" | "asserted" | "manual" | "historical";
  /** Assertion checks declared by the page (see `ctx verify`). */
  verified?: {
    passed: number;
    failed: number;
    last_run_at?: string;
  };
  /**
   * Human bless block — stamped by `ctx bless <page>`. Represents a
   * person saying "I've read this page and it's correct as of this
   * commit". Unlike `refreshed_*` (which records automated compilation),
   * bless is an explicit human review signal.
   *
   * `blessed_at_sha` pins the review to a git commit so `ctx lint` can
   * detect drift: if the source files feeding the page have moved since
   * the bless SHA, the bless is stale and should be refreshed.
   *
   * Stamping with no existing blessed_at upgrades the page tier; calling
   * with `--revoke` removes the block entirely.
   */
  blessed_by?: string;
  blessed_at?: string;
  blessed_at_sha?: string;
  blessed_note?: string;
}

/**
 * Parsed page — the content with any `ctx:` front-matter stripped and
 * the metadata returned alongside.
 */
export interface ParsedPage {
  /** Page body with the `ctx` front-matter removed. */
  body: string;
  /** Parsed ctx metadata (empty object if none present). */
  meta: PageMetadata;
  /** Any other top-level keys in the original front-matter (preserved). */
  otherFrontmatter: Record<string, unknown>;
}

// ── Front-matter detection ────────────────────────────────────────────
//
// We treat a block of the form:
//
//     ---\n
//     <yaml>\n
//     ---\n
//
// at the very start of the file as front-matter. We tolerate a BOM and
// leading blank lines; we do NOT treat a later `---` rule as a
// delimiter (that would eat horizontal rules in the body).

const FRONTMATTER_RE = /^\uFEFF?(?:\r?\n)*---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parsePage(content: string): ParsedPage {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { body: content, meta: {}, otherFrontmatter: {} };
  }

  const yamlBlock = match[1];
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch {
    // Malformed front-matter — leave the page untouched so we never
    // destructively drop user content.
    return { body: content, meta: {}, otherFrontmatter: {} };
  }

  if (!parsed || typeof parsed !== "object") {
    return { body: content, meta: {}, otherFrontmatter: {} };
  }

  const fm = parsed as Record<string, unknown>;
  const ctxBlock = fm.ctx;
  const meta: PageMetadata =
    ctxBlock && typeof ctxBlock === "object"
      ? normalizeMeta(ctxBlock as Record<string, unknown>)
      : {};

  // Preserve any non-ctx keys the user put in their own front-matter.
  const { ctx: _ignored, ...otherFrontmatter } = fm;

  return {
    body: content.slice(match[0].length),
    meta,
    otherFrontmatter,
  };
}

function normalizeMeta(raw: Record<string, unknown>): PageMetadata {
  const meta: PageMetadata = {};
  if (typeof raw.refreshed_at === "string") meta.refreshed_at = raw.refreshed_at;
  if (typeof raw.refreshed_by === "string") meta.refreshed_by = raw.refreshed_by;
  if (typeof raw.commit === "string") meta.commit = raw.commit;
  if (typeof raw.sources === "number") meta.sources = raw.sources;
  if (typeof raw.model === "string") meta.model = raw.model;
  if (
    raw.tier === "verified" ||
    raw.tier === "asserted" ||
    raw.tier === "manual" ||
    raw.tier === "historical"
  ) {
    meta.tier = raw.tier;
  }
  if (raw.verified && typeof raw.verified === "object") {
    const v = raw.verified as Record<string, unknown>;
    const passed = typeof v.passed === "number" ? v.passed : 0;
    const failed = typeof v.failed === "number" ? v.failed : 0;
    meta.verified = {
      passed,
      failed,
      ...(typeof v.last_run_at === "string" && { last_run_at: v.last_run_at }),
    };
  }
  if (typeof raw.blessed_by === "string") meta.blessed_by = raw.blessed_by;
  if (typeof raw.blessed_at === "string") meta.blessed_at = raw.blessed_at;
  if (typeof raw.blessed_at_sha === "string") meta.blessed_at_sha = raw.blessed_at_sha;
  if (typeof raw.blessed_note === "string") meta.blessed_note = raw.blessed_note;
  return meta;
}

/**
 * Render a front-matter block + body into a serialized page. If `meta`
 * is empty AND there is no other front-matter, the original body is
 * returned unchanged so manual notes don't get a gratuitous header.
 */
export function formatPage(
  body: string,
  meta: PageMetadata,
  other: Record<string, unknown> = {}
): string {
  const hasCtx = Object.keys(meta).length > 0;
  const hasOther = Object.keys(other).length > 0;
  if (!hasCtx && !hasOther) return body;

  const fm: Record<string, unknown> = { ...other };
  if (hasCtx) fm.ctx = meta;

  const yaml = stringifyYaml(fm, { indent: 2 }).trimEnd();
  const leadingNewline = body.startsWith("\n") ? "" : "\n";
  return `---\n${yaml}\n---\n${leadingNewline}${body}`;
}

/**
 * Inject/replace the `ctx` front-matter block on a page. Preserves any
 * user-authored top-level front-matter keys (title, tags, etc.). Any
 * existing `ctx` keys not overridden by `patch` are kept.
 */
export function stampMetadata(
  content: string,
  patch: PageMetadata
): string {
  const { body, meta: existing, otherFrontmatter } = parsePage(content);
  const merged: PageMetadata = { ...existing, ...patch };
  return formatPage(body, merged, otherFrontmatter);
}

/**
 * Strip the `ctx` front-matter from a page — used when we want the
 * rendered body for display, export, or downstream LLM prompts.
 */
export function stripMetadata(content: string): string {
  const parsed = parsePage(content);
  if (Object.keys(parsed.otherFrontmatter).length === 0) {
    return parsed.body;
  }
  // User had their own front-matter too — preserve it, only drop `ctx`.
  return formatPage(parsed.body, {}, parsed.otherFrontmatter);
}

// ── Presentation helpers ──────────────────────────────────────────────

/**
 * One-line human summary of a page's freshness — used by `ctx status`,
 * `ctx history --page`, and any CLI that wants to show "how stale is
 * this?" without rendering the whole front-matter block.
 */
export function summarizeFreshness(meta: PageMetadata, now = Date.now()): string {
  if (!meta.refreshed_at) return "unknown";
  const ts = new Date(meta.refreshed_at).getTime();
  if (Number.isNaN(ts)) return "unknown";
  const diffMs = now - ts;
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);

  let rel: string;
  if (mins < 1) rel = "just now";
  else if (mins < 60) rel = `${mins}m ago`;
  else if (hours < 24) rel = `${hours}h ago`;
  else if (days < 60) rel = `${days}d ago`;
  else rel = `${Math.floor(days / 30)}mo ago`;

  const parts = [rel];
  if (typeof meta.sources === "number") parts.push(`${meta.sources} source${meta.sources === 1 ? "" : "s"}`);
  if (meta.tier) parts.push(meta.tier);
  return parts.join(" · ");
}
