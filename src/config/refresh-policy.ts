/**
 * Guardrail for wikis marked `refreshed_by: ci` in `ctx.yaml`.
 *
 * The use-case: a shared wiki repo where CI is the source of truth.
 * Without this guardrail, any developer who clones the repo and runs
 * `ctx ingest` or `ctx sync` burns LLM budget on a rebuild nobody
 * asked for and produces a dirty working tree.
 *
 * The rule:
 *   - `refreshed_by` unset or `"local"` → always allowed (the default).
 *   - `refreshed_by: "ci"`              → blocked unless the caller
 *                                         passes `--allow-local-refresh`.
 *
 * The escape hatch is a CLI flag, not an env var, because:
 *   1. Flags show up in `--help` — discoverable.
 *   2. Shell completion works.
 *   3. It's consistent with how every other withctx flag works.
 *   4. A flag is still a conscious action — you still have to type it.
 *
 * Callers (ingest, sync, setup) each register a `--allow-local-refresh`
 * option on their own command and pass the boolean through.
 */

import type { CtxConfig } from "../types/config.js";

export interface RefreshPolicyOptions {
  /**
   * True when the user explicitly passed `--allow-local-refresh`.
   * Bypasses the guardrail on CI-refreshed wikis.
   */
  allowLocalRefresh?: boolean;
}

export interface RefreshPolicyCheck {
  /** True if the caller is allowed to run the refresh. */
  allowed: boolean;
  /**
   * Human-readable explanation for the block. Undefined when allowed.
   * Callers should print this and then exit non-zero.
   */
  reason?: string;
}

/**
 * Decide whether a refresh-style command (ingest, sync, ...) is allowed
 * to run against the given config.
 *
 * `commandName` is only used in the error message, so users see "Run
 * `ctx ingest` is blocked..." rather than a generic error.
 */
export function checkRefreshPolicy(
  config: CtxConfig | null,
  commandName: string,
  options: RefreshPolicyOptions = {}
): RefreshPolicyCheck {
  // Null config → setup hasn't run yet, nothing to guard. Caller will
  // handle the missing-config case in its own error path.
  if (config === null) return { allowed: true };

  // Default is "local" — no guardrail.
  if (config.refreshed_by !== "ci") return { allowed: true };

  // Explicit escape hatch via --allow-local-refresh flag.
  if (options.allowLocalRefresh === true) return { allowed: true };

  const reason =
    `This wiki is refreshed by CI (\`refreshed_by: ci\` in ctx.yaml).\n` +
    `  \`ctx ${commandName}\` is reserved for the refresh workflow so\n` +
    `  per-developer rebuilds don't waste LLM budget or create dirty\n` +
    `  working trees.\n\n` +
    `  To read the wiki:     ctx chat  (or open .ctx/context/*.md)\n` +
    `  To trigger a refresh: push to the branch, or run the workflow\n` +
    `                        manually from the GitHub Actions tab.\n\n` +
    `  If you REALLY need a local rebuild (e.g. debugging CI):\n` +
    `      ctx ${commandName} --allow-local-refresh`;

  return { allowed: false, reason };
}
