/**
 * Question generation + grading for `ctx teach`.
 *
 * `ctx teach` turns a wiki page into an interactive quiz so a new
 * engineer can self-drill on the project's knowledge. The core loop is:
 *
 *     pick N questions from the wiki → ask the user → grade answers
 *                                                         │
 *                                                         ▼
 *                                           feedback loop + score summary
 *
 * This module is the PURE half — no readline, no terminal I/O, no
 * persistence. The CLI layer wraps these functions in a prompt/answer
 * loop. Keeping generation and grading pure means:
 *
 *   1. We can unit-test question generation with zero mocking.
 *   2. The MCP server can reach for the same code to serve quizzes
 *      to AI-driven onboarding flows in the future.
 *   3. An IDE plugin can call generateQuestions() without reimplementing
 *      the heuristics.
 *
 * Generation strategies, cheapest first:
 *
 *   1. Cloze (fill-in-the-blank). Take a sentence that mentions a
 *      distinctive token (PROPER NOUN, backticked identifier, CamelCase
 *      symbol) and blank it out. Highest signal, zero LLM cost.
 *   2. Heading-body. For every `## Heading` on the page, ask "What does
 *      the section 'Heading' cover?" and expect the first sentence of
 *      the body. Good for structural recall.
 *   3. Code-span lookup. For `src/foo.ts` appearing in prose, ask
 *      "What is `src/foo.ts`?" with the surrounding sentence as the
 *      expected answer.
 *
 * All three strategies emit the same `Question` shape, so the CLI can
 * mix them freely. The only distinction between a "cloze" question and
 * a "heading" question downstream is cosmetic rendering.
 *
 * Grading is deliberately lenient. A learner who types "postgres"
 * when the answer is "PostgreSQL" should get credit — the goal is
 * retention, not spelling. We normalise case, strip punctuation, and
 * match on content-word overlap with a 0.6 threshold.
 */

import type { WikiPage } from "../types/page.js";

// ── Types ─────────────────────────────────────────────────────────────

export type QuestionKind = "cloze" | "heading" | "code-span";

export interface Question {
  kind: QuestionKind;
  /** Source page path — used by the renderer for "from architecture.md". */
  page: string;
  /** The prompt the learner sees. */
  prompt: string;
  /** The expected answer (for grading, not for display). */
  expected: string;
  /**
   * Short context snippet to show AFTER the learner answers — this
   * is the "here's where this comes from" moment that turns a quiz
   * into a learning loop rather than a trivia game.
   */
  context: string;
  /**
   * Difficulty heuristic, 1 (easiest) to 3 (hardest). Cloze on a
   * proper noun = 1; heading recall = 2; code-span lookup = 3.
   */
  difficulty: 1 | 2 | 3;
}

export interface GenerateOptions {
  /** Max questions per page. Default 10. */
  maxPerPage?: number;
  /** Which strategies to run. Default: all three. */
  strategies?: QuestionKind[];
  /** Minimum question prompt length — filters out trivially short ones. */
  minPromptLength?: number;
}

export interface GradeResult {
  correct: boolean;
  score: number; // 0..1
  feedback: string;
}

// ── Generation ────────────────────────────────────────────────────────

/**
 * Produce a deterministic set of questions from a single wiki page.
 * The returned list is ordered by difficulty ascending so a caller that
 * takes the first N gets an easy-to-hard progression for free.
 */
