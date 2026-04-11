/**
 * `ctx approve <page>` — the human "I've read this and it's correct" gesture.
 *
 * Stamps an approval block into a wiki page's YAML front-matter:
 *
 *     ---
 *     ctx:
 *       refreshed_at: 2026-04-10T09:12:33Z
 *       refreshed_by: ci:withctx
 *       blessed_by: imam@acme.com       ← reviewer identity
 *       blessed_at: 2026-04-10T14:32:00Z  ← approval timestamp
 *       blessed_at_sha: a3f9c2b           ← git HEAD at approval time
 *       blessed_note: "verified against prod deploy"  ← optional
 *     ---
 *
 * > Note: the on-disk field names are still `blessed_*` because they
 * > represent the stored data and renaming them would break every
 * > existing wiki. The user-facing command and output are `approve`.
 * > A future `ctx migrate` can rename the storage layer if needed.
 *
 * Intentionally small. No LLM call, no network — just read the page,
 * stamp it, write it back. Speed matters because this is a daily
 * ritual; a slow `ctx approve` would kill the habit.
 *
 * Supports three forms:
 *
 *     ctx approve overview.md            # stamp a single page
 *     ctx approve --all-touched          # approve every page modified in the
 *                                        # current working tree since its
 *                                        # last refresh — used when you've
 *                                        # reviewed a batch in one session
 *     ctx approve overview.md --revoke   # remove the approval block
 *
 * The old verb `ctx bless` is kept as a hidden alias so muscle memory
 * and existing scripts don't break. All new docs, help output, and
 * tab-completions use `ctx approve`.
 *
 * See docs/guide/03-commands.md § "ctx approve" for the full UX.
 */

import { Command } from "commander";
import chalk from "chalk";
import { statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { blessPage, revokeBless, readBlessState } from "../../wiki/bless.js";
import {
  noCtxDirError,
  pageNotFoundError,
  invalidArgumentError,
} from "../../errors.js";

interface ApproveOptions {
  revoke?: boolean;
  allTouched?: boolean;
  note?: string;
  json?: boolean;
  asUser?: string;
}

interface ApproveResult {
  page: string;
  action: "approved" | "revoked" | "skipped";
  approved_by?: string;
  approved_at?: string;
  approved_at_sha?: string;
  reason?: string;
}

// ── Command registration ──────────────────────────────────────────────

export function registerApproveCommand(program: Command): void {
  program
    .command("approve [page]")
    .alias("bless") // hidden muscle-memory alias — old scripts keep working
    .description(
      "Mark a page as human-reviewed — stamps reviewer + timestamp into the front-matter"
    )
    .option("--revoke", "Remove the approval block from the page")
    .option("--all-touched", "Approve every page modified on disk since its last refresh")
    .option("--note <text>", "Optional free-text review note to store alongside the approval")
    .option("--as <email>", "Override the reviewer identity (defaults to git config user.email)")
    .option("--json", "Emit the result as JSON (for scripts and CI)")
    .action(async (pageArg: string | undefined, rawOpts: ApproveOptions & { as?: string }) => {
      const opts: ApproveOptions = {
        ...rawOpts,
        asUser: rawOpts.as,
      };

      // Validate argument shape early — Commander won't catch "neither
      // a page nor --all-touched was passed" or "page + --all-touched
      // were both passed".
      if (!pageArg && !opts.allTouched) {
        throw invalidArgumentError(
          "missing page argument",
          "Pass a page name (e.g. `ctx approve overview.md`) or `--all-touched` to approve every modified page."
        );
      }
      if (pageArg && opts.allTouched) {
        throw invalidArgumentError(
          "conflicting arguments",
          "Use either `ctx approve <page>` or `ctx approve --all-touched`, not both."
        );
      }

      // Config / directory resolution ─ same guardrails every read
      // command uses. Every failure maps to a sysexits-style code via
      // the central error handler in cli/index.ts.
      loadConfig(); // throws noConfigError when no ctx.yaml found
      const projectRoot = getProjectRoot();
      const ctxDir = new CtxDirectory(projectRoot);
      if (!ctxDir.exists()) {
        throw noCtxDirError();
      }

      const pageManager = new PageManager(ctxDir);
      const results: ApproveResult[] = [];

      if (opts.allTouched) {
        const touched = findTouchedPages(ctxDir, pageManager);
        if (touched.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ results: [], count: 0 }, null, 2));
          } else {
            console.log(chalk.dim("  No pages have been touched since their last refresh."));
          }
          return;
        }
        for (const rel of touched) {
          results.push(applyApproval(pageManager, rel, opts, projectRoot));
        }
      } else if (pageArg) {
        const normalized = normalizePagePath(pageArg);
        const raw = pageManager.readRaw(normalized);
        if (raw === null) {
          throw pageNotFoundError(normalized);
        }
        results.push(applyApproval(pageManager, normalized, opts, projectRoot));
      }

      // ── Output ──────────────────────────────────────────────────────
      if (opts.json) {
        console.log(JSON.stringify({ results, count: results.length }, null, 2));
        return;
      }

      renderHumanOutput(results, opts);
    });
}

