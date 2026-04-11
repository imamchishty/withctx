import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findRepoRoot,
  getGitHead,
  getFileCommit,
  buildFreshnessSnapshot,
  diffFreshnessSnapshots,
  isSnapshotStale,
  encodeSnapshot,
  decodeSnapshot,
} from "../src/wiki/git-freshness.js";

/**
 * Spin up a real temp git repo — these tests exercise `git` itself
 * because the whole module is a shell-out. No mocks: if `git` isn't
 * reachable in CI the module is useless anyway, and we want to know.
 */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf-8",
  }).trim();
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@withctx.dev"]);
  git(dir, ["config", "user.name", "withctx test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function writeAndCommit(dir: string, relPath: string, content: string, message: string): string {
  writeFileSync(join(dir, relPath), content);
  git(dir, ["add", relPath]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

describe("findRepoRoot", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-gf-root-"));
    initRepo(dir);
    mkdirSync(join(dir, "subdir"), { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the repo root from the repo dir itself", () => {
    expect(findRepoRoot(dir)).toBe(dir);
  });

  it("walks up from a subdirectory to find the root", () => {
    expect(findRepoRoot(join(dir, "subdir"))).toBe(dir);
  });

  it("returns undefined for a non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "ctx-gf-nogit-"));
    try {
      expect(findRepoRoot(nonGit)).toBeUndefined();
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe("getGitHead + getFileCommit", () => {
  let dir: string;
  let firstSha: string;
  let secondSha: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-gf-head-"));
    initRepo(dir);
    firstSha = writeAndCommit(dir, "a.txt", "alpha\n", "add a");
    secondSha = writeAndCommit(dir, "b.txt", "beta\n", "add b");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("getGitHead returns the most recent commit SHA", () => {
    expect(getGitHead(dir)).toBe(secondSha);
  });

  it("getFileCommit returns the last commit touching a file", () => {
    expect(getFileCommit(dir, "a.txt")).toBe(firstSha);
    expect(getFileCommit(dir, "b.txt")).toBe(secondSha);
  });

  it("getFileCommit returns undefined for an untracked file", () => {
    writeFileSync(join(dir, "c.txt"), "gamma\n");
    expect(getFileCommit(dir, "c.txt")).toBeUndefined();
  });
});

describe("buildFreshnessSnapshot", () => {
  let dir: string;
  let shaA: string;
  let shaB: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ctx-gf-snap-"));
    initRepo(dir);
    shaA = writeAndCommit(dir, "a.txt", "a1\n", "a v1");
    shaB = writeAndCommit(dir, "b.txt", "b1\n", "b v1");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("captures head + per-file commits with keys relative to rootDir", () => {
    const snap = buildFreshnessSnapshot(dir, ["a.txt", "b.txt"]);
    expect(snap.head).toBe(shaB); // HEAD is latest commit
    expect(snap.files["a.txt"]).toBe(shaA);
    expect(snap.files["b.txt"]).toBe(shaB);
    expect(snap.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("omits untracked files rather than erroring", () => {
    writeFileSync(join(dir, "untracked.txt"), "x\n");
    const snap = buildFreshnessSnapshot(dir, ["a.txt", "untracked.txt"]);
    expect(snap.files["a.txt"]).toBe(shaA);
    expect(snap.files["untracked.txt"]).toBeUndefined();
  });

  it("returns an empty files map when rootDir isn't in a git repo", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "ctx-gf-nogit-snap-"));
    try {
      writeFileSync(join(nonGit, "x.txt"), "hi\n");
      const snap = buildFreshnessSnapshot(nonGit, ["x.txt"]);
      expect(snap.files).toEqual({});
      expect(snap.head).toBeUndefined();
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe("diffFreshnessSnapshots", () => {
  it("reports unchanged when SHAs match", () => {
    const stored = { head: "H1", files: { "a.txt": "S1", "b.txt": "S2" }, capturedAt: "t1" };
    const current = { head: "H1", files: { "a.txt": "S1", "b.txt": "S2" }, capturedAt: "t2" };
    const diff = diffFreshnessSnapshots(stored, current);
    expect(diff.unchanged).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.headMoved).toBe(false);
  });

  it("flags a changed file when its SHA moved", () => {
    const stored = { head: "H1", files: { "a.txt": "S1" }, capturedAt: "t1" };
    const current = { head: "H2", files: { "a.txt": "S2" }, capturedAt: "t2" };
    const diff = diffFreshnessSnapshots(stored, current);
    expect(diff.changed).toEqual(["a.txt"]);
    expect(diff.headMoved).toBe(true);
  });

  it("classifies added vs removed files", () => {
    const stored = { files: { "a.txt": "S1", "gone.txt": "S2" }, capturedAt: "t1" };
    const current = { files: { "a.txt": "S1", "new.txt": "S3" }, capturedAt: "t2" };
    const diff = diffFreshnessSnapshots(stored, current);
    expect(diff.added).toEqual(["new.txt"]);
    expect(diff.removed).toEqual(["gone.txt"]);
    expect(diff.unchanged).toEqual(["a.txt"]);
  });
});

describe("isSnapshotStale", () => {
  it("returns false when nothing moved", () => {
    const snap = { files: { "a.txt": "S1" }, capturedAt: "t1" };
    expect(isSnapshotStale(snap, snap)).toBe(false);
  });

  it("returns true when a file SHA moved", () => {
    const stored = { files: { "a.txt": "S1" }, capturedAt: "t1" };
    const current = { files: { "a.txt": "S2" }, capturedAt: "t2" };
    expect(isSnapshotStale(stored, current)).toBe(true);
  });

  it("returns false when only HEAD moved (no file delta)", () => {
    const stored = { head: "H1", files: { "a.txt": "S1" }, capturedAt: "t1" };
    const current = { head: "H2", files: { "a.txt": "S1" }, capturedAt: "t2" };
    // HEAD movement alone is not "stale" for a specific page — only
    // file-level SHA movement counts.
    expect(isSnapshotStale(stored, current)).toBe(false);
  });
});

describe("encode/decodeSnapshot", () => {
  it("round-trips a snapshot", () => {
    const snap = {
      head: "abcdef",
      files: { "a.txt": "111", "b.txt": "222" },
      capturedAt: "2026-04-10T00:00:00.000Z",
    };
    const encoded = encodeSnapshot(snap);
    const decoded = decodeSnapshot(encoded);
    expect(decoded).toEqual(snap);
  });

  it("produces compact JSON (keys h/f/t, not full names)", () => {
    const encoded = encodeSnapshot({
      head: "X",
      files: { "a.txt": "Y" },
      capturedAt: "T",
    });
    // Compact keys — saves bytes when stamped on hundreds of pages.
    expect(encoded).toContain('"h":"X"');
    expect(encoded).toContain('"f":{"a.txt":"Y"}');
    expect(encoded).toContain('"t":"T"');
  });

  it("returns undefined for malformed JSON", () => {
    expect(decodeSnapshot("not-json")).toBeUndefined();
  });

  it("handles a snapshot with no head", () => {
    const snap = { files: { "a.txt": "111" }, capturedAt: "t" };
    const decoded = decodeSnapshot(encodeSnapshot(snap));
    expect(decoded?.head).toBeUndefined();
    expect(decoded?.files).toEqual({ "a.txt": "111" });
  });
});
