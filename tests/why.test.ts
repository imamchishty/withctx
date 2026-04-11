import { describe, it, expect } from "vitest";
import { findEvidence } from "../src/wiki/why.js";
import type { WikiPage } from "../src/types/page.js";

function makePage(overrides: Partial<WikiPage> & { path: string; content: string }): WikiPage {
  return {
    path: overrides.path,
    title: overrides.title ?? overrides.path.replace(/\.md$/, ""),
    content: overrides.content,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
    sources: overrides.sources ?? [],
    references: overrides.references ?? [],
    meta: overrides.meta ?? {},
  };
}

// ── Literal matching ─────────────────────────────────────────────────

describe("findEvidence: literal match", () => {
  it("finds a claim that appears verbatim on a page", () => {
    const pages: WikiPage[] = [
      makePage({
        path: "architecture.md",
        content: "# Architecture\n\nWe use PostgreSQL as the primary database.\n",
      }),
      makePage({
        path: "deployment.md",
        content: "# Deployment\n\nKubernetes on GKE.\n",
      }),
    ];
    const hits = findEvidence("we use PostgreSQL", pages);
    expect(hits).toHaveLength(1);
    expect(hits[0].page).toBe("architecture.md");
    expect(hits[0].matchKind).toBe("literal");
    expect(hits[0].score).toBe(1.0);
    expect(hits[0].excerpt).toContain("PostgreSQL");
  });

  it("returns the correct line range for a single-line match", () => {
    const pages: WikiPage[] = [
      makePage({
        path: "page.md",
        content: "# Title\n\nLine two.\nLine three mentions PostgreSQL.\nLine four.\n",
      }),
    ];
    const hits = findEvidence("postgresql", pages);
    expect(hits).toHaveLength(1);
    expect(hits[0].lineStart).toBe(3); // 0-indexed — the 4th line
    expect(hits[0].lineEnd).toBe(3);
    expect(hits[0].excerpt).toContain("Line three mentions PostgreSQL");
  });

  it("is case-insensitive by default", () => {
    const pages: WikiPage[] = [
      makePage({ path: "p.md", content: "The API uses JWT tokens.\n" }),
    ];
    const hits = findEvidence("jwt tokens", pages);
    expect(hits).toHaveLength(1);
  });

  it("respects caseSensitive=true for literal matching", () => {
    const pages: WikiPage[] = [
      makePage({ path: "p.md", content: "The API uses JWT tokens.\n" }),
    ];
    const hitsInsensitive = findEvidence("jwt tokens", pages);
    // With caseSensitive=true and a strict minScore, the literal
    // substring "jwt tokens" isn't on the page ("JWT tokens" is),
    // and word-overlap alone can't clear a high threshold — so
    // sensitive mode rejects this claim.
    const hitsSensitive = findEvidence("jwt tokens", pages, {
      caseSensitive: true,
      minScore: 0.9,
    });
    expect(hitsInsensitive).toHaveLength(1);
    expect(hitsInsensitive[0].matchKind).toBe("literal");
    expect(hitsSensitive).toHaveLength(0);
  });

  it("skips auto-generated catalogue pages (index.md, log.md, glossary.md)", () => {
    const pages: WikiPage[] = [
      makePage({
        path: "index.md",
        content: "# Index\n\nSee architecture.md for PostgreSQL details.\n",
      }),
      makePage({
        path: "log.md",
        content: "PostgreSQL added in 2025.\n",
      }),
      makePage({
        path: "architecture.md",
        content: "# Architecture\n\nWe use PostgreSQL.\n",
      }),
    ];
    const hits = findEvidence("PostgreSQL", pages);
    expect(hits).toHaveLength(1);
    expect(hits[0].page).toBe("architecture.md");
  });
});

// ── Fuzzy word-overlap matching ──────────────────────────────────────

describe("findEvidence: fuzzy match", () => {
  it("falls back to word-overlap when a literal match is absent", () => {
    const pages: WikiPage[] = [
      makePage({
        path: "db.md",
        content: "# Database\n\nPostgreSQL is the primary store for user accounts.\n",
      }),
    ];
    // Claim uses "users" + "stored" + "PostgreSQL" — not a literal
    // substring of the page body, but a fuzzy overlap.
    const hits = findEvidence("users stored PostgreSQL", pages);
    expect(hits).toHaveLength(1);
    expect(hits[0].matchKind).toBe("fuzzy");
    expect(hits[0].score).toBeGreaterThan(0.5);
  });

  it("respects minScore: below-threshold fuzzy hits are dropped", () => {
    const pages: WikiPage[] = [
      makePage({
        path: "p.md",
        content: "Totally unrelated content about kubernetes and deployments.\n",
      }),
    ];
    const hits = findEvidence("users stored PostgreSQL", pages, { minScore: 0.5 });
    expect(hits).toHaveLength(0);
  });

  it("ignores stopwords when computing overlap", () => {
    const pages: WikiPage[] = [
      makePage({
        path: "a.md",
        content: "# A\n\nPostgreSQL.\n",
      }),
      makePage({
        path: "b.md",
        content: "# B\n\nThis is a page that says nothing of interest.\n",
      }),
    ];
    // The claim is mostly stopwords — only "PostgreSQL" should matter.
    const hits = findEvidence("we are using the PostgreSQL", pages);
    expect(hits).toHaveLength(1);
    expect(hits[0].page).toBe("a.md");
  });
});