// ── Core approval / revocation application ──────────────────────────
//
// Internals still talk to `blessPage` / `readBlessState` in
// src/wiki/bless.ts — those are storage-layer names and renaming them
// would cascade into every existing wiki's YAML. Keep the user-facing
// vocabulary (`approve`, `approved_by`) and the storage vocabulary
// (`blessed_by`) separated here.

function applyApproval(
  pageManager: PageManager,
  relPath: string,
  opts: ApproveOptions,
  projectRoot: string
): ApproveResult {
  const raw = pageManager.readRaw(relPath);
  if (raw === null) {
    throw pageNotFoundError(relPath);
  }

  if (opts.revoke) {
    const before = readBlessState(raw);
    if (before.status === "unblessed") {
      return { page: relPath, action: "skipped", reason: "page was not approved" };
    }
    const next = revokeBless(raw);
    // skipStamp so we don't accidentally bump refreshed_at just because
    // the reviewer changed their mind — approval is orthogonal to
    // compilation freshness and shouldn't pollute the refresh journal.
    pageManager.write(relPath, next, { skipStamp: true });
    return { page: relPath, action: "revoked" };
  }

  const stamped = blessPage(raw, {
    blessedBy: opts.asUser,
    note: opts.note,
    cwd: projectRoot,
  });
  pageManager.write(relPath, stamped, { skipStamp: true });

  const state = readBlessState(stamped);
  if (state.status !== "blessed") {
    // Should be impossible, but fall back to a safe no-op result.
    return { page: relPath, action: "skipped", reason: "approval stamp failed silently" };
  }
  return {
    page: relPath,
    action: "approved",
    approved_by: state.stamp.blessed_by,
    approved_at: state.stamp.blessed_at,
    ...(state.stamp.blessed_at_sha && { approved_at_sha: state.stamp.blessed_at_sha }),
  };
}

// ── --all-touched discovery ──────────────────────────────────────────
//
// A page is "touched" when its on-disk mtime is later than its
// front-matter refreshed_at. Anything the reviewer edited manually
// (e.g. fixing a typo in the compiled page) falls into this bucket,
// as does any page where `ctx sync` happened but never re-stamped the
// freshness header.

function findTouchedPages(ctxDir: CtxDirectory, pageManager: PageManager): string[] {
  const all = pageManager.list();
  const touched: string[] = [];
  for (const rel of all) {
    const base = rel.split("/").pop() ?? rel;
    if (base === "index.md" || base === "log.md" || base === "glossary.md") continue;

    const full = join(ctxDir.contextPath, rel);
    let mtime: number;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      continue;
    }

    const page = pageManager.read(rel);
    if (!page) continue;

    const refreshedAt = page.meta?.refreshed_at;
    if (!refreshedAt) {
      // No refresh header at all → treat as touched so the approval
      // can serve as the page's first trust signal.
      touched.push(rel);
      continue;
    }
    const refreshedMs = Date.parse(refreshedAt);
    if (!Number.isFinite(refreshedMs) || mtime > refreshedMs + 1000) {
      // +1000ms tolerance: some filesystems round mtime to seconds,
      // so a page written 200ms ago can appear "touched" against its
      // own ISO-millisecond refresh stamp.
      touched.push(rel);
    }
  }
  return touched;
}

