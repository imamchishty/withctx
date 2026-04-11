import { describe, it, expect } from "vitest";
import { findAffectedPages, classifyDrift } from "../src/wiki/drift.js";
import type { WikiPage } from "../src/types/page.js";

function makePage(
  path: string,
  content: string,
  meta: WikiPage["meta"] = {}
): WikiPage {
  return {
    path,
    title: path.replace(/\.md$/, ""),
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    sources: [],
    references: [],
    meta,
  };
}

// ── findAffectedPages ────────────────────────────────────────────────

describe("findAffectedPages: literal path match", () => {
  it("flags a page that backticks the exact changed file", () => {
    const pages = [
      makePage(
        "auth.md",
        "# Auth\n\nThe session code lives in `src/auth/session.ts`.\n"
      ),
      makePage("unrelated.md", "# Unrelated\n\nNothing to see here.\n"),
    ];
    const affected = findAffectedPages(["src/auth/session.ts"], pages);
    expect(affected).toHaveLength(1);
    expect(affected[0].page.path).toBe("auth.md");
    expect(affected[0].reasons[0].kind).toBe("literal");
    expect(affected[0].reasons[0].line).toBe(2);
  });

  it("flags literal mentions in bare prose too", () => {
    const pages = [
      makePage("arch.md", "# Architecture\n\nWe store auth in src/auth/session.ts as a middleware.\n"),
    ];
    const affected = findAffectedPages(["src/auth/session.ts"], pages);
    expect(affected).toHaveLength(1);
    expect(affected[0].reasons[0].kind).toBe("literal");
  });
});

describe("findAffectedPages: directory match", () => {
  it("flags a page that backticks an ancestor directory", () => {
    const pages = [
      makePage("auth.md", "# Auth\n\nAll auth code lives under `src/auth/`.\n"),
    ];
    const affected = findAffectedPages(["src/auth/session.ts"], pages);
    expect(affected).toHaveLength(1);
    expect(affected[0].reasons[0].kind).toBe("directory");
  });

  it("does not confuse 'src/' (top-level) with a directory match", () => {
    const pages = [
      makePage("toplevel.md", "Everything is under `src/`.\n"),
    ];
    // `src` is an ancestor of `src/auth/session.ts` so it IS a match.
    const affected = findAffectedPages(["src/auth/session.ts"], pages);
    expect(affected).toHaveLength(1);
    expect(affected[0].reasons[0].kind).toBe("directory");
  });
});

describe("findAffectedPages: basename match", () => {
  it("flags a page that mentions a basename only", () => {
    const pages = [
      makePage("routes.md", "# Routes\n\nHandlers in `session.ts` wire up the middleware.\n"),
    ];
    const affected = findAffectedPages(["src/auth/session.ts"], pages);
    expect(affected).toHaveLength(1);
    expect(affected[0].reasons[0].kind).toBe("basename");
  });

  it("basename match only fires inside code spans, never prose", () => {
    const pages = [
      makePage("routes.md", "# Routes\n\nThe session.ts file does stuff.\n"),
    ];
    // Plain prose "session.ts" is deliberately ignored — too noisy.
    const affected = findAffectedPages(["src/auth/session.ts"], pages);
    expect(affected).toHaveLength(0);
  });
});

describe("findAffectedPages: skipping catalogues", () => {
  it("skips index.md, log.md, glossary.md by default", () => {
    const pages = [
      makePage("index.md", "See `src/auth/session.ts`.\n"),
      makePage("log.md", "`src/auth/session.ts` changed today.\n"),
      makePage("glossary.md", "`src/auth/session.ts` is session code.\n"),
      makePage("real.md", "Real mention of `src/auth/session.ts`.\n"),
    ];
    const affected = findAffectedPages(["src/auth/session.ts"], pages);
    expect(affected).toHaveLength(1);
    expect(affected[0].page.path).toBe("real.md");
  });

  it("includes catalogues when skipCatalogues=false", () => {
    const pages = [
      makePage("index.md", "See `src/auth/session.ts`.\n"),
    ];
    const affected = findAffectedPages(["src/auth/session.ts"], pages, {
      skipCatalogues: false,
    });
    expect(affected).toHaveLength(1);
  });
});

