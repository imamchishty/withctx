/**
 * File-mode helpers for sensitive files.
 *
 * ctx.yaml can contain API keys (directly or via `${VAR}`
 * interpolation that resolves at runtime). On shared / multi-user
 * systems the default `writeFileSync` produces world-readable
 * files, so a co-located attacker can `cat ~dev/ctx.yaml` and
 * walk away with the key.
 *
 * Every place that writes ctx.yaml, costs.json, refresh-journal.json,
 * or any other file that might hold secrets goes through
 * `writeSecretFile` so the mode is 0600 (owner read/write only).
 *
 * On Windows the `mode` option is a no-op — the filesystem doesn't
 * have POSIX permission bits. That's fine: on Windows each user
 * profile is already access-controlled at the directory level and
 * the shared-machine threat model doesn't apply the same way.
 */

import {
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";

/**
 * Write a file with owner-only permissions (0600). Idempotent —
 * existing files have their mode tightened as well, so upgrading
 * an old, world-readable ctx.yaml happens automatically on the
 * next write.
 */
export function writeSecretFile(path: string, data: string | Buffer): void {
  // First write the content (creates or overwrites). Then explicitly
  // chmod, which is required because `writeFileSync`'s `mode` option
  // is only honoured on file CREATION — it silently does nothing
  // when the file already exists.
  writeFileSync(path, data, { mode: 0o600 });
  try {
    if (existsSync(path)) {
      chmodSync(path, 0o600);
    }
  } catch {
    // chmod isn't supported on every filesystem (Windows, some
    // network mounts). Silently fall back — the content is already
    // on disk, and on those platforms the threat model is different.
  }
}

/**
 * Read a secret from a file on disk. Enforces two invariants:
 *
 *   1. The file is not group- or world-readable (POSIX only).
 *      Anyone with access to the file has access to the token, so
 *      we refuse to read files with `--r--r--` or `--r-----` bits.
 *      We print a clear error telling the user to `chmod 600`.
 *
 *   2. The content is trimmed of trailing whitespace / newlines.
 *      Users routinely create token files with `echo "ghp_..." > f`,
 *      which appends a newline that then ends up inside the
 *      `Authorization: token ghp_...\n` header and breaks auth.
 *
 * On Windows we skip the mode check entirely — the POSIX bits don't
 * map cleanly onto NTFS ACLs and every user profile is access-
 * controlled at the directory level anyway.
 *
 * Throws on any failure so callers can surface a clean error to the
 * user instead of silently falling back to a broken state.
 */
export function readSecretFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`Token file not found: ${path}`);
  }

  // POSIX mode check. `stat.mode` has the file type in the high bits
  // and the permission bits in the low 9. Mask with 0o777 to get
  // `rwxrwxrwx`. Anything with group-read (0o040) or other-read
  // (0o004) set is rejected — the token is leakable.
  //
  // process.platform === "win32" skips this because NTFS doesn't use
  // POSIX bits; Windows has its own access control story.
  if (process.platform !== "win32") {
    try {
      const stat = statSync(path);
      const mode = stat.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        const octal = mode.toString(8).padStart(3, "0");
        throw new Error(
          `Token file ${path} has permissions ${octal}; must be 600 or 400. ` +
            `Run: chmod 600 ${path}`
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("Token file")) {
        throw err;
      }
      throw new Error(
        `Failed to stat token file ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read token file ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error(`Token file ${path} is empty`);
  }

  // Defence in depth: if the file is multi-line, something's wrong —
  // users sometimes cat an entire env file in here. Return only the
  // first non-empty line so we can't accidentally send a blob of
  // random text as an auth header.
  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim() !== "");
  if (!firstLine) {
    throw new Error(`Token file ${path} has no non-blank lines`);
  }
  return firstLine.trim();
}
