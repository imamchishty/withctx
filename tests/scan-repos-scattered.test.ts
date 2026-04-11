import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  readRepoAt,
  readReposFromPaths,
  parseReposFile,
} from "../src/setup/scan-repos.js";

/**
 * Tests for the scattered-path helpers used when repos live in
 * arbitrary locations on disk rather than as siblings under a shared
 * parent. These back `ctx setup --repo <path>` and `ctx publish --repo`.
 *
 * Same fixture philosophy as scan-repos.test.ts — no shell, no git
 * binary, just files and folders on the tmp filesystem.
 */

function makeTmp(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeFakeRepo(
  parent: string,
  name: string,
  opts: { originUrl?: string; branch?: string } = {}
): string {
  const repoPath = join(parent, name);
  mkdirSync(repoPath, { recursive: true });
  const gitDir = join(repoPath, ".git");
  mkdirSync(gitDir);
  if (opts.originUrl !== undefined) {
    writeFileSync(
      join(gitDir, "config"),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${opts.originUrl}\n`
    );
  }
  writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${opts.branch ?? "main"}\n`);
  return repoPath;
}

describe("readRepoAt — single-path repo reader", () => {
  it("reads a valid repo and returns relative path when inside anchor", () => {
    const { dir, cleanup } = makeTmp("ctx-readrepoat-");
    try {
      makeFakeRepo(dir, "alpha", {
        originUrl: "git@github.com:acme/alpha.git",
        branch: "main",
      });
      const repo = readRepoAt(join(dir, "alpha"), dir);
      expect(repo).not.toBeNull();
      expect(repo!.name).toBe("alpha");
      expect(repo!.path).toBe("./alpha");
      expect(repo!.github).toBe("https://github.com/acme/alpha");
      expect(repo!.branch).toBe("main");
    } finally {
      cleanup();
    }
  });

  it("uses absolute path when repo lives outside the anchor", () => {
    // Two separate temp trees — the repo is in one, the anchor is the
    // other. Climbing out with ../ would be fragile; we expect the
    // absolute path instead.
    const reposTmp = makeTmp("ctx-readrepoat-repos-");
    const anchorTmp = makeTmp("ctx-readrepoat-anchor-");
    try {
      makeFakeRepo(reposTmp.dir, "beta", {
        originUrl: "https://github.com/acme/beta.git",
      });
      const repo = readRepoAt(join(reposTmp.dir, "beta"), anchorTmp.dir);
      expect(repo).not.toBeNull();
      expect(repo!.name).toBe("beta");
      expect(isAbsolute(repo!.path)).toBe(true);
      expect(repo!.path).toBe(join(reposTmp.dir, "beta"));
    } finally {
      reposTmp.cleanup();
      anchorTmp.cleanup();
    }
  });

  it("returns null for a folder that doesn't exist", () => {
    const { dir, cleanup } = makeTmp("ctx-readrepoat-missing-");
    try {
      const repo = readRepoAt(join(dir, "nonexistent"), dir);
      expect(repo).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("returns null for a folder that isn't a git repo", () => {
    const { dir, cleanup } = makeTmp("ctx-readrepoat-nogit-");
    try {
      mkdirSync(join(dir, "plain"));
      writeFileSync(join(dir, "plain", "readme.md"), "hi\n");
      const repo = readRepoAt(join(dir, "plain"), dir);
      expect(repo).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("handles worktree markers (.git as a file, not a directory)", () => {
    const { dir, cleanup } = makeTmp("ctx-readrepoat-worktree-");
    try {
      const repoPath = join(dir, "wt");
      mkdirSync(repoPath);
      writeFileSync(join(repoPath, ".git"), "gitdir: /elsewhere\n");
      const repo = readRepoAt(repoPath, dir);
      expect(repo).not.toBeNull();
      expect(repo!.name).toBe("wt");
      // Worktree has no config in the usual place, so github + branch are null.
      expect(repo!.github).toBeNull();
      expect(repo!.branch).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("returns null when the path points at a file (not a folder)", () => {
    const { dir, cleanup } = makeTmp("ctx-readrepoat-file-");
    try {
      writeFileSync(join(dir, "a-file.txt"), "not a repo");
      const repo = readRepoAt(join(dir, "a-file.txt"), dir);
      expect(repo).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("readReposFromPaths — multi-path resolver", () => {
  it("resolves a mix of absolute and relative paths", () => {
    const { dir, cleanup } = makeTmp("ctx-multipath-");
    try {
      makeFakeRepo(dir, "api", {
        originUrl: "git@github.com:acme/api.git",
      });
      makeFakeRepo(dir, "web", {
        originUrl: "git@github.com:acme/web.git",
      });

      const { repos, missing } = readReposFromPaths(
        [join(dir, "api"), "./web"], // abs + rel
        dir,
        dir
      );

      expect(missing).toEqual([]);
      expect(repos).toHaveLength(2);
      expect(repos.map((r) => r.name).sort()).toEqual(["api", "web"]);
    } finally {
      cleanup();
    }
  });

  it("records missing paths without failing the whole call", () => {
    const { dir, cleanup } = makeTmp("ctx-multipath-missing-");
    try {
      makeFakeRepo(dir, "api", { originUrl: "git@github.com:acme/api.git" });

      const { repos, missing } = readReposFromPaths(
        [join(dir, "api"), join(dir, "ghost"), "/does/not/exist"],
        dir,
        dir
      );

      expect(repos).toHaveLength(1);
      expect(repos[0].name).toBe("api");
      expect(missing).toHaveLength(2);
      expect(missing).toContain(join(dir, "ghost"));
      expect(missing).toContain("/does/not/exist");
    } finally {
      cleanup();
    }
  });

  it("de-duplicates the same path given multiple times", () => {
    const { dir, cleanup } = makeTmp("ctx-multipath-dedup-");
    try {
      makeFakeRepo(dir, "api", { originUrl: "git@github.com:acme/api.git" });

      const { repos } = readReposFromPaths(
        [
          join(dir, "api"),
          join(dir, "api"), // dup as absolute
          "./api", // dup as relative — resolves to same absolute
        ],
        dir,
        dir
      );

      expect(repos).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("sorts results alphabetically by name", () => {
    const { dir, cleanup } = makeTmp("ctx-multipath-sort-");
    try {
      makeFakeRepo(dir, "zulu", { originUrl: "git@github.com:acme/zulu.git" });
      makeFakeRepo(dir, "alpha", { originUrl: "git@github.com:acme/alpha.git" });
      makeFakeRepo(dir, "mike", { originUrl: "git@github.com:acme/mike.git" });

      const { repos } = readReposFromPaths(
        [join(dir, "zulu"), join(dir, "alpha"), join(dir, "mike")],
        dir,
        dir
      );

      expect(repos.map((r) => r.name)).toEqual(["alpha", "mike", "zulu"]);
    } finally {
      cleanup();
    }
  });

  it("ignores blank and whitespace-only entries", () => {
    const { dir, cleanup } = makeTmp("ctx-multipath-blank-");
    try {
      makeFakeRepo(dir, "api", { originUrl: "git@github.com:acme/api.git" });

      const { repos, missing } = readReposFromPaths(
        ["  ", "", "\t", join(dir, "api")],
        dir,
        dir
      );

      expect(repos).toHaveLength(1);
      expect(missing).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("parseReposFile — manifest file reader", () => {
  it("reads a simple newline-delimited list", () => {
    const { dir, cleanup } = makeTmp("ctx-manifest-simple-");
    try {
      const file = join(dir, "repos.txt");
      writeFileSync(file, "/a/alpha\n/b/beta\n/c/gamma\n");
      expect(parseReposFile(file)).toEqual(["/a/alpha", "/b/beta", "/c/gamma"]);
    } finally {
      cleanup();
    }
  });

  it("strips full-line comments and blank lines", () => {
    const { dir, cleanup } = makeTmp("ctx-manifest-comments-");
    try {
      const file = join(dir, "repos.txt");
      writeFileSync(
        file,
        [
          "# our mono-team repos",
          "",
          "/work/alpha",
          "# another group",
          "/work/beta",
          "",
        ].join("\n")
      );
      expect(parseReposFile(file)).toEqual(["/work/alpha", "/work/beta"]);
    } finally {
      cleanup();
    }
  });

  it("strips inline comments after whitespace", () => {
    const { dir, cleanup } = makeTmp("ctx-manifest-inline-");
    try {
      const file = join(dir, "repos.txt");
      writeFileSync(
        file,
        "/work/alpha   # frontend\n/work/beta    # backend\n"
      );
      expect(parseReposFile(file)).toEqual(["/work/alpha", "/work/beta"]);
    } finally {
      cleanup();
    }
  });

  it("handles CRLF line endings", () => {
    const { dir, cleanup } = makeTmp("ctx-manifest-crlf-");
    try {
      const file = join(dir, "repos.txt");
      writeFileSync(file, "/work/alpha\r\n/work/beta\r\n");
      expect(parseReposFile(file)).toEqual(["/work/alpha", "/work/beta"]);
    } finally {
      cleanup();
    }
  });

  it("throws if the file doesn't exist", () => {
    expect(() => parseReposFile("/nope/nope/nope.txt")).toThrow();
  });

  it("returns an empty list for a fully-commented file", () => {
    const { dir, cleanup } = makeTmp("ctx-manifest-allcomments-");
    try {
      const file = join(dir, "repos.txt");
      writeFileSync(file, "# only\n# comments\n# here\n");
      expect(parseReposFile(file)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