describe("findAffectedPages: sorting and limits", () => {
  it("sorts literal matches above directory and basename matches", () => {
    const pages = [
      makePage("basename.md", "Code in `session.ts` does things.\n"),
      makePage("directory.md", "All auth under `src/auth/`.\n"),
      makePage("literal.md", "The file `src/auth/session.ts` holds it.\n"),
    ];
    const affected = findAffectedPages(["src/auth/session.ts"], pages);
    expect(affected.map((a) => a.page.path)).toEqual([
      "literal.md",
      "directory.md",
      "basename.md",
    ]);
  });

  it("caps reasons per page at maxReasonsPerPage", () => {
    const body = Array.from({ length: 20 }, (_, i) => `Line ${i}: see \`src/auth/session.ts\`.`).join("\n");
    const pages = [makePage("p.md", body)];
    const affected = findAffectedPages(["src/auth/session.ts"], pages, {
      maxReasonsPerPage: 3,
    });
    expect(affected[0].reasons).toHaveLength(3);
  });
});

describe("findAffectedPages: edge cases", () => {
  it("returns empty when changed files is empty", () => {
    const pages = [makePage("p.md", "Anything.\n")];
    expect(findAffectedPages([], pages)).toEqual([]);
  });

  it("returns empty when pages is empty", () => {
    expect(findAffectedPages(["foo.ts"], [])).toEqual([]);
  });

  it("normalises ./ prefixes on both sides", () => {
    const pages = [makePage("p.md", "Code at `./src/x.ts`.\n")];
    const affected = findAffectedPages(["./src/x.ts"], pages);
    expect(affected).toHaveLength(1);
  });
});

// ── classifyDrift ────────────────────────────────────────────────────

describe("classifyDrift", () => {
  it("returns 'drifted' when the page is blessed", () => {
    const page = makePage("p.md", "x", {
      blessed_by: "r@acme.com",
      blessed_at: "2026-04-01T00:00:00Z",
    });
    expect(classifyDrift(page, { status: "blessed", stamp: { blessed_by: "r", blessed_at: "x" } })).toBe("drifted");
  });

  it("returns 'stale' when the page has refreshed_at but no bless", () => {
    const page = makePage("p.md", "x", {
      refreshed_at: "2026-03-01T00:00:00Z",
    });
    expect(classifyDrift(page, { status: "unblessed" })).toBe("stale");
  });

  it("returns 'unblessed' when the page has neither bless nor refresh", () => {
    const page = makePage("p.md", "x", {});
    expect(classifyDrift(page, { status: "unblessed" })).toBe("unblessed");
  });
});

// ── classification pass-through in findAffectedPages ─────────────────

describe("findAffectedPages: classification passthrough", () => {
  it("classifies a blessed page as drifted", () => {
    const pages = [
      makePage("auth.md", "`src/auth/session.ts`", {
        blessed_by: "r@acme.com",
        blessed_at: "2026-04-01T00:00:00Z",
      }),
    ];
    const affected = findAffectedPages(["src/auth/session.ts"], pages);
    expect(affected[0].classification).toBe("drifted");
    expect(affected[0].bless.status).toBe("blessed");
  });

  it("classifies a refreshed unblessed page as stale", () => {
    const pages = [
      makePage("auth.md", "`src/auth/session.ts`", {
        refreshed_at: "2026-03-15T00:00:00Z",
      }),
    ];
    const affected = findAffectedPages(["src/auth/session.ts"], pages);
    expect(affected[0].classification).toBe("stale");
  });

  it("classifies a plain manual note as unblessed", () => {
    const pages = [makePage("notes.md", "`src/auth/session.ts`", {})];
    const affected = findAffectedPages(["src/auth/session.ts"], pages);
    expect(affected[0].classification).toBe("unblessed");
  });
});