export function generateQuestionsForPage(
  page: WikiPage,
  options: GenerateOptions = {}
): Question[] {
  const maxPerPage = options.maxPerPage ?? 10;
  const strategies = new Set(options.strategies ?? ["cloze", "heading", "code-span"]);
  const minLen = options.minPromptLength ?? 20;

  const questions: Question[] = [];

  if (strategies.has("heading")) {
    questions.push(...extractHeadingQuestions(page));
  }
  if (strategies.has("cloze")) {
    questions.push(...extractClozeQuestions(page));
  }
  if (strategies.has("code-span")) {
    questions.push(...extractCodeSpanQuestions(page));
  }

  // Filter out short / broken prompts.
  const cleaned = questions.filter((q) => q.prompt.length >= minLen);

  // De-dupe with a per-kind natural key. Cloze and heading questions
  // are uniquely identified by their EXPECTED answer (so we don't ask
  // "what's PostgreSQL" twice when it appears in five sentences).
  // Code-span questions use PROMPT because two different tokens on
  // the same line share `expected` (the whole line) but have unique
  // prompts.
  const seen = new Set<string>();
  const deduped: Question[] = [];
  for (const q of cleaned) {
    const key =
      q.kind === "code-span"
        ? `${q.kind}|${q.prompt.toLowerCase()}`
        : `${q.kind}|${q.expected.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(q);
  }

  // Sort: easiest first (cloze → heading → code-span).
  deduped.sort((a, b) => a.difficulty - b.difficulty);

  return deduped.slice(0, maxPerPage);
}

/**
 * Aggregate questions across a whole wiki. Used by `ctx teach` when
 * the user doesn't scope to a specific page.
 */
export function generateQuestionsFromWiki(
  pages: WikiPage[],
  options: GenerateOptions = {}
): Question[] {
  const perPageCap = options.maxPerPage ?? 5;
  const totalCap = (options.maxPerPage ?? 5) * Math.max(1, pages.length);

  const all: Question[] = [];
  for (const page of pages) {
    const base = page.path.split("/").pop() ?? page.path;
    if (base === "index.md" || base === "log.md" || base === "glossary.md") continue;
    all.push(
      ...generateQuestionsForPage(page, { ...options, maxPerPage: perPageCap })
    );
  }
  // Round-robin shuffle? No — keep it deterministic so users can re-run
  // with a seed in their head. Sort by (difficulty asc, page asc).
  all.sort((a, b) => {
    if (a.difficulty !== b.difficulty) return a.difficulty - b.difficulty;
    return a.page.localeCompare(b.page);
  });
  return all.slice(0, totalCap);
}

// ── Strategies ────────────────────────────────────────────────────────

// Sentence splitter: look for punctuation followed by whitespace AND a
// capital letter or opening quote. The lookahead guards against
// splitting `src/routes.ts` into `src/routes.` + `ts` — the character
// after the period in "routes.ts" is a lowercase `t`, which doesn't
// match the `[A-Z"]` guard.
const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z"'(])/;
// Global form of the proper-noun regex — we need all matches so we
// can skip sentence-starter words like "The" and try the next token.
const PROPER_NOUN_RE_G = /\b([A-Z][A-Za-z0-9_]{2,}(?:[A-Z][A-Za-z0-9_]*)*)\b/g;
const CODE_SPAN_RE = /`([^`\n]{2,})`/;

function extractClozeQuestions(page: WikiPage): Question[] {
  const body = page.content;
  const out: Question[] = [];

  // Split into paragraphs first so we don't cross a fenced block.
  let inFence = false;
  const safeLines: string[] = [];
  for (const line of body.split("\n")) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Skip list markers / headings — they don't cloze well.
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^\s*[-*+]\s/.test(line)) continue;
    safeLines.push(line);
  }
  const safeBody = safeLines.join("\n");

  const sentences = safeBody
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && s.length < 220);

  for (const sentence of sentences) {
    // Prefer a backticked token for the blank — it's the best signal
    // that something is a "term" the learner should recall.
    const codeMatch = sentence.match(CODE_SPAN_RE);
    if (codeMatch) {
      const answer = codeMatch[1];
      if (answer.length < 2) continue;
      const prompt = sentence.replace(codeMatch[0], "`____`");
      out.push({
        kind: "cloze",
        page: page.path,
        prompt,
        expected: answer,
        context: sentence,
        difficulty: 1,
      });
      continue;
    }

    // Otherwise fall back to the first proper noun / CamelCase token
    // that isn't a sentence-starter. We intentionally try EVERY match
    // rather than just the first one so sentences that begin with
    // "The ..." don't get thrown away when the real term (e.g.
    // "PostgreSQL") is further into the line.
    let picked: string | null = null;
    for (const m of sentence.matchAll(PROPER_NOUN_RE_G)) {
      const candidate = m[1];
      if (SENTENCE_START_WORDS.has(candidate)) continue;
      picked = candidate;
      break;
    }
    if (picked) {
      const prompt = sentence.replace(new RegExp(`\\b${picked}\\b`), "____");
      out.push({
        kind: "cloze",
        page: page.path,
        prompt,
        expected: picked,
        context: sentence,
        difficulty: 1,
      });
    }
  }

  return out;
}

const SENTENCE_START_WORDS = new Set([
  "The", "A", "An", "This", "That", "These", "Those", "We", "Our", "It", "Its",
  "You", "Your", "I", "My", "He", "She", "They", "Their", "His", "Her",
  "If", "When", "Where", "Why", "How", "What", "Who", "Which", "Once",
]);

function extractHeadingQuestions(page: WikiPage): Question[] {
  const lines = page.content.split("\n");
  const out: Question[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!m) continue;
    const heading = m[1].trim();
    if (!heading || heading.length > 80) continue;

    // Find the first non-empty body sentence below this heading.
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length) continue;
    // Stop if we immediately hit another heading (empty section).
    if (/^#{1,6}\s/.test(lines[j])) continue;

    const bodyLines: string[] = [];
    while (
      j < lines.length &&
      !/^##?\s/.test(lines[j]) &&
      bodyLines.length < 5
    ) {
      if (lines[j].trim()) bodyLines.push(lines[j].trim());
      j++;
    }

    const firstSentence = bodyLines.join(" ").split(SENTENCE_SPLIT)[0];
    if (!firstSentence || firstSentence.length < 15) continue;

    out.push({
      kind: "heading",
      page: page.path,
      prompt: `What does the "${heading}" section of ${displayTitle(page)} cover?`,
      expected: firstSentence,
      context: `## ${heading}\n${bodyLines.join("\n")}`,
      difficulty: 2,
    });
  }

  return out;
}

