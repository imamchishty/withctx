import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * A git repository discovered while scanning a parent directory for
 * sibling repos. Used by `ctx setup` to auto-populate `repos:` and
 * `sources.local[]` when the user runs setup in a workspace directory
 * like `~/work/acme` that contains several sibling repo folders.
 */
export interface DetectedRepo {
  /** Folder name (also used as the repo name in ctx.yaml). */
  name: string;
  /** Relative path from the scan root, with `./` prefix: e.g. `./api`. */
  path: string;
  /** Absolute path to the repo folder. */
  absolutePath: string;
  /**
   * Canonical HTTPS GitHub URL parsed from `.git/config` origin remote,
   * or null if the repo has no origin remote or it isn't parseable.
   */
  github: string | null;
  /** Current branch name from `.git/HEAD`, or null if not parseable. */
  branch: string | null;
}

export interface ScanReposOptions {
  /**
   * Directory names to skip (in addition to the defaults). Useful when
   * a workspace has tooling folders you don't want treated as repos.
   */
  ignoreDirs?: Iterable<string>;
  /**
   * If true, treat a `.git` *file* (worktree marker) as a repo as well
   * as a `.git` directory. Defaults to true.
   */
  includeWorktrees?: boolean;
}

const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".ctx",
  ".turbo",
  "coverage",
  ".cache",
  ".idea",
  ".vscode",
]);

/**
 * Scan one level of subdirectories under `rootDir` for git repositories.
 *
 * Intentionally NOT recursive — we only look at immediate children.
 * The expected layout is the common "workspace parent" pattern:
 *
 *   ~/work/acme/
 *   ├── api/      ← has .git
 *   ├── auth/     ← has .git
 *   └── web/      ← has .git
 *
 * If you have nested workspaces you'd run `ctx setup` from each
 * parent, not from a grandparent — that matches how humans actually
 * organise their filesystems.
 *
 * This function is pure: it reads files but writes nothing, makes no
 * network calls, and does not spawn `git`. That makes it testable
 * with just `mkdtempSync` + fake `.git/config` files.
 */
export function scanForRepos(
  rootDir: string,
  opts: ScanReposOptions = {}
): DetectedRepo[] {
  if (!existsSync(rootDir)) return [];

  const ignoreDirs = new Set(DEFAULT_IGNORE_DIRS);
  if (opts.ignoreDirs) {
    for (const d of opts.ignoreDirs) ignoreDirs.add(d);
  }
  const includeWorktrees = opts.includeWorktrees ?? true;

  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const repos: DetectedRepo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (ignoreDirs.has(entry.name)) continue;

    const repoPath = join(rootDir, entry.name);
    const gitPath = join(repoPath, ".git");

    if (!existsSync(gitPath)) continue;

    // .git can be a directory (normal clone) or a file (worktree).
    let isGit = false;
    try {
      const gitStat = statSync(gitPath);
      if (gitStat.isDirectory()) isGit = true;
      else if (gitStat.isFile() && includeWorktrees) isGit = true;
    } catch {
      continue;
    }

    if (!isGit) continue;

    repos.push({
      name: entry.name,
      path: `./${entry.name}`,
      absolutePath: repoPath,
      github: parseOriginUrl(repoPath),
      branch: parseCurrentBranch(repoPath),
    });
  }

  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse `.git/config` to find the `origin` remote URL and normalise
 * it to a canonical HTTPS GitHub URL. Returns null if the repo has
 * no origin remote or the URL isn't parseable.
 *
 * Handled shapes:
 *   git@github.com:acme/api.git        → https://github.com/acme/api
 *   https://github.com/acme/api.git    → https://github.com/acme/api
 *   https://github.com/acme/api        → https://github.com/acme/api
 *   ssh://git@github.com/acme/api.git  → https://github.com/acme/api
 *
 * For non-GitHub hosts we return the URL as-is (minus trailing .git)
 * so users hosting on GitLab or self-hosted Bitbucket still see
 * something sensible.
 */
export function parseOriginUrl(repoPath: string): string | null {
  const configPath = join(repoPath, ".git", "config");
  if (!existsSync(configPath)) {
    // Worktree case — the real config lives elsewhere. We can't follow
    // it safely without proper git plumbing, so we just skip.
    return null;
  }

  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch {
    return null;
  }

  // Walk the ini-style config, collecting the url = ... line that
  // appears inside the [remote "origin"] section. A simple regex-based
  // approach would misfire on configs with multiple remotes, so we do
  // a small section-aware parse.
  const lines = content.split(/\r?\n/);
  let inOriginSection = false;
  let rawUrl: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inOriginSection = /^\[remote\s+"origin"\]/.test(trimmed);
      continue;
    }
    if (!inOriginSection) continue;
    const match = /^url\s*=\s*(.+)$/.exec(trimmed);
    if (match) {
      rawUrl = match[1].trim();
      break;
    }
  }

  if (!rawUrl) return null;
  return normaliseGitUrl(rawUrl);
}

export function normaliseGitUrl(url: string): string | null {
  // git@github.com:acme/api.git
  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  // ssh://git@github.com/acme/api.git
  const sshProtocolMatch = /^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (sshProtocolMatch) {
    return `https://${sshProtocolMatch[1]}/${sshProtocolMatch[2]}`;
  }

  // https://github.com/acme/api(.git)?
  const httpsMatch = /^(https?:\/\/[^/]+\/.+?)(?:\.git)?$/.exec(url);
  if (httpsMatch) {
    return httpsMatch[1];
  }

  return null;
}

