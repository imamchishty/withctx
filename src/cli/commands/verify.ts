/**
 * `ctx verify [page]` — runs assertion checks against the live tree
 * and stamps the result into each page's front-matter.
 *
 * The trust pipeline:
 *
 *     manual → asserted → verified
 *
 * `ctx verify` is the gate from asserted to verified. It runs in O(repo)
 * time, with no LLM call, so it can sit in CI as a cheap drift catcher.
 *
 * Usage:
 *
 *     ctx verify                       # verify every wiki page
 *     ctx verify overview.md           # verify a single page
 *     ctx verify --explicit-only       # only run ctx-assert blocks
 *     ctx verify --json                # machine-readable output
 *
 * Exit codes:
 *
 *     0  every assertion passed (or no assertions found)
 *     1  one or more assertions failed
 *
 * The non-zero exit on failure makes `ctx verify` plug straight into a
 * pre-commit hook or GitHub Action with no shell glue.
 */

import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { applyVerification, type VerifyResult, type AssertionResult } from "../../wiki/verify.js";
import {
  noCtxDirError,
  pageNotFoundError,
  invalidArgumentError,
} from "../../errors.js";

interface VerifyCmdOptions {
  explicitOnly?: boolean;
  json?: boolean;
  /** Don't write the page back to disk — show the report only. */
  dryRun?: boolean;
}

interface VerifyJsonReport {
  results: Array<{
    page: string;
    passed: number;
    failed: number;
    assertions: Array<{
      kind: string;
      target: string;
      pattern?: string;
      origin: "auto" | "explicit";
      ok: boolean;
      reason?: string;
    }>;
    tier?: string;
  }>;
  totals: { pages: number; passed: number; failed: number };
}

// ── Command registration ──────────────────────────────────────────────

export function registerVerifyCommand(program: Command): void {
  program
    .command("verify [page]")
    .description(
      "Run assertion checks against the live tree and stamp results into the wiki"
    )
    .option(
      "--explicit-only",
      "Only run explicit ctx-assert blocks — skip auto-detected file paths"
    )
    .option("--dry-run", "Run the checks but don't write any pages back to disk")
    .option("--json", "Emit the report as JSON (for scripts and CI)")
    .action(async (pageArg: string | undefined, opts: VerifyCmdOptions) => {
      loadConfig();
      const projectRoot = getProjectRoot();
      const ctxDir = new CtxDirectory(projectRoot);
      if (!ctxDir.exists()) {
        throw noCtxDirError();
      }

      const pageManager = new PageManager(ctxDir);

      // Resolve the target list. A page argument runs verification on
      // exactly that page; no argument verifies every wiki page.
      let targets: string[];
      if (pageArg) {
        const normalised = normalizePagePath(pageArg);
        if (pageManager.readRaw(normalised) === null) {
          throw pageNotFoundError(normalised);
        }
        targets = [normalised];
      } else {
        targets = pageManager
          .list()
          .filter((rel) => {
            const base = rel.split("/").pop() ?? rel;
            // Skip the auto-generated catalogue pages — they reference
            // every other page by path which would generate a flood of
            // useless "passed" entries.
            return base !== "index.md" && base !== "log.md" && base !== "glossary.md";
          });
      }

      // Run verification page by page.
      const results: Array<{ page: string; result: VerifyResult; tier?: string }> = [];
      for (const rel of targets) {
        const raw = pageManager.readRaw(rel);
        if (raw === null) continue;
        const out = applyVerification(raw, {
          projectRoot,
          explicitOnly: opts.explicitOnly,
        });
        if (!opts.dryRun && out.result.assertions.length > 0) {
          // Only persist when there's something to record. Skipping
          // assertion-free pages means `ctx verify` doesn't churn the
          // mtime of every prose page on the wiki.
          pageManager.write(rel, out.content, { skipStamp: true });
        }
        // Re-parse the just-written page so we report the FINAL tier.
        const finalTier =
          out.content.match(/tier:\s*([a-z]+)/)?.[1] ?? undefined;
        results.push({ page: rel, result: out.result, tier: finalTier });
      }

      // Tallies for the footer / exit-code decision.
      const totals = results.reduce(
        (acc, r) => {
          acc.passed += r.result.passed;
          acc.failed += r.result.failed;
          return acc;
        },
        { pages: results.length, passed: 0, failed: 0 }
      );

      if (opts.json) {
        const json: VerifyJsonReport = {
          results: results.map((r) => ({
            page: r.page,
            passed: r.result.passed,
            failed: r.result.failed,
            assertions: r.result.results.map((a) => ({
              kind: a.assertion.kind,
              target: a.assertion.target,
              ...(a.assertion.pattern && { pattern: a.assertion.pattern }),
              origin: a.assertion.origin,
              ok: a.ok,
              ...(!a.ok && { reason: a.reason }),
            })),
            ...(r.tier && { tier: r.tier }),
          })),
          totals,
        };
        console.log(JSON.stringify(json, null, 2));
      } else {
        renderHumanReport(results, totals, opts);
      }

      if (totals.failed > 0) {
        // Non-zero exit so CI / pre-commit hooks can treat verify
        // failures as a hard stop. We use process.exit directly because
        // throwing a CtxError here would imply a misconfiguration —
        // verify failure is a successful run with bad news.
        process.exit(1);
      }
    });
}

