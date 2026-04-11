/**
 * `ctx why <claim>` — evidence trace.
 *
 * Answers the question "where did this come from?" by walking the wiki
 * for pages that support the claim, then rendering the full provenance
 * chain: page → excerpt → refreshed_at → sources → bless state.
 *
 * Zero LLM cost, zero network — everything is deterministic string
 * matching plus metadata lookup. This is the trust-probe command.
 *
 * See docs/guide/03-commands.md § "ctx why" for the UX.
 */

import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { findEvidence, type EvidenceHit } from "../../wiki/why.js";
import {
  noCtxDirError,
  noWikiPagesError,
  invalidArgumentError,
} from "../../errors.js";
import type { WikiPage } from "../../types/page.js";

interface WhyOptions {
  limit?: string;
  minScore?: string;
  caseSensitive?: boolean;
  json?: boolean;
  blame?: boolean;
  bisect?: boolean;
}

export function registerWhyCommand(program: Command): void {
  program
    .command("why")
    .description(
      "Trace the evidence for a claim — shows which page, excerpt, refresh time, sources, and bless state"
    )
    .argument("<claim...>", "The claim to trace (quotes or bare words both work)")
    .option("-n, --limit <n>", "Max hits to show (default: 5)")
    .option(
      "--min-score <s>",
      "Minimum fuzzy-match score 0–1 for partial hits (default: 0.4)"
    )
    .option("--case-sensitive", "Use case-sensitive matching")
    .option("--json", "Emit results as JSON (for scripts and agents)")
    .option(
      "--blame",
      "Show the commit each hit was last refreshed against (reserved — same as default for now)"
    )
    .option(
      "--bisect",
      "Walk backwards through the refresh journal to find when the claim first appeared (reserved)"
    )
    .action(async (claimParts: string[], opts: WhyOptions) => {
      const claim = claimParts.join(" ").trim();
      if (claim.length === 0) {
        throw invalidArgumentError(
          "empty claim",
          "Pass the claim to trace, e.g. `ctx why \"we use PostgreSQL\"`."
        );
      }

      const json = opts.json === true;

      loadConfig();
      const projectRoot = getProjectRoot();
      const ctxDir = new CtxDirectory(projectRoot);
      if (!ctxDir.exists()) throw noCtxDirError();

      const pageManager = new PageManager(ctxDir);
      const pagePaths = pageManager.list();

      if (pagePaths.length === 0) throw noWikiPagesError();

      // Materialise every page into memory. The wiki is small
      // enough (O(100s) of pages) that a single walk is cheaper
      // than any clever indexing scheme, and keeps this module
      // dependency-free on the vector store.
      const pages: WikiPage[] = [];
      for (const p of pagePaths) {
        const page = pageManager.read(p);
        if (page) pages.push(page);
      }

      const hits = findEvidence(claim, pages, {
        limit: opts.limit ? Math.max(1, parseInt(opts.limit, 10)) : undefined,
        minScore: opts.minScore ? parseFloat(opts.minScore) : undefined,
        caseSensitive: opts.caseSensitive === true,
      });

      if (json) {
        console.log(
          JSON.stringify(
            {
              claim,
              count: hits.length,
              results: hits.map(hitToJson),
            },
            null,
            2
          )
        );
        return;
      }

      renderHuman(claim, hits);
    });
}

// ── Human rendering ──────────────────────────────────────────────────

