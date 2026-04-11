import { userInfo, hostname } from "node:os";
import { createInterface } from "node:readline";
import chalk from "chalk";
import type { CtxDirectory } from "../storage/ctx-dir.js";
import { readUsage, getLastRefresh, type RefreshRecord } from "./recorder.js";

/**
 * Refresh journal helpers.
 *
 * The journal lives in `.ctx/usage.jsonl` as `kind: "refresh"` records —
 * one per `ctx sync` / `ctx setup` run, whether it succeeded or failed.
 * `ctx history` reads them back; the cost-warning prompt in sync/setup
 * reads the most recent one to say "you last refreshed 2h ago, it cost
 * $0.34, this one will cost ~$X".
 *
 * Kept separate from recorder.ts because these helpers pull in `chalk`
 * and `readline` — stuff the raw recorder (which is also used by the
 * server and tests) has no business importing.
 */

export type RefreshTrigger = RefreshRecord["trigger"];

/**
 * Detect who is running this refresh.
 *
 * - CI: `ci:<workflow-name>` when `GITHUB_ACTIONS=true`, so `ctx history`
 *   can tell scheduled/push/manual runs apart at a glance
 *   (`ci:withctx`, `ci:nightly-docs`, …).
 * - Local: `username@hostname`. Deliberately not an email or git identity
 *   — those aren't always set on fresh machines, and we want the journal
 *   to work even before anyone has run `git config --global user.email`.
 */
export function detectActor(): string {
  if (process.env.GITHUB_ACTIONS === "true") {
    const workflow = process.env.GITHUB_WORKFLOW ?? "unknown";
    return `ci:${workflow}`;
  }
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    // userInfo() can throw on some locked-down environments (Docker
    // without a passwd entry for the uid). Fall back to something
    // informative rather than crashing the refresh.
    return `unknown@${hostname()}`;
  }
}

/**
 * Classify the refresh trigger. CI runs get their GitHub event name
 * (schedule/push/workflow_dispatch → manual); local runs get "sync" or
 * "setup", unless the user explicitly forced past the CI guardrail, in
 * which case they get "force" — a loud signal in `ctx history` that
 * budget was intentionally burned.
 */
export function detectTrigger(
  command: "sync" | "setup" | "ingest",
  forced: boolean
): RefreshTrigger {
  if (process.env.GITHUB_ACTIONS === "true") {
    const evt = process.env.GITHUB_EVENT_NAME;
    if (evt === "schedule") return "schedule";
    if (evt === "push") return "push";
    if (evt === "workflow_dispatch") return "manual";
    return "manual";
  }
  if (forced) return "force";
  if (command === "setup" || command === "ingest") return "setup";
  return "sync";
}

/**
 * Read the most recent refresh record from the journal. Returns null if
 * the journal is empty (first-ever refresh) — callers should treat that
 * as "no context, proceed without a warning".
 */
export function readLastRefresh(ctxDir: CtxDirectory): RefreshRecord | null {
  try {
    const records = readUsage(ctxDir);
    return getLastRefresh(records);
  } catch {
    return null;
  }
}

function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const deltaMs = Date.now() - then;
  if (deltaMs < 0) return "in the future";
  const mins = Math.round(deltaMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Cost-warning confirmation prompt shown when a user bypasses the
 * `refreshed_by: ci` guardrail with `--allow-local-refresh` / `--force`.
 * Reads the last refresh to answer "how old is the current wiki?" and
 * "how much did the last run cost?" — context that turns a blind
 * `--force` into an informed choice.
 *
 * Returns true if the user confirmed (or --yes was passed), false if
 * they cancelled. Not interactive in non-TTY contexts (CI) — in which
 * case it returns true and logs a brief warning instead, since blocking
 * a CI script on stdin input would be worse than proceeding.
 */
export async function confirmForcedRefresh(
  ctxDir: CtxDirectory,
  opts: { skipPrompt?: boolean; estimatedCostUsd?: number } = {}
): Promise<boolean> {
  const last = readLastRefresh(ctxDir);

  console.log();
  console.log(chalk.yellow.bold("  ⚠  Forcing a local refresh on a CI-managed wiki."));
  console.log();
  if (last) {
    const when = formatRelativeTime(last.ts);
    const who = last.actor;
    const cost = last.cost.toFixed(2);
    const tokens = (last.tokens.input + last.tokens.output).toLocaleString();
    console.log(
      `  Last refresh: ${chalk.cyan(when)} by ${chalk.cyan(who)} ` +
        `— ${chalk.cyan(tokens)} tokens, ${chalk.cyan("$" + cost)}`
    );
  } else {
    console.log(`  Last refresh: ${chalk.dim("no history yet — this would be the first")}`);
  }
  if (typeof opts.estimatedCostUsd === "number") {
    console.log(
      `  This run:     ${chalk.cyan("~$" + opts.estimatedCostUsd.toFixed(2))} estimated`
    );
  }
  console.log(
    chalk.dim(
      "  CI usually handles this — forcing locally burns your own budget."
    )
  );
  console.log();

  if (opts.skipPrompt) return true;
  if (!process.stdin.isTTY) {
    console.log(
      chalk.dim("  (non-interactive shell detected — proceeding without confirmation)")
    );
    return true;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.bold("  Continue? [y/N] "), (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });
  return answer === "y" || answer === "yes";
}