function extractCodeSpanQuestions(page: WikiPage): Question[] {
  const out: Question[] = [];
  const seen = new Set<string>();

  // Iterate line-by-line rather than sentence-by-sentence — the naive
  // sentence splitter fragments `src/routes.ts` (period inside the
  // token) into two halves. Lines are stable for this purpose and
  // the surrounding line is good enough context for a recall prompt.
  let inFence = false;
  for (const line of page.content.split("\n")) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Any backticked identifier that LOOKS like a path or symbol
    // counts as quizzable.
    for (const m of line.matchAll(/`([A-Za-z0-9_\-./]{3,})`/g)) {
      const token = m[1];
      if (seen.has(token)) continue;
      seen.add(token);
      if (token.length < 3) continue;
      // Filter noise: pure numbers, common CLI fragments.
      if (/^\d+$/.test(token)) continue;
      if (token.startsWith("--")) continue;

      out.push({
        kind: "code-span",
        page: page.path,
        prompt: `What is \`${token}\` in ${displayTitle(page)}?`,
        expected: line.trim(),
        context: line.trim(),
        difficulty: 3,
      });
    }
  }

  return out;
}

function displayTitle(page: WikiPage): string {
  return page.title || page.path.replace(/\.md$/, "");
}

// ── Grading ───────────────────────────────────────────────────────────

/**
 * Grade a learner's answer against the expected answer. Lenient: we
 * normalise case + punctuation, then match on content-word overlap
 * so "postgres" passes when the answer is "PostgreSQL".
 *
 * Threshold policy:
 *   - exact normalised match  → score 1.0, "correct"
 *   - ≥ 0.6 word overlap      → score == overlap, "correct"
 *   - >= 0.3 and < 0.6        → score == overlap, "partial"
 *   - otherwise               → score == overlap, "incorrect"
 */
export function gradeAnswer(userAnswer: string, question: Question): GradeResult {
  const user = normalise(userAnswer);
  const expected = normalise(question.expected);

  if (!user) {
    return { correct: false, score: 0, feedback: "No answer given." };
  }

  if (user === expected) {
    return { correct: true, score: 1, feedback: "Exact match — perfect." };
  }

  // Substring match — covers cases where the expected answer is a
  // full sentence and the user typed a shorter correct answer.
  if (expected.includes(user) && user.length > 3) {
    return { correct: true, score: 0.9, feedback: "Your answer is contained in the expected answer." };
  }
  if (user.includes(expected) && expected.length > 3) {
    return { correct: true, score: 0.9, feedback: "Your answer covers the expected answer." };
  }

  // Word overlap fallback.
  const userWords = new Set(user.split(/\s+/).filter((w) => w.length > 1));
  const expectedWords = new Set(expected.split(/\s+/).filter((w) => w.length > 1));
  if (expectedWords.size === 0) {
    return { correct: false, score: 0, feedback: "Expected answer had no content words." };
  }
  let overlap = 0;
  for (const w of expectedWords) if (userWords.has(w)) overlap++;
  const score = overlap / expectedWords.size;

  if (score >= 0.6) {
    return { correct: true, score, feedback: "Close enough — you got the core." };
  }
  if (score >= 0.3) {
    return {
      correct: false,
      score,
      feedback: "Partial credit — you hit some of the right words but missed the main term.",
    };
  }
  return { correct: false, score, feedback: "Not quite — take another look at the context." };
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