// ── Path normalisation (mirrored from bless.ts on purpose) ───────────
//
// Verify and bless take the same kind of arg ("a wiki page name") so
// they share the same loose-but-safe normalisation rules. We don't
// extract this to a util because (a) it's tiny, (b) the two commands
// have slightly different valid-extension policies in mind for the
// future, and (c) inlining keeps each command file readable in
// isolation — the test failures are easier to localise.

function normalizePagePath(input: string): string {
  let p = input.trim();
  if (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith(".ctx/context/")) p = p.slice(".ctx/context/".length);
  if (p.startsWith("/")) {
    throw invalidArgumentError(
      input,
      "Page paths must be relative to .ctx/context/ — e.g. `overview.md`, not `/overview.md`."
    );
  }
  if (p.includes("..")) {
    throw invalidArgumentError(
      input,
      "Page paths must not contain `..` — they're scoped to the wiki directory."
    );
  }
  if (!p.endsWith(".md")) p = `${p}.md`;
  return p;
}

// ── Human-friendly rendering ─────────────────────────────────────────

function renderHumanReport(
  results: Array<{ page: string; result: VerifyResult; tier?: string }>,
  totals: { pages: number; passed: number; failed: number },
  opts: VerifyCmdOptions
): void {
  console.log();

  if (results.length === 0) {
    console.log(chalk.dim("  No pages to verify."));
    console.log();
    return;
  }

  // Page-level lines. We show:
  //   ✓ overview.md   3/3 passed   verified
  //   ✗ services.md   2/3 passed   1 failed
  //                       └─ src/missing.ts (auto): path does not exist
  //   – manual.md     no assertions
  for (const r of results) {
    if (r.result.assertions.length === 0) {
      console.log(
        `  ${chalk.dim("\u2013")} ${chalk.bold(r.page)}   ${chalk.dim("no assertions")}`
      );
      continue;
    }
    const ok = r.result.failed === 0;
    const marker = ok ? chalk.green("\u2713") : chalk.red("\u2717");
    const ratio = `${r.result.passed}/${r.result.assertions.length} passed`;
    const tierBadge = r.tier ? formatTier(r.tier) : "";
    const failedBadge =
      r.result.failed > 0 ? chalk.red(`${r.result.failed} failed`) : "";
    const parts = [marker, chalk.bold(r.page), chalk.dim(ratio)];
    if (failedBadge) parts.push(failedBadge);
    if (tierBadge) parts.push(tierBadge);
    console.log("  " + parts.join("  "));

    // Indented failure detail. We don't show passing assertions in
    // human mode (use --json for the full picture).
    for (const a of r.result.results) {
      if (a.ok) continue;
      const origin = chalk.dim(`(${a.assertion.origin})`);
      const target = chalk.cyan(a.assertion.target);
      const reason = chalk.red(a.reason);
      const patternHint = a.assertion.pattern ? chalk.dim(` "${a.assertion.pattern}"`) : "";
      console.log(`      \u2514\u2500 ${target}${patternHint} ${origin} \u2014 ${reason}`);
    }
  }

  // Summary footer.
  console.log();
  const summary: string[] = [];
  summary.push(chalk.dim(`${totals.pages} pages`));
  summary.push(chalk.green(`${totals.passed} passed`));
  if (totals.failed > 0) {
    summary.push(chalk.red(`${totals.failed} failed`));
  } else {
    summary.push(chalk.dim("0 failed"));
  }
  console.log("  " + summary.join(chalk.dim(" · ")));

  if (opts.dryRun) {
    console.log();
    console.log(chalk.dim("  --dry-run: nothing was written to disk."));
  } else if (totals.failed === 0 && totals.passed > 0) {
    console.log();
    console.log(
      chalk.dim(
        "  Pages with all assertions passing have been promoted to the `verified` tier."
      )
    );
  }
  console.log();
}

function formatTier(tier: string): string {
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
