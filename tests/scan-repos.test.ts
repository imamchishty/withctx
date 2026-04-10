import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanForRepos,
  normaliseGitUrl,
  parseOriginUrl,
  parseCurrentBranch,
} from "../src/setup/scan-repos.js";

/**
 * Tests for the sibling-repo scanner used by `ctx setup` when run in
 * a workspace directory like ~/work/acme/ that holds several sibling
 * repo folders. The scanner MUST NOT spawn git — it parses .git/config
 * and .git/HEAD directly so tests can build the whole fixture with
 * plain file writes and no shell.
 */

function makeWorkspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ctx-scan-repos-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeFakeRepo(
  workspace: string,
  name: string,
  opts: { originUrl?: string; branch?: string | null; gitAsFile?: boolean } = {}
): string {
  const repoPath = join(workspace, name);
  mkdirSync(repoPath, { recursive: true });

  if (opts.gitAsFile) {
    // Worktree marker — .git is a FILE pointing elsewhere.
    writeFileSync(join(repoPath, ".git"), "gitdir: /somewhere/else\n");
    return repoPath;
  }

  const gitDir = join(repoPath, ".git");
  mkdirSync(gitDir);

  if (opts.originUrl !== undefined) {
    writeFileSync(
      join(gitDir, "config"),
      `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = ${opts.originUrl}
\tfetch = +refs/heads/*:refs/remotes/origin/*
`
    );
  }

  if (opts.branch !== null) {
    const branchName = opts.branch ?? "main";
    writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${branchName}\n`);
  } else {
    // Detached HEAD — just a SHA.
    writeFileSync(
      join(gitDir, "HEAD"),
      "a1b2c3d4e5f6789012345678901234567890abcd\n"
    );
  }

  return repoPath;
}

describe("scanForRepos", () => {
  let ws: ReturnType<typeof makeWorkspace>;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it("returns [] for an empty workspace", () => {
    expect(scanForRepos(ws.dir)).toEqual([]);
  });

  it("returns [] for a non-existent workspace", () => {
    expect(scanForRepos(join(ws.dir, "nope"))).toEqual([]);
  });

  it("finds one sibling repo with SSH origin URL and main branch", () => {
    makeFakeRepo(ws.dir, "api", {
      originUrl: "git@github.com:acme/api.git",
      branch: "main",
    });

    const repos = scanForRepos(ws.dir);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      name: "api",
      path: "./api",
      github: "https://github.com/acme/api",
      branch: "main",
    });
  });

  it("finds multiple sibling repos, sorted alphabetically", () => {
    makeFakeRepo(ws.dir, "web", {
      originUrl: "https://github.com/acme/web.git",
      branch: "main",
    });
    makeFakeRepo(ws.dir, "api", {
      originUrl: "git@github.com:acme/api.git",
      branch: "develop",
    });
    makeFakeRepo(ws.dir, "auth", {
      originUrl: "git@github.com:acme/auth.git",
      branch: "main",
    });

    const repos = scanForRepos(ws.dir);
    expect(repos.map((r) => r.name)).toEqual(["api", "auth", "web"]);
    expect(repos.map((r) => r.github)).toEqual([
      "https://github.com/acme/api",
      "https://github.com/acme/auth",
      "https://github.com/acme/web",
    ]);
    expect(repos[0].branch).toBe("develop");
    expect(repos[1].branch).toBe("main");
  });

  it("handles a repo with no origin remote", () => {
    const repoDir = join(ws.dir, "lonely");
    mkdirSync(repoDir);
    mkdirSync(join(repoDir, ".git"));
    writeFileSync(
      join(repoDir, ".git", "config"),
      `[core]\n\trepositoryformatversion = 0\n`
    );
    writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");

    const repos = scanForRepos(ws.dir);
    expect(repos).toHaveLength(1);
    expect(repos[0].github).toBeNull();
    expect(repos[0].branch).toBe("main");
  });

  it("returns null branch for a detached HEAD", () => {
    makeFakeRepo(ws.dir, "api", {
      originUrl: "git@github.com:acme/api.git",
      branch: null, // detached — just a SHA in HEAD
    });

    const repos = scanForRepos(ws.dir);
    expect(repos).toHaveLength(1);
    expect(repos[0].branch).toBeNull();
  });

  it("skips ignored directories (node_modules, dist, etc.)", () => {
    makeFakeRepo(ws.dir, "api", {
      originUrl: "git@github.com:acme/api.git",
    });
    // Make a fake node_modules that somehow has a .git — should be ignored.
    const nm = join(ws.dir, "node_modules");
    mkdirSync(nm);
    mkdirSync(join(nm, ".git"));
    writeFileSync(join(nm, ".git", "HEAD"), "ref: refs/heads/main\n");

    const repos = scanForRepos(ws.dir);
    expect(repos.map((r) => r.name)).toEqual(["api"]);
  });

  it("skips hidden directories", () => {
    const hidden = join(ws.dir, ".hidden");
    mkdirSync(hidden);
    mkdirSync(join(hidden, ".git"));
    writeFileSync(join(hidden, ".git", "HEAD"), "ref: refs/heads/main\n");

    expect(scanForRepos(ws.dir)).toEqual([]);
  });

  it("skips plain directories without a .git entry", () => {
    mkdirSync(join(ws.dir, "docs"));
    mkdirSync(join(ws.dir, "scripts"));
    makeFakeRepo(ws.dir, "api", {
      originUrl: "git@github.com:acme/api.git",
    });

    const repos = scanForRepos(ws.dir);
    expect(repos.map((r) => r.name)).toEqual(["api"]);
  });

  it("does NOT recurse — only looks at immediate children", () => {
    const nested = join(ws.dir, "workspace", "nested");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(nested, ".git"));
    writeFileSync(join(nested, ".git", "HEAD"), "ref: refs/heads/main\n");

    // No repo at the immediate child level, so result is [].
    expect(scanForRepos(ws.dir)).toEqual([]);
  });

  it("treats a worktree marker file as a repo when includeWorktrees is true", () => {
    makeFakeRepo(ws.dir, "api-wt", {
      gitAsFile: true,
    });

    const repos = scanForRepos(ws.dir);
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe("api-wt");
    // Worktrees can't be parsed without following the gitdir pointer,
    // so github and branch are null — that's intentional.
    expect(repos[0].github).toBeNull();
    expect(repos[0].branch).toBeNull();
  });

  it("skips worktree marker files when includeWorktrees is false", () => {
    makeFakeRepo(ws.dir, "api-wt", { gitAsFile: true });

    const repos = scanForRepos(ws.dir, { includeWorktrees: false });
    expect(repos).toEqual([]);
  });
});

describe("normaliseGitUrl", () => {
  it("normalises SSH URL with .git suffix", () => {
    expect(normaliseGitUrl("git@github.com:acme/api.git")).toBe(
      "https://github.com/acme/api"
    );
  });

  it("normalises SSH URL without .git suffix", () => {
    expect(normaliseGitUrl("git@github.com:acme/api")).toBe(
      "https://github.com/acme/api"
    );
  });

  it("normalises HTTPS URL with .git suffix", () => {
    expect(normaliseGitUrl("https://github.com/acme/api.git")).toBe(
      "https://github.com/acme/api"
    );
  });

  it("normalises HTTPS URL without .git suffix", () => {
    expect(normaliseGitUrl("https://github.com/acme/api")).toBe(
      "https://github.com/acme/api"
    );
  });

  it("normalises ssh:// protocol URL", () => {
    expect(normaliseGitUrl("ssh://git@github.com/acme/api.git")).toBe(
      "https://github.com/acme/api"
    );
  });

  it("handles non-GitHub HTTPS hosts (GitLab, self-hosted)", () => {
    expect(
      normaliseGitUrl("https://gitlab.example.com/team/repo.git")
    ).toBe("https://gitlab.example.com/team/repo");
  });

  it("handles non-GitHub SSH hosts", () => {
    expect(
      normaliseGitUrl("git@gitlab.example.com:team/repo.git")
    ).toBe("https://gitlab.example.com/team/repo");
  });

  it("returns null for unrecognised shapes", () => {
    expect(normaliseGitUrl("not a url")).toBeNull();
    expect(normaliseGitUrl("")).toBeNull();
  });
});

describe("parseOriginUrl / parseCurrentBranch (direct)", () => {
  let ws: ReturnType<typeof makeWorkspace>;
  beforeEach(() => {
    ws = makeWorkspace();
  });
  afterEach(() => ws.cleanup());

  it("ignores non-origin remotes", () => {
    const repo = join(ws.dir, "api");
    mkdirSync(repo);
    mkdirSync(join(repo, ".git"));
    writeFileSync(
      join(repo, ".git", "config"),
      `[remote "upstream"]
\turl = git@github.com:upstream/api.git
[remote "origin"]
\turl = git@github.com:acme/api.git
`
    );
    expect(parseOriginUrl(repo)).toBe("https://github.com/acme/api");
  });

  it("returns null when config file is missing", () => {
    const repo = join(ws.dir, "api");
    mkdirSync(repo);
    mkdirSync(join(repo, ".git"));
    expect(parseOriginUrl(repo)).toBeNull();
  });

  it("parseCurrentBranch returns null when HEAD is missing", () => {
    const repo = join(ws.dir, "api");
    mkdirSync(repo);
    mkdirSync(join(repo, ".git"));
    expect(parseCurrentBranch(repo)).toBeNull();
  });
});
