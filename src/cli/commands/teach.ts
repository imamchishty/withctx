/**
 * `ctx teach [page]` — interactive self-drill on wiki content.
 *
 * Turns a wiki page (or the whole wiki) into a quiz. Pure deterministic
 * path — no LLM call, no network, no persistence. A new engineer can
 * sit at their terminal, answer questions, and learn the project the
 * same way flashcards work.
 *
 * Flow:
 *
 *   1. Load either a single page or all content pages
 *   2. Generate questions via the pure `teach.ts` module
 *   3. Shuffle (with a seed so re-runs are stable for screenshots)
 *   4. Ask questions via readline, collecting answers
 *   5. Grade each answer; show the expected + context on finish
 *   6. Print a score summary
 *
 * Intentionally NOT yet:
 *   - spaced repetition persistence (future: .ctx/teach/<user>.json)
 *   - LLM-generated questions (future: `ctx teach --llm`)
 *   - multi-user tracking
 *
 * The pure module does the heavy lifting — this file is 90% terminal
 * I/O glue.
 */

import { Command } from "commander";
import chalk from "chalk";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import {
  generateQuestionsForPage,
  generateQuestionsFromWiki,
  gradeAnswer,
  type Question,
} from "../../wiki/teach.js";
import type { WikiPage } from "../../types/page.js";
import {
  noCtxDirError,
  pageNotFoundError,
  invalidArgumentError,
} from "../../errors.js";

interface TeachOptions {
  /** Number of questions to ask. Default 5. */
  count?: string;
  /** Random seed — makes question order reproducible. */
  seed?: string;
  /** Skip grading; just show questions + answers. */
  reveal?: boolean;
}

export function registerTeachCommand(program: Command): void {
  program
    .command("teach [page]")
    .description(
      "Interactive quiz from wiki content — drill yourself on what the project knows"
    )
    .option("-n, --count <n>", "Number of questions to ask", "5")
    .option("--seed <n>", "Random seed for reproducible question order")
    .option("--reveal", "Show all questions + answers without grading")
    .action(async (pageArg: string | undefined, opts: TeachOptions) => {
      loadConfig();
      const projectRoot = getProjectRoot();
      const ctxDir = new CtxDirectory(projectRoot);
      if (!ctxDir.exists()) {
        throw noCtxDirError();
      }

      const pageManager = new PageManager(ctxDir);

      // ── Build the candidate question pool ───────────────────────
      let questions: Question[];
      if (pageArg) {
        const normalised = normalizePagePath(pageArg);
        const page = pageManager.read(normalised);
        if (!page) {
          throw pageNotFoundError(normalised);
        }
        questions = generateQuestionsForPage(page, { maxPerPage: 50 });
      } else {
        const allPaths = pageManager.list();
        const pages: WikiPage[] = [];
        for (const p of allPaths) {
          const page = pageManager.read(p);
          if (page) pages.push(page);
        }
        questions = generateQuestionsFromWiki(pages, { maxPerPage: 10 });
      }

      if (questions.length === 0) {
        console.log();
        console.log(chalk.yellow("  No quizzable content found on the selected page(s)."));
        console.log(
          chalk.dim(
            "  Try a richer page (architecture.md, decisions.md) or run `ctx ingest` first."
          )
        );
        console.log();
        return;
      }

      // ── Shuffle + take N ────────────────────────────────────────
      const count = Math.max(1, parseInt(opts.count ?? "5", 10) || 5);
      const seed = opts.seed ? Number(opts.seed) : undefined;
      const ordered = shuffle(questions, seed).slice(0, count);

      // ── Reveal mode (no interaction) ────────────────────────────
      if (opts.reveal) {
        renderRevealMode(ordered);
        return;
      }

      // ── Interactive loop ────────────────────────────────────────
      const rl = readline.createInterface({ input: stdin, output: stdout });

      console.log();
      console.log(chalk.bold.cyan(`ctx teach — ${ordered.length} questions`));
      console.log(
        chalk.dim(
          "Type your answer and hit Enter. Press Ctrl-C at any time to exit."
        )
      );
      console.log();

      let correctCount = 0;
      const results: Array<{ question: Question; answer: string; correct: boolean; score: number }> = [];

      for (let i = 0; i < ordered.length; i++) {
        const q = ordered[i];
        const number = chalk.bold(`${i + 1}/${ordered.length}`);
        const kindBadge = chalk.dim(`[${q.kind}]`);
        console.log(`${number}  ${kindBadge}  ${chalk.dim("from " + q.page)}`);
        console.log(`  ${q.prompt}`);
        let answer: string;
        try {
          answer = await rl.question(chalk.dim("  > "));
        } catch {
          // User pressed Ctrl-C mid-question.
          rl.close();
          console.log();
          console.log(chalk.dim("  (session cancelled)"));
          return;
        }

        const grade = gradeAnswer(answer, q);
        results.push({ question: q, answer, correct: grade.correct, score: grade.score });
        if (grade.correct) correctCount++;

        if (grade.correct) {
          console.log(`  ${chalk.green("\u2713 correct")} — ${chalk.dim(grade.feedback)}`);
        } else {
          console.log(`  ${chalk.red("\u2717 not quite")} — ${chalk.dim(grade.feedback)}`);
          console.log(`  ${chalk.dim("expected:")} ${chalk.cyan(q.expected)}`);
        }
        console.log(`  ${chalk.dim("context: ")} ${chalk.dim(q.context.split("\n")[0])}`);
        console.log();
      }

      rl.close();

      // ── Score summary ───────────────────────────────────────────
      const pct = Math.round((correctCount / ordered.length) * 100);
      const verdict =
        pct >= 90
          ? chalk.green("Excellent")
          : pct >= 70
            ? chalk.green("Solid")
            : pct >= 50
              ? chalk.yellow("Getting there")
              : chalk.red("Lots to learn");
      console.log(
        chalk.bold(`Score: ${correctCount}/${ordered.length} (${pct}%) — ${verdict}`)
      );

      // Suggest next pages for the topics the learner missed.
      const missedPages = Array.from(
        new Set(results.filter((r) => !r.correct).map((r) => r.question.page))
      );
      if (missedPages.length > 0) {
        console.log();
        console.log(chalk.dim("  Review these pages:"));
        for (const p of missedPages.slice(0, 3)) {
          console.log(`    - ${chalk.cyan(p)}`);
        }
      }
      console.log();
    });
}

// ── Helpers ──────────────────────────────────────────────────────────

function renderRevealMode(questions: Question[]): void {
  console.log();
  console.log(chalk.bold.cyan(`ctx teach --reveal — ${questions.length} questions`));
  console.log();
  questions.forEach((q, i) => {
    const number = chalk.bold(`${i + 1}.`);
    console.log(`${number} ${chalk.dim(`[${q.kind}] from ${q.page}`)}`);
    console.log(`   ${q.prompt}`);
    console.log(`   ${chalk.dim("→")} ${chalk.cyan(q.expected)}`);
    console.log();
  });
}

/**
 * Deterministic shuffle via a seeded LCG. Good enough for "make the
 * same quiz come out the same way for a given --seed"; we don't
 * need cryptographic randomness.
 */
function shuffle<T>(items: T[], seed?: number): T[] {
  const out = items.slice();
  let s = seed ?? Math.floor(Math.random() * 2 ** 31);
  // Park-Miller LCG — tiny, deterministic, bounded.
  const rand = (): number => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Same path-normalisation rules the other wiki-scoped commands use.
 * Duplicated rather than extracted because each command keeps its
 * normaliser colocated — the test failures are easier to localise.
 */
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