// ── Ranking and limits ───────────────────────────────────────────────

describe("findEvidence: ranking", () => {
  it("ranks literal matches above fuzzy matches regardless of order", () => {
    const pages: WikiPage[] = [
      makePage({
        path: "fuzzy.md",
        content: "Kubernetes runs many services including ones that use PostgreSQL.\n",
      }),
      makePage({
        path: "literal.md",
        content: "We use PostgreSQL.\n",
      }),
    ];
    const hits = findEvidence("we use PostgreSQL", pages);
    // Both pages match; literal should come first.
    expect(hits[0].page).toBe("literal.md");
    expect(hits[0].matchKind).toBe("literal");
  });

  it("caps results at the supplied limit", () => {
    const pages: WikiPage[] = Array.from({ length: 10 }, (_, i) =>
      makePage({
        path: `p${i}.md`,
        content: `# Page ${i}\n\nThis page mentions PostgreSQL.\n`,
      })
    );
    const hits = findEvidence("PostgreSQL", pages, { limit: 3 });
    expect(hits).toHaveLength(3);
  });
});

// ── Provenance passthrough ───────────────────────────────────────────

describe("findEvidence: provenance and bless pass-through", () => {
  it("includes meta fields in each hit", () => {
    const pages: WikiPage[] = [
      makePage({
        path: "arch.md",
        content: "We use PostgreSQL.\n",
        meta: {
          refreshed_at: "2026-04-01T09:00:00.000Z",
          refreshed_by: "ci:withctx",
          commit: "abc1234",
          tier: "verified",
        },
      }),
    ];
    const hits = findEvidence("PostgreSQL", pages);
    expect(hits[0].meta.refreshed_at).toBe("2026-04-01T09:00:00.000Z");
    expect(hits[0].meta.refreshed_by).toBe("ci:withctx");
    expect(hits[0].meta.tier).toBe("verified");
  });

  it("reports unblessed state when no bless fields are present", () => {
    const pages: WikiPage[] = [
      makePage({ path: "p.md", content: "PostgreSQL.\n", meta: {} }),
    ];
    const hits = findEvidence("PostgreSQL", pages);
    expect(hits[0].bless.status).toBe("unblessed");
  });

  it("reports blessed state when meta carries a bless stamp", () => {
    const pages: WikiPage[] = [
      makePage({
        path: "p.md",
        content: "PostgreSQL.\n",
        meta: {
          blessed_by: "r@acme.com",
          blessed_at: "2026-04-10T12:00:00.000Z",
          blessed_at_sha: "a1b2c3d",
        },
      }),
    ];
    const hits = findEvidence("PostgreSQL", pages);
    expect(hits[0].bless.status).toBe("blessed");
    if (hits[0].bless.status === "blessed") {
      expect(hits[0].bless.stamp.blessed_by).toBe("r@acme.com");
      expect(hits[0].bless.stamp.blessed_at_sha).toBe("a1b2c3d");
    }
  });

  it("pipes through the sources array from the page", () => {
    const pages: WikiPage[] = [
      makePage({
        path: "p.md",
        content: "We use PostgreSQL.\n",
        sources: ["adr/001-database-choice.md", "confluence:Engineering/ADRs/DB"],
      }),
    ];
    const hits = findEvidence("PostgreSQL", pages);
    expect(hits[0].sources).toEqual([
      "adr/001-database-choice.md",
      "confluence:Engineering/ADRs/DB",
    ]);
  });
});

// ── Empty / edge cases ───────────────────────────────────────────────

describe("findEvidence: edge cases", () => {
  it("returns an empty array when no pages are supplied", () => {
    expect(findEvidence("anything", [])).toEqual([]);
  });

  it("returns an empty array when the claim is only stopwords", () => {
    const pages: WikiPage[] = [
      makePage({ path: "p.md", content: "Unrelated content.\n" }),
    ];
    const hits = findEvidence("the is of and", pages);
    expect(hits).toHaveLength(0);
  });

  it("handles multiline literal matches gracefully", () => {
    const pages: WikiPage[] = [
      makePage({
        path: "p.md",
        content: "# Page\n\nline one.\nline two.\nline three.\n",
      }),
    ];
    const hits = findEvidence("line two", pages);
    expect(hits).toHaveLength(1);
    expect(hits[0].excerpt).toContain("line two");
  });
});