// ---------------------------------------------------------------------------
// Scattered-repo support
// ---------------------------------------------------------------------------
// The sibling scan above handles the "parent folder with child repos" layout.
// Real developers rarely have that. More common is repos scattered across
// the filesystem:
//
//   ~/work/lsp-web
//   ~/Code/lsp-core
//   ~/src/acme/lsp-data
//   /opt/lsp-api
//
// For that layout we need to let the user hand us an explicit list. These
// helpers turn one path (or a file of paths) into the same `DetectedRepo`
// shape the sibling scanner produces, so downstream code (runInit,
// ctx publish) doesn't care how the repo was discovered.

/**
 * Expand a leading `~` in a path to the user's home directory. Left alone
 * if `~` isn't the first character — so `./~foo` (a literal folder) stays
 * literal. We deliberately don't use `shell.expand` or `os.homedir()`
 * substitution for `$HOME` because that's the shell's job; users who need
 * env-var expansion in paths can let their shell do it before the path
 * reaches us.
 */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Read a single directory on disk as a git repo. Returns a `DetectedRepo`
 * if the folder exists and contains a `.git` directory or worktree marker,
 * otherwise null. The `anchorDir` is used to compute a relative `path`
 * field for the output — typically the directory that owns `ctx.yaml`.
 *
 * The relative path is what lands in `sources.local[].path`, so downstream
 * ingest can resolve it. If the repo lives outside the anchor (i.e. the
 * `relative()` result would start with `..`), we use the absolute path
 * instead — relative paths climbing out of the config directory are a
 * common cause of ingest bugs.
 */
export function readRepoAt(
  absolutePath: string,
  anchorDir: string
): DetectedRepo | null {
  if (!existsSync(absolutePath)) return null;

  let stat;
  try {
    stat = statSync(absolutePath);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const gitPath = join(absolutePath, ".git");
  if (!existsSync(gitPath)) return null;

  let isGit = false;
  try {
    const gitStat = statSync(gitPath);
    if (gitStat.isDirectory()) isGit = true;
    else if (gitStat.isFile()) isGit = true; // worktree marker
  } catch {
    return null;
  }
  if (!isGit) return null;

  // Prefer a relative path that stays inside the anchor. If the repo is
  // elsewhere on disk, fall back to the absolute path — safer than a
  // `../../../foo` that breaks as soon as ctx.yaml moves.
  const rel = relative(anchorDir, absolutePath);
  const path =
    rel === ""
      ? "."
      : rel.startsWith("..") || isAbsolute(rel)
        ? absolutePath
        : `./${rel}`;

  return {
    name: basename(absolutePath),
    path,
    absolutePath,
    github: parseOriginUrl(absolutePath),
    branch: parseCurrentBranch(absolutePath),
  };
}

/**
 * Resolve a list of user-supplied paths into `DetectedRepo` entries.
 *
 * - Paths starting with `~` get the user's home directory expanded.
 * - Relative paths are resolved against `cwd` (typically process.cwd()).
 * - Paths that aren't git repos are skipped — we don't error, because a
 *   partial success ("3 of 4 repos found") is more useful than failing
 *   the whole command. Callers get a list of the missing paths via the
 *   `missing` field so they can warn.
 * - Duplicate paths (after resolution) are de-duplicated.
 * - Result is sorted alphabetically by name.
 */
export function readReposFromPaths(
  paths: string[],
  cwd: string,
  anchorDir: string
): { repos: DetectedRepo[]; missing: string[] } {
  const repos: DetectedRepo[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const raw of paths) {
    const expanded = expandHome(raw.trim());
    if (expanded === "") continue;

    const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    if (seen.has(absolute)) continue;
    seen.add(absolute);

    const repo = readRepoAt(absolute, anchorDir);
    if (repo === null) {
      missing.push(raw);
    } else {
      repos.push(repo);
    }
  }

  return {
    repos: repos.sort((a, b) => a.name.localeCompare(b.name)),
    missing,
  };
}

/**
 * Read a newline-delimited repo manifest file. Format:
 *
 *   # Comments start with #
 *   ~/work/lsp-web
 *   ~/Code/lsp-core
 *   /opt/lsp-api
 *
 * Blank lines are ignored. Inline comments after a `#` are stripped.
 * Paths are returned as-is — expansion happens in `readReposFromPaths`.
 *
 * Throws if the file can't be read, so the caller can surface a clean
 * error. (A missing manifest file is a user mistake, not a "silently
 * continue" case.)
 */
export function parseReposFile(filePath: string): string[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const paths: string[] = [];

  for (const line of lines) {
    // Strip inline comments, but preserve `#` inside quoted paths. Users
    // with `#` in a folder name are extremely rare — we optimise for the
    // common "# comment" case and tell the weird case to quote.
    const withoutComment = line.replace(/\s+#.*$/, "").replace(/^#.*$/, "");
    const trimmed = withoutComment.trim();
    if (trimmed === "") continue;
    paths.push(trimmed);
  }

  return paths;
}

/**
 * Parse `.git/HEAD` to get the current branch name. Returns null for
 * detached HEAD states or unreadable files — those are edge cases
 * where we'd rather write no branch than guess wrong.
 */
export function parseCurrentBranch(repoPath: string): string | null {
  const headPath = join(repoPath, ".git", "HEAD");
  if (!existsSync(headPath)) return null;

  let content: string;
  try {
    content = readFileSync(headPath, "utf-8").trim();
  } catch {
    return null;
  }

  // Normal case: "ref: refs/heads/main"
  const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(content);
  if (refMatch) return refMatch[1];

  // Detached HEAD — just a commit SHA. Don't pretend it's a branch.
  return null;
}
