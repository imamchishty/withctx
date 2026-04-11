import { describe, it, expect } from "vitest";
import {
  generateQuestionsForPage,
  generateQuestionsFromWiki,
  gradeAnswer,
  type Question,
} from "../src/wiki/teach.js";
import type { WikiPage } from "../src/types/page.js";

function makePage(path: string, content: string): WikiPage {
  return {
    path,
    title: path.replace(/\.md$/, ""),
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    sources: [],
    references: [],
    meta: {},
  };
}

// ── Question generation: cloze ───────────────────────────────────────

describe("generateQuestionsForPage: cloze", () => {
  it("blanks out a backticked term in a sentence", () => {
    const page = makePage(
      "arch.md",
      "The session middleware lives in `src/auth/session.ts` and handles every request.\n"
    );
    const qs = generateQuestionsForPage(page, { strategies: ["cloze"] });
    const cloze = qs.find((q) => q.kind === "cloze");
    expect(cloze).toBeDefined();
    expect(cloze!.expected).toBe("src/auth/session.ts");
    expect(cloze!.prompt).toContain("`____`");
  });

  it("blanks out a proper-noun token when no backtick is available", () => {
    const page = makePage(
      "arch.md",
      "Our primary database is PostgreSQL running on a managed instance.\n"
    );
    const qs = generateQuestionsForPage(page, { strategies: ["cloze"] });
    const cloze = qs.find((q) => q.kind === "cloze");
    expect(cloze).toBeDefined();
    expect(cloze!.expected).toBe("PostgreSQL");
    expect(cloze!.prompt).toContain("____");
  });

  it("skips sentence-starter words like 'The' even if they look proper", () => {
    const page = makePage("a.md", "The system uses a cache layer for speed.\n");
    const qs = generateQuestionsForPage(page, { strategies: ["cloze"] });
    expect(qs.filter((q) => q.expected === "The")).toHaveLength(0);
  });

  it("does not pull tokens from inside fenced code blocks", () => {
    const page = makePage(
      "a.md",
      [
        "The real architecture uses PostgreSQL as storage.",
        "",
        "```ts",
        "const db = new MongoDB();",
        "```",
        "",
      ].join("\n")
    );
    const qs = generateQuestionsForPage(page, { strategies: ["cloze"] });
    expect(qs.every((q) => q.expected !== "MongoDB")).toBe(true);
  });
});

// ── Question generation: heading ─────────────────────────────────────

describe("generateQuestionsForPage: heading", () => {
  it("turns a ## heading + body into a recall question", () => {
    const page = makePage(
      "arch.md",
      [
        "# Architecture",
        "",
        "## Session Management",
        "",
        "Sessions are stored in Redis with a 30-minute TTL. Tokens use JWT.",
        "",
        "## Other",
        "",
        "Something else.",
      ].join("\n")
    );
    const qs = generateQuestionsForPage(page, { strategies: ["heading"] });
    const heading = qs.find((q) => q.kind === "heading");
    expect(heading).toBeDefined();
    expect(heading!.prompt).toContain("Session Management");
    expect(heading!.expected).toContain("Sessions are stored in Redis");
  });

  it("skips empty sections", () => {
    const page = makePage(
      "a.md",
      [
        "## Empty",
        "",
        "## Full",
        "",
        "Has real content here that is long enough to count.",
      ].join("\n")
    );
    const qs = generateQuestionsForPage(page, { strategies: ["heading"] });
    // The "Empty" heading immediately followed by another heading
    // should not generate a question.
    expect(qs.map((q) => q.prompt).filter((p) => p.includes("Empty"))).toHaveLength(0);
  });
});

// ── Question generation: code-span ───────────────────────────────────

describe("generateQuestionsForPage: code-span", () => {
  it("produces lookup questions for each distinct code span", () => {
    const page = makePage(
      "arch.md",
      "Routes live in `src/routes.ts` and the config is in `config/app.yaml`.\n"
    );
    const qs = generateQuestionsForPage(page, { strategies: ["code-span"] });
    const spans = qs.filter((q) => q.kind === "code-span");
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans.some((q) => q.prompt.includes("src/routes.ts"))).toBe(true);
    expect(spans.some((q) => q.prompt.includes("config/app.yaml"))).toBe(true);
  });

  it("filters out CLI-flag-shaped tokens", () => {
    const page = makePage("a.md", "Pass `--help` to see options.\n");
    const qs = generateQuestionsForPage(page, { strategies: ["code-span"] });
    expect(qs).toHaveLength(0);
  });
});

