import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { CtxDirectory } from "../storage/ctx-dir.js";

/**
 * Append-only usage history.
 *
 * Each line in `.ctx/usage.jsonl` is one record. Two record kinds:
 *   - "call":     a model call (operation, tokens, cost)
 *   - "snapshot": a wiki state snapshot (source docs, wiki pages, bytes)
 *
 * JSONL is chosen over JSON so:
 *   - Writes are O(1) (append)
 *   - History is greppable / tail-able from a shell
 *   - Corruption of one line doesn't lose the file
 */

export type UsageOperation =
  | "ingest"
  | "sync"
  | "query"
  | "chat"
  | "add"
  | "lint"
  | "review"
  | "explain"
  | "faq"
  | "glossary"
  | "impact"
  | "changelog"
  | "metrics"
  | "embed";

export interface CallRecord {
  ts: string;
  kind: "call";
  op: UsageOperation;
  model: string;
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost: number;
}

export interface SnapshotRecord {
  ts: string;
  kind: "snapshot";
  sourceDocs: number;
  wikiPages: number;
  bytes: number;
}

/**
 * A single wiki refresh — one invocation of `ctx sync` or the inline
 * ingest step inside `ctx setup`. Aggregates the whole run into a
 * single journal entry so `ctx history` can render "who refreshed
 * when, and how much did it cost?".
 *
 * Distinct from `CallRecord` (which is per-LLM-call): one refresh
 * typically contains multiple call records plus one refresh record
 * that summarises them.
 *
 * Field semantics:
 *   actor:     "username@hostname" for local runs, "ci:<workflow>" for
 *              CI runs (detected via GITHUB_ACTIONS env). Deliberately
 *              free-form rather than an enum — we want it to be
 *              human-readable when `cat`-ed from a shell.
 *   trigger:   why the refresh was run. "schedule"/"push"/"manual" on
 *              CI, "setup"/"sync"/"force" for local runs.
 *   forced:    true if the user bypassed the refreshed_by: ci guard
 *              with --force / --allow-local-refresh.
 *   tokens:    input + output totals across every LLM call in this run.
 *   cost:      sum of per-call costs (calculated from MODEL_PRICING).
 *   pages:     delta: added / changed / removed page counts.
 *   duration:  wall-clock milliseconds start-to-finish.
 *   success:   whether the refresh completed without a fatal error.
 *   error:     brief error message on failure, null on success.
 */
export interface RefreshRecord {
  ts: string;
  kind: "refresh";
  actor: string;
  trigger: "schedule" | "push" | "manual" | "setup" | "sync" | "force";
  forced: boolean;
  model: string;
  tokens: { input: number; output: number };
  cost: number;
  pages: { added: number; changed: number; removed: number };
  duration_ms: number;
  success: boolean;
  error?: string | null;
  withctx_version?: string;
}

export type UsageRecord = CallRecord | SnapshotRecord | RefreshRecord;

/**
 * Price per 1M tokens (USD) for a single model.
 *
 * Exported so users can declare custom pricing in `ctx.yaml` under
 * `ai.pricing` without modifying source code — essential for corporate /
 * self-hosted endpoints (Core42, Azure OpenAI, private vLLM, etc.) whose
 * model names won't match any of the built-in entries.
 */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type PricingMap = Record<string, ModelPricing>;

/**
 * Built-in pricing for the well-known hosted models. This is the *fallback*
 * source — anything in `customPricing` (set via `setCustomPricing`, which
 * loads `ai.pricing` from the user's config) takes precedence.
 */
export const MODEL_PRICING: PricingMap = {
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-haiku-3.5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // OpenAI — rough defaults, users with negotiated rates should override
  // via ai.pricing in ctx.yaml.
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "o1": { input: 15, output: 60 },
  "o3-mini": { input: 1.1, output: 4.4 },
};

/**
 * Custom pricing supplied via `ai.pricing` in ctx.yaml. Stored at module
 * level so every call site — CLI commands, server routes, tests — sees the
 * same map after a single `setCustomPricing()` call at bootstrap, without
 * having to thread config through every `recordCall()` call site.
 */
let customPricing: PricingMap = {};

/**
 * Merge user-supplied pricing into the runtime registry. Keys overwrite
 * built-ins, which is the point: a user at Core42 who writes
 *
 *   ai:
 *     pricing:
 *       claude-sonnet-4: { input: 2.5, output: 12 }   # negotiated rate
 *       our-private-jais-13b: { input: 0.1, output: 0.4 }
 *
 * gets accurate cost tracking for both their discounted sonnet calls AND a
 * completely in-house model — no code changes.
 *
 * Called once, early, from the CLI entry point (and from any tool/test that
 * loads its own config). Idempotent; re-calling replaces the previous map.
 */