function renderHuman(claim: string, hits: EvidenceHit[]): void {
  console.log();
  console.log(
    chalk.bold("  Tracing: ") + chalk.cyan(truncate(claim, 80))
  );
  console.log();

  if (hits.length === 0) {
    console.log(chalk.yellow("  No evidence found for this claim in the wiki."));
    console.log(
      chalk.dim(
        "  Tip: try fewer words, or run `ctx search` for semantic (vector) matching."
      )
    );
    console.log();
    return;
  }

  hits.forEach((hit, index) => {
    const header =
      chalk.bold(`  ${index + 1}. ${hit.page}`) +
      chalk.dim(`  (lines ${hit.lineStart + 1}–${hit.lineEnd + 1})`);
    const kindTag =
      hit.matchKind === "literal"
        ? chalk.green("literal match")
        : chalk.yellow(`fuzzy match · ${(hit.score * 100).toFixed(0)}% word overlap`);

    console.log(header);
    console.log(`     ${kindTag}`);
    console.log();
    // Indent the excerpt under a chalk-dimmed block. Cap at ~240
    // chars so a quoted blob doesn't blow up the terminal.
    const excerpt = truncate(hit.excerpt.replace(/\n/g, "\n     "), 240);
    console.log(chalk.dim(`     > ${excerpt}`));
    console.log();

    // Provenance block.
    const provenance: string[] = [];
    if (hit.meta.refreshed_at) {
      const rel = relativeTime(hit.meta.refreshed_at);
      provenance.push(`refreshed ${chalk.cyan(rel)}`);
      if (hit.meta.refreshed_by) {
        provenance.push(`by ${chalk.cyan(hit.meta.refreshed_by)}`);
      }
    }
    if (hit.meta.commit) {
      provenance.push(chalk.dim(`@ ${hit.meta.commit}`));
    }
    if (hit.meta.tier) {
      provenance.push(tierBadge(hit.meta.tier));
    }
    if (provenance.length > 0) {
      console.log(`     ${chalk.dim("refresh:")}  ${provenance.join(" · ")}`);
    }

    // Sources.
    if (hit.sources.length > 0) {
      console.log(
        `     ${chalk.dim("sources:")} ${hit.sources
          .slice(0, 3)
          .map((s) => chalk.cyan(truncate(s, 60)))
          .join(", ")}${hit.sources.length > 3 ? chalk.dim(` (+${hit.sources.length - 3} more)`) : ""}`
      );
    }

    // Bless state.
    if (hit.bless.status === "blessed") {
      const by = hit.bless.stamp.blessed_by;
      const when = relativeTime(hit.bless.stamp.blessed_at);
      const shaBit = hit.bless.stamp.blessed_at_sha
        ? chalk.dim(` @ ${hit.bless.stamp.blessed_at_sha}`)
        : "";
      console.log(
        `     ${chalk.dim("approval:")} ${chalk.green("\u2713")} approved by ${chalk.cyan(by)} ${chalk.dim(when)}${shaBit}`
      );
    } else {
      console.log(
        `     ${chalk.dim("approval:")} ${chalk.yellow("\u26A0")} not yet reviewed — run ${chalk.cyan(`ctx approve ${hit.page}`)} after confirming`
      );
    }

    console.log();
  });

  // Footer summary — a single-line nudge reinforcing the trust story.
  const blessedCount = hits.filter((h) => h.bless.status === "blessed").length;
  const total = hits.length;
  if (blessedCount < total) {
    console.log(
      chalk.dim(
        `  ${blessedCount}/${total} of these pages have been human-reviewed.`
      )
    );
    console.log();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function hitToJson(h: EvidenceHit) {
  return {
    page: h.page,
    title: h.title,
    lineStart: h.lineStart,
    lineEnd: h.lineEnd,
    excerpt: h.excerpt,
    matchKind: h.matchKind,
    score: h.score,
    refreshedAt: h.meta.refreshed_at,
    refreshedBy: h.meta.refreshed_by,
    commit: h.meta.commit,
    tier: h.meta.tier,
    sources: h.sources,
    bless:
      h.bless.status === "blessed"
        ? {
            status: "blessed" as const,
            blessed_by: h.bless.stamp.blessed_by,
            blessed_at: h.bless.stamp.blessed_at,
            blessed_at_sha: h.bless.stamp.blessed_at_sha,
          }
        : { status: "unblessed" as const },
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return "unknown";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "in the future";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function tierBadge(tier: string): string {
  switch (tier) {
    case "verified":
      return chalk.green("verified");
    case "asserted":
      return chalk.cyan("asserted");
    case "manual":
      return chalk.yellow("manual");
    case "historical":
      return chalk.dim("historical");
    default:
      return chalk.dim(tier);
  }
}