// ── Ordering and limits ──────────────────────────────────────────────

describe("generateQuestionsForPage: ordering", () => {
  it("returns easier questions first (cloze before heading before code-span)", () => {
    const page = makePage(
      "arch.md",
      [
        "The backbone is PostgreSQL for persistent storage in this system.",
        "",
        "## Overview",
        "",
        "An end-to-end pipeline that processes every user request with care.",
        "",
        "Endpoints live in `src/routes.ts` for all API surfaces.",
      ].join("\n")
    );
    const qs = generateQuestionsForPage(page);
    // At least one of each.
    const kinds = qs.map((q) => q.kind);
    expect(kinds).toContain("cloze");
    expect(kinds).toContain("heading");
    expect(kinds).toContain("code-span");
    // First should be difficulty 1.
    expect(qs[0].difficulty).toBe(1);
  });

  it("respects maxPerPage", () => {
    const page = makePage(
      "a.md",
      "Sentence one mentions `foo.ts`.\nSentence two mentions `bar.ts`.\nSentence three mentions `baz.ts`.\n"
    );
    const qs = generateQuestionsForPage(page, { maxPerPage: 2 });
    expect(qs.length).toBeLessThanOrEqual(2);
  });

  it("de-dupes questions with the same expected answer", () => {
    const page = makePage(
      "a.md",
      "First mention of `src/x.ts` here.\nSecond mention of `src/x.ts` there.\n"
    );
    const qs = generateQuestionsForPage(page, { strategies: ["cloze"] });
    expect(qs).toHaveLength(1);
  });
});

// ── Wiki aggregation ─────────────────────────────────────────────────

describe("generateQuestionsFromWiki", () => {
  it("aggregates questions across pages", () => {
    const pages: WikiPage[] = [
      makePage("a.md", "The database is PostgreSQL for sure.\n"),
      makePage("b.md", "The runtime is Node.js for this project.\n"),
    ];
    const qs = generateQuestionsFromWiki(pages);
    expect(qs.some((q) => q.page === "a.md")).toBe(true);
    expect(qs.some((q) => q.page === "b.md")).toBe(true);
  });

  it("skips index.md, log.md, glossary.md", () => {
    const pages: WikiPage[] = [
      makePage("index.md", "The database is PostgreSQL.\n"),
      makePage("log.md", "The database is PostgreSQL.\n"),
      makePage("glossary.md", "The database is PostgreSQL.\n"),
      makePage("real.md", "The database is PostgreSQL for sure.\n"),
    ];
    const qs = generateQuestionsFromWiki(pages);
    expect(qs.every((q) => q.page === "real.md")).toBe(true);
  });
});

// ── Grading ──────────────────────────────────────────────────────────

describe("gradeAnswer", () => {
  const q: Question = {
    kind: "cloze",
    page: "a.md",
    prompt: "The database is ____.",
    expected: "PostgreSQL",
    context: "The database is PostgreSQL.",
    difficulty: 1,
  };

  it("accepts an exact match", () => {
    const r = gradeAnswer("PostgreSQL", q);
    expect(r.correct).toBe(true);
    expect(r.score).toBe(1);
  });

  it("is case-insensitive", () => {
    const r = gradeAnswer("postgresql", q);
    expect(r.correct).toBe(true);
  });

  it("strips punctuation", () => {
    const r = gradeAnswer("PostgreSQL!", q);
    expect(r.correct).toBe(true);
  });

  it("gives credit for a substring hit", () => {
    const q2: Question = {
      ...q,
      expected: "We use PostgreSQL as the primary database.",
    };
    const r = gradeAnswer("PostgreSQL", q2);
    expect(r.correct).toBe(true);
  });

  it("rejects an empty answer", () => {
    const r = gradeAnswer("", q);
    expect(r.correct).toBe(false);
    expect(r.score).toBe(0);
  });

  it("rejects a totally unrelated answer", () => {
    const r = gradeAnswer("MongoDB", q);
    expect(r.correct).toBe(false);
  });

  it("returns a partial-credit message for 30-60% overlap", () => {
    const q2: Question = {
      ...q,
      expected: "We use PostgreSQL for persistent data storage across the app",
    };
    const r = gradeAnswer("we use for storage", q2);
    // 3 of ~8 content words match
    expect(r.correct).toBe(false);
    expect(r.feedback).toContain("Partial");
  });
});