// ── Path normalisation ───────────────────────────────────────────────
//
// Users type `ctx bless overview.md`, `ctx bless overview`, or even
// `ctx bless .ctx/context/overview.md`. We accept all three and
// normalise to the canonical `overview.md` form the PageManager
// expects. Anything with a leading slash or `..` is rejected — the
// bless target must live inside the wiki.

function normalizePagePath(input: string): string {
  let p = input.trim();

  // IMPORTANT: check for `..` and absolute paths on the *raw* input
  // BEFORE stripping any prefix. Otherwise an input like
  // `.ctx/context/../../../etc/passwd.md` would survive the prefix
  // strip as `../../../etc/passwd.md`, and while the second `..`
  // check would still catch it, the invariant would depend on two
  // checks firing in the right order. Checking the raw form first
  // makes the safety property obvious by inspection.
  if (p.includes("..")) {
    throw invalidArgumentError(
      input,
      "Page paths must not contain `..` — they're scoped to the wiki directory."
    );
  }
  if (p.startsWith("/")) {
    throw invalidArgumentError(
      input,
      "Page paths must be relative to .ctx/context/ — e.g. `overview.md`, not `/overview.md`."
    );
  }

  if (p.startsWith("./")) p = p.slice(2);
  // Strip an explicit `.ctx/context/` prefix if present. Safe to do
  // after the `..` check above — any traversal sequence has already
  // been rejected.
  if (p.startsWith(".ctx/context/")) p = p.slice(".ctx/context/".length);

  if (!p.endsWith(".md")) p = `${p}.md`;
  return p;
}

// ── Human-friendly output ────────────────────────────────────────────

function renderHumanOutput(results: ApproveResult[], opts: ApproveOptions): void {
  if (results.length === 0) {
    console.log(chalk.dim("  (no pages to approve)"));
    return;
  }

  const approved = results.filter((r) => r.action === "approved");
  const revoked = results.filter((r) => r.action === "revoked");
  const skipped = results.filter((r) => r.action === "skipped");

  console.log();
  for (const r of results) {
    if (r.action === "approved") {
      const parts: string[] = [chalk.green("\u2713")];
      parts.push(chalk.bold(r.page));
      parts.push(chalk.dim("approved by"));
      parts.push(chalk.cyan(r.approved_by ?? "unknown"));
      if (r.approved_at_sha) {
        parts.push(chalk.dim(`@ ${r.approved_at_sha}`));
      }
      console.log(`  ${parts.join(" ")}`);
    } else if (r.action === "revoked") {
      console.log(
        `  ${chalk.yellow("\u25E6")} ${chalk.bold(r.page)} ${chalk.dim("approval revoked")}`
      );
    } else {
      console.log(
        `  ${chalk.dim("\u2013")} ${chalk.bold(r.page)} ${chalk.dim(r.reason ?? "skipped")}`
      );
    }
  }

  // Footer summary when more than one page was processed.
  if (results.length > 1) {
    console.log();
    const pieces: string[] = [];
    if (approved.length > 0) pieces.push(chalk.green(`${approved.length} approved`));
    if (revoked.length > 0) pieces.push(chalk.yellow(`${revoked.length} revoked`));
    if (skipped.length > 0) pieces.push(chalk.dim(`${skipped.length} skipped`));
    console.log(`  ${pieces.join(chalk.dim(" · "))}`);
  }

  // First-time hint: if the reviewer probably has no git identity
  // configured, tell them how to make the approval stamp more meaningful.
  if (approved.length > 0 && !opts.asUser) {
    const first = approved[0];
    if (first.approved_by === "unknown") {
      console.log();
      console.log(
        chalk.dim(
          "  Tip: set your reviewer identity with `git config --global user.email you@example.com`."
        )
      );
    }
  }
  console.log();
}