export function setCustomPricing(pricing: PricingMap | undefined | null): void {
  customPricing = pricing ?? {};
}

/** Current custom pricing map — useful for tests and `ctx doctor` output. */
export function getCustomPricing(): PricingMap {
  return customPricing;
}

/**
 * Resolve a model name to a pricing entry. Resolution order:
 *   1. Custom pricing (user-declared in ctx.yaml)
 *   2. Built-in pricing
 *   3. null — caller decides whether to fall back to Sonnet or warn.
 *
 * Kept separate from `calculateCost` so `ctx doctor` can surface unknown
 * models explicitly ("You're using 'foobar-7b' — no pricing known, add one
 * under ai.pricing or costs will read as $0").
 */
export function resolvePricing(model: string): ModelPricing | null {
  return customPricing[model] ?? MODEL_PRICING[model] ?? null;
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead = 0,
  cacheWrite = 0
): number {
  // Fall back to Sonnet pricing rather than $0 — a visibly-wrong number is
  // more useful than a silently-wrong zero, and nudges the user to declare
  // proper pricing for their custom model.
  const p =
    resolvePricing(model) ??
    resolvePricing("claude-sonnet-4") ??
    MODEL_PRICING["claude-sonnet-4"]!;
  return (
    (inputTokens / 1_000_000) * p.input +
    (outputTokens / 1_000_000) * p.output +
    (cacheRead / 1_000_000) * (p.cacheRead ?? 0) +
    (cacheWrite / 1_000_000) * (p.cacheWrite ?? 0)
  );
}

function usagePath(ctxDir: CtxDirectory): string {
  return join(ctxDir.path, "usage.jsonl");
}

function appendLine(path: string, obj: object): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(obj) + "\n");
}

/** Record a model call. Returns the cost so callers can display it. */
export function recordCall(
  ctxDir: CtxDirectory,
  op: UsageOperation,
  model: string,
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
): CallRecord {
  const cost = calculateCost(
    model,
    tokens.input,
    tokens.output,
    tokens.cacheRead ?? 0,
    tokens.cacheWrite ?? 0
  );
  const record: CallRecord = {
    ts: new Date().toISOString(),
    kind: "call",
    op,
    model,
    in: tokens.input,
    out: tokens.output,
    ...(tokens.cacheRead ? { cacheRead: tokens.cacheRead } : {}),
    ...(tokens.cacheWrite ? { cacheWrite: tokens.cacheWrite } : {}),
    cost,
  };
  appendLine(usagePath(ctxDir), record);
  return record;
}

/** Record a wiki state snapshot. Call after ingest/sync. */
export function recordSnapshot(
  ctxDir: CtxDirectory,
  snapshot: { sourceDocs: number; wikiPages: number; bytes: number }
): SnapshotRecord {
  const record: SnapshotRecord = {
    ts: new Date().toISOString(),
    kind: "snapshot",
    ...snapshot,
  };
  appendLine(usagePath(ctxDir), record);
  return record;
}

/**
 * Record a whole-run refresh summary. Call once at the end of a
 * successful (or failed) ingest/sync so `ctx history` has a single
 * entry per run instead of having to reconstruct the run from
 * per-call records.
 */
export function recordRefresh(
  ctxDir: CtxDirectory,
  refresh: Omit<RefreshRecord, "ts" | "kind">
): RefreshRecord {
  const record: RefreshRecord = {
    ts: new Date().toISOString(),
    kind: "refresh",
    ...refresh,
  };
  appendLine(usagePath(ctxDir), record);
  return record;
}

/** Read all usage records. Returns [] if file is missing. */
export function readUsage(ctxDir: CtxDirectory): UsageRecord[] {
  const path = usagePath(ctxDir);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n");
  const records: UsageRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as UsageRecord);
    } catch {
      // Skip corrupt lines — JSONL is resilient by design
    }
  }
  return records;
}

export function getCalls(records: UsageRecord[]): CallRecord[] {
  return records.filter((r): r is CallRecord => r.kind === "call");
}

export function getSnapshots(records: UsageRecord[]): SnapshotRecord[] {
  return records.filter((r): r is SnapshotRecord => r.kind === "snapshot");
}

export function getRefreshes(records: UsageRecord[]): RefreshRecord[] {
  return records.filter((r): r is RefreshRecord => r.kind === "refresh");
}

/** Most recent refresh record, or null if none yet. */
export function getLastRefresh(records: UsageRecord[]): RefreshRecord | null {
  const refreshes = getRefreshes(records);
  if (refreshes.length === 0) return null;
  return refreshes[refreshes.length - 1] ?? null;
}
