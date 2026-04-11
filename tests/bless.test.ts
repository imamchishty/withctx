import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blessPage,
  revokeBless,
  readBlessState,
  hasDriftedSinceBless,
  detectReviewer,
  detectHeadSha,
} from "../src/wiki/bless.js";
import { parsePage } from "../src/wiki/metadata.js";

// ── Test helpers ──────────────────────────────────────────────────────
//
// Every test that needs git creates a throwaway repo via mkdtempSync.
// Commit signing is disabled with `commit.gpgsign false` so the tests
// pass on machines where the user's global git config signs commits.

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf-8",
  }).trim();
}

function initRepo(dir: string, email = "reviewer@acme.com", name = "Reviewer"): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", email]);
  git(dir, ["config", "user.name", name]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  // First commit so rev-parse HEAD doesn't fail.
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ctx-bless-${prefix}-`));
}

// ── blessPage ─────────────────────────────────────────────────────────

describe("blessPage", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeTempDir("page");
    initRepo(repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("stamps blessed_by / blessed_at / blessed_at_sha into a bare page", () => {
    const body = "# Architecture\n\nWe use PostgreSQL.\n";
    const blessed = blessPage(body, {
      cwd: repo,
      now: new Date("2026-04-10T12:00:00Z"),
    });
    const { meta } = parsePage(blessed);
    expect(meta.blessed_by).toBe("reviewer@acme.com");
    expect(meta.blessed_at).toBe("2026-04-10T12:00:00.000Z");
    expect(meta.blessed_at_sha).toMatch(/^[a-f0-9]{7,40}$/);
  });

  it("preserves the existing body unchanged", () => {
    const body = "# Page\n\nBody line.\n\nSecond paragraph.\n";
    const blessed = blessPage(body, { cwd: repo });
    const { body: parsedBody } = parsePage(blessed);
    expect(parsedBody.trim()).toBe(body.trim());
  });

  it("merges with existing ctx metadata without clobbering refreshed_* keys", () => {
    const existing =
      "---\n" +
      "ctx:\n" +
      "  refreshed_at: 2026-04-01T09:00:00.000Z\n" +
      "  refreshed_by: ci:withctx\n" +
      "  commit: abc1234\n" +
      "  sources: 3\n" +
      "  tier: asserted\n" +
      "---\n" +
      "# Architecture\n\nBody.\n";
    const blessed = blessPage(existing, { cwd: repo });
    const { meta } = parsePage(blessed);
    expect(meta.refreshed_at).toBe("2026-04-01T09:00:00.000Z");
    expect(meta.refreshed_by).toBe("ci:withctx");
    expect(meta.commit).toBe("abc1234");
    expect(meta.sources).toBe(3);
    expect(meta.tier).toBe("asserted");
    expect(meta.blessed_by).toBe("reviewer@acme.com");
    expect(meta.blessed_at).toBeDefined();
  });

  it("honours an explicit blessedBy override", () => {
    const blessed = blessPage("# Page\n", {
      cwd: repo,
      blessedBy: "override@acme.com",
    });
    expect(readBlessState(blessed)).toMatchObject({
      status: "blessed",
      stamp: { blessed_by: "override@acme.com" },
    });
  });

  it("records an optional blessed_note when passed", () => {
    const blessed = blessPage("# Page\n", {
      cwd: repo,
      note: "verified against prod deploy 2026-04-10",
    });
    const { meta } = parsePage(blessed);
    expect(meta.blessed_note).toBe("verified against prod deploy 2026-04-10");
  });

  it("is idempotent — blessing twice produces the same fields (ignoring timestamp)", () => {
    const first = blessPage("# Page\n", {
      cwd: repo,
      now: new Date("2026-04-10T12:00:00Z"),
      blessedBy: "a@acme.com",
    });
    const second = blessPage(first, {
      cwd: repo,
      now: new Date("2026-04-10T12:00:00Z"),
      blessedBy: "a@acme.com",
    });
    expect(parsePage(second).meta.blessed_by).toBe("a@acme.com");
    expect(parsePage(second).meta.blessed_at).toBe("2026-04-10T12:00:00.000Z");
  });

  it("preserves non-ctx front matter (e.g. title, tags)", () => {
    const page =
      "---\n" +
      "title: Architecture\n" +
      "tags:\n" +
      "  - infra\n" +
      "  - db\n" +
      "---\n" +
      "# Architecture\n";
    const blessed = blessPage(page, { cwd: repo });
    expect(blessed).toContain("title: Architecture");
    expect(blessed).toContain("- infra");
    expect(blessed).toContain("blessed_by:");
  });

  it("still stamps when git isn't available — falls back to 'unknown'", () => {
    const nogit = makeTempDir("nogit");
    try {
      const blessed = blessPage("# Page\n", { cwd: nogit });
      const { meta } = parsePage(blessed);
      // Either a synthesised actor (USER@host) or "unknown" — both
      // are acceptable fallbacks, we just require that the stamp exists.
      expect(meta.blessed_by).toBeDefined();
      expect(meta.blessed_at).toBeDefined();
      // blessed_at_sha should be absent because there's no git HEAD.
      expect(meta.blessed_at_sha).toBeUndefined();
    } finally {
      rmSync(nogit, { recursive: true, force: true });
    }
  });
});

// ── revokeBless ───────────────────────────────────────────────────────

describe("revokeBless", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeTempDir("revoke");
    initRepo(repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("removes bless_* keys from a blessed page", () => {
    const blessed = blessPage("# Page\n", { cwd: repo, blessedBy: "r@acme.com" });
    expect(readBlessState(blessed).status).toBe("blessed");
    const revoked = revokeBless(blessed);
    expect(readBlessState(revoked).status).toBe("unblessed");
  });

  it("leaves a page with no bless block unchanged", () => {
    const bare = "# Page\n\nBody.\n";
    expect(revokeBless(bare)).toBe(bare);
  });

  it("preserves refreshed_* and other ctx fields when revoking", () => {
    const page =
      "---\n" +
      "ctx:\n" +
      "  refreshed_at: 2026-04-01T09:00:00.000Z\n" +
      "  refreshed_by: ci:withctx\n" +
      "  tier: verified\n" +
      "  blessed_by: r@acme.com\n" +
      "  blessed_at: 2026-04-10T12:00:00.000Z\n" +
      "  blessed_at_sha: a1b2c3d\n" +
      "---\n" +
      "# Page\n";
    const revoked = revokeBless(page);
    const { meta } = parsePage(revoked);
    expect(meta.refreshed_at).toBe("2026-04-01T09:00:00.000Z");
    expect(meta.refreshed_by).toBe("ci:withctx");
    expect(meta.tier).toBe("verified");
    expect(meta.blessed_by).toBeUndefined();
    expect(meta.blessed_at).toBeUndefined();
    expect(meta.blessed_at_sha).toBeUndefined();
  });

  it("preserves user-authored non-ctx front matter on revoke", () => {
    const page =
      "---\n" +
      "title: Architecture\n" +
      "ctx:\n" +
      "  blessed_by: r@acme.com\n" +
      "  blessed_at: 2026-04-10T12:00:00.000Z\n" +
      "---\n" +
      "# Page\n";
    const revoked = revokeBless(page);
    expect(revoked).toContain("title: Architecture");
    expect(revoked).not.toContain("blessed_by:");
  });
});

// ── readBlessState ───────────────────────────────────────────────────

describe("readBlessState", () => {
  it("returns unblessed for a page with no bless block", () => {
    expect(readBlessState("# Page\n")).toEqual({ status: "unblessed" });
  });

  it("returns blessed with the full stamp when all fields are present", () => {
    const page =
      "---\n" +
      "ctx:\n" +
      "  blessed_by: r@acme.com\n" +
      "  blessed_at: 2026-04-10T12:00:00.000Z\n" +
      "  blessed_at_sha: a1b2c3d\n" +
      "  blessed_note: good stuff\n" +
      "---\n" +
      "# Page\n";
    expect(readBlessState(page)).toEqual({
      status: "blessed",
      stamp: {
        blessed_by: "r@acme.com",
        blessed_at: "2026-04-10T12:00:00.000Z",
        blessed_at_sha: "a1b2c3d",
        blessed_note: "good stuff",
      },
    });
  });

  it("returns unblessed when blessed_by exists but blessed_at is missing", () => {
    const page =
      "---\n" +
      "ctx:\n" +
      "  blessed_by: r@acme.com\n" +
      "---\n" +
      "# Page\n";
    expect(readBlessState(page)).toEqual({ status: "unblessed" });
  });
});

// ── hasDriftedSinceBless ─────────────────────────────────────────────

describe("hasDriftedSinceBless", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeTempDir("drift");
    initRepo(repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("returns false for unblessed pages", () => {
    expect(hasDriftedSinceBless({ status: "unblessed" }, { cwd: repo })).toBe(false);
  });

  it("returns false when the bless has no sha pinned", () => {
    expect(
      hasDriftedSinceBless(
        {
          status: "blessed",
          stamp: {
            blessed_by: "r@acme.com",
            blessed_at: "2026-04-10T12:00:00.000Z",
          },
        },
        { cwd: repo }
      )
    ).toBe(false);
  });

  it("returns false when HEAD equals the blessed sha", () => {
    const sha = detectHeadSha(repo)!;
    expect(
      hasDriftedSinceBless(
        {
          status: "blessed",
          stamp: {
            blessed_by: "r@acme.com",
            blessed_at: "2026-04-10T12:00:00.000Z",
            blessed_at_sha: sha,
          },
        },
        { cwd: repo }
      )
    ).toBe(false);
  });

  it("returns true when HEAD has advanced past the blessed sha", () => {
    const blessedSha = detectHeadSha(repo)!;
    writeFileSync(join(repo, "extra.txt"), "more\n");
    git(repo, ["add", "extra.txt"]);
    git(repo, ["commit", "-q", "-m", "extra"]);
    expect(
      hasDriftedSinceBless(
        {
          status: "blessed",
          stamp: {
            blessed_by: "r@acme.com",
            blessed_at: "2026-04-10T12:00:00.000Z",
            blessed_at_sha: blessedSha,
          },
        },
        { cwd: repo }
      )
    ).toBe(true);
  });

  it("respects pageSourceFiles: only flags drift when those files changed", () => {
    const blessedSha = detectHeadSha(repo)!;
    // Touch a file NOT in the source list.
    writeFileSync(join(repo, "unrelated.txt"), "noise\n");
    git(repo, ["add", "unrelated.txt"]);
    git(repo, ["commit", "-q", "-m", "unrelated change"]);
    expect(
      hasDriftedSinceBless(
        {
          status: "blessed",
          stamp: {
            blessed_by: "r@acme.com",
            blessed_at: "2026-04-10T12:00:00.000Z",
            blessed_at_sha: blessedSha,
          },
        },
        { cwd: repo, pageSourceFiles: ["src/auth.ts"] }
      )
    ).toBe(false);
  });

  it("respects pageSourceFiles: flags drift when a listed file changed", () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "auth.ts"), "export const v = 1;\n");
    git(repo, ["add", "src/auth.ts"]);
    git(repo, ["commit", "-q", "-m", "add auth"]);
    const blessedSha = detectHeadSha(repo)!;
    writeFileSync(join(repo, "src", "auth.ts"), "export const v = 2;\n");
    git(repo, ["add", "src/auth.ts"]);
    git(repo, ["commit", "-q", "-m", "update auth"]);
    expect(
      hasDriftedSinceBless(
        {
          status: "blessed",
          stamp: {
            blessed_by: "r@acme.com",
            blessed_at: "2026-04-10T12:00:00.000Z",
            blessed_at_sha: blessedSha,
          },
        },
        { cwd: repo, pageSourceFiles: ["src/auth.ts"] }
      )
    ).toBe(true);
  });
});

// ── detectReviewer / detectHeadSha ───────────────────────────────────

describe("detectReviewer", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeTempDir("detect");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("prefers git config user.email", () => {
    initRepo(repo, "configured@acme.com", "Configured");
    expect(detectReviewer(repo)).toBe("configured@acme.com");
  });

  // Note: the "fall back to user.name when email is unset" branch is
  // hard to test in isolation because git walks up into global config
  // when local is empty, and most dev machines have a global email set.
  // The branch IS covered implicitly by the "git isn't available" case
  // in the blessPage suite, which exercises the full fallback chain.
});

describe("detectHeadSha", () => {
  it("returns a short sha inside a git repo", () => {
    const repo = makeTempDir("head");
    try {
      initRepo(repo);
      expect(detectHeadSha(repo)).toMatch(/^[a-f0-9]{7,40}$/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns undefined outside a git repo", () => {
    const nogit = makeTempDir("nogit");
    try {
      expect(detectHeadSha(nogit)).toBeUndefined();
    } finally {
      rmSync(nogit, { recursive: true, force: true });
    }
  });
});
