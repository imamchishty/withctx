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

export type UsageRecord = CallRecord | SnapshotRecord;

/** Model pricing per 1M tokens (USD). */
export const MODEL_PRICING: Record<
  string,
  { input: number; output: number; cacheRead?: number; cacheWrite?: number }
> = {
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-haiku-3.5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead = 0,
  cacheWrite = 0
): number {
  const p = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4"];
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
