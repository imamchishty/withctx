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

import { writeFileSync, chmodSync, existsSync } from "node:fs";

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
