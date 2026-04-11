import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CtxDirectory } from "../src/storage/ctx-dir.js";
import {
  recordCall,
  recordSnapshot,
  recordRefresh,
  readUsage,
  getCalls,
  getSnapshots,
  getRefreshes,
  getLastRefresh,
  calculateCost,
  setCustomPricing,
  resolvePricing,
  MODEL_PRICING,
} from "../src/usage/recorder.js";

describe("usage recorder", () => {
  let projectRoot: string;
  let ctxDir: CtxDirectory;

  beforeEach(() => {
    projectRoot = join(tmpdir(), `withctx-usage-${randomUUID()}`);
    mkdirSync(projectRoot, { recursive: true });
    ctxDir = new CtxDirectory(projectRoot);
    ctxDir.initialize();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe("calculateCost", () => {
    it("computes input + output cost from per-million pricing", () => {
      // Sonnet: $3 / 1M input, $15 / 1M output
      const cost = calculateCost("claude-sonnet-4", 1_000_000, 100_000);
      // 1M * $3 + 100k * $15 = 3 + 1.5 = 4.5
      expect(cost).toBeCloseTo(4.5, 5);
    });

    it("includes cache read and write costs", () => {
      const cost = calculateCost("claude-sonnet-4", 0, 0, 1_000_000, 1_000_000);
      // 1M cache read * $0.30 + 1M cache write * $3.75 = 4.05
      expect(cost).toBeCloseTo(4.05, 5);
    });

    it("falls back to sonnet pricing for unknown models", () => {
      const known = calculateCost("claude-sonnet-4", 1_000_000, 0);
      const unknown = calculateCost("totally-fake-model", 1_000_000, 0);
      expect(unknown).toBe(known);
    });

    it("has cache pricing in MODEL_PRICING for sonnet, opus and haiku", () => {
      expect(MODEL_PRICING["claude-sonnet-4"].cacheRead).toBeGreaterThan(0);
      expect(MODEL_PRICING["claude-opus-4"].cacheRead).toBeGreaterThan(0);
      expect(MODEL_PRICING["claude-haiku-3.5"].cacheRead).toBeGreaterThan(0);
    });
  });

  describe("recordCall", () => {
    it("appends a call record to .ctx/usage.jsonl", () => {
      const rec = recordCall(ctxDir, "ingest", "claude-sonnet-4", {
        input: 1000,
        output: 500,
      });
      expect(rec.kind).toBe("call");
      expect(rec.op).toBe("ingest");
      expect(rec.in).toBe(1000);
      expect(rec.out).toBe(500);
      expect(rec.cost).toBeGreaterThan(0);

      const path = join(ctxDir.path, "usage.jsonl");
      expect(existsSync(path)).toBe(true);
      const lines = readFileSync(path, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).op).toBe("ingest");
    });

    it("appends multiple records (one line each)", () => {
      recordCall(ctxDir, "ingest", "claude-sonnet-4", { input: 100, output: 50 });
      recordCall(ctxDir, "query", "claude-sonnet-4", { input: 200, output: 100 });
      recordCall(ctxDir, "sync", "claude-sonnet-4", { input: 300, output: 150 });

      const records = readUsage(ctxDir);
      expect(records).toHaveLength(3);
      const calls = getCalls(records);
      expect(calls.map((c) => c.op)).toEqual(["ingest", "query", "sync"]);
    });

    it("only emits cacheRead/cacheWrite fields when non-zero", () => {
      const rec = recordCall(ctxDir, "ingest", "claude-sonnet-4", {
        input: 100,
        output: 50,
      });
      expect(rec.cacheRead).toBeUndefined();
      expect(rec.cacheWrite).toBeUndefined();

      const recWithCache = recordCall(ctxDir, "ingest", "claude-sonnet-4", {
        input: 100,
        output: 50,
        cacheRead: 1000,
      });
      expect(recWithCache.cacheRead).toBe(1000);
    });
  });

  describe("recordSnapshot", () => {
    it("appends a snapshot record to .ctx/usage.jsonl", () => {
      const rec = recordSnapshot(ctxDir, {
        sourceDocs: 47,
        wikiPages: 12,
        bytes: 24576,
      });
      expect(rec.kind).toBe("snapshot");
      expect(rec.sourceDocs).toBe(47);
      expect(rec.wikiPages).toBe(12);
      expect(rec.bytes).toBe(24576);
    });

    it("interleaves snapshots with calls in order", () => {
      recordCall(ctxDir, "ingest", "claude-sonnet-4", { input: 100, output: 50 });
      recordSnapshot(ctxDir, { sourceDocs: 10, wikiPages: 3, bytes: 1024 });
      recordCall(ctxDir, "sync", "claude-sonnet-4", { input: 200, output: 100 });
      recordSnapshot(ctxDir, { sourceDocs: 12, wikiPages: 4, bytes: 2048 });

      const records = readUsage(ctxDir);
      expect(records.map((r) => r.kind)).toEqual([
        "call",
        "snapshot",
        "call",
        "snapshot",
      ]);
      expect(getCalls(records)).toHaveLength(2);
      expect(getSnapshots(records)).toHaveLength(2);
    });
  });

  describe("custom pricing (ai.pricing override)", () => {
    afterEach(() => {
      // Clear the global custom-pricing map so one test doesn't poison another.
      setCustomPricing({});
    });

    it("resolvePricing returns null for unknown models by default", () => {
      setCustomPricing({});
      expect(resolvePricing("totally-made-up-model")).toBeNull();
    });

    it("resolvePricing returns built-in entries without custom pricing", () => {
      setCustomPricing({});
      const sonnet = resolvePricing("claude-sonnet-4");
      expect(sonnet).not.toBeNull();
      expect(sonnet!.input).toBe(3);
      expect(sonnet!.output).toBe(15);
    });

    it("custom pricing is used when declared", () => {
      setCustomPricing({
        "our-private-llama-3": { input: 0.1, output: 0.4 },
      });
      const priv = resolvePricing("our-private-llama-3");
      expect(priv).toEqual({ input: 0.1, output: 0.4 });
    });

    it("custom pricing overrides built-in entries", () => {
      setCustomPricing({
        "claude-sonnet-4": { input: 2.5, output: 12 }, // negotiated rate
      });
      const sonnet = resolvePricing("claude-sonnet-4");
      expect(sonnet).toEqual({ input: 2.5, output: 12 });
    });

    it("calculateCost uses custom pricing end-to-end", () => {
      setCustomPricing({
        "my-core42-model": { input: 1, output: 5 },
      });
      // 1M input * $1 + 1M output * $5 = $6
      const cost = calculateCost("my-core42-model", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(6, 5);
    });

    it("unknown model with no custom pricing still returns non-zero (sonnet fallback)", () => {
      setCustomPricing({});
      const cost = calculateCost("mystery-model", 1_000_000, 1_000_000);
      expect(cost).toBeGreaterThan(0);
    });
  });

  describe("recordRefresh (refresh journal)", () => {
    it("appends a refresh record with all fields", () => {
      const rec = recordRefresh(ctxDir, {
        actor: "alice@laptop",
        trigger: "sync",
        forced: false,
        model: "claude-sonnet-4",
        tokens: { input: 12_000, output: 4_000 },
        cost: 0.1,
        pages: { added: 1, changed: 2, removed: 0 },
        duration_ms: 1234,
        success: true,
        error: null,
      });

      expect(rec.kind).toBe("refresh");
      expect(rec.actor).toBe("alice@laptop");
      expect(rec.tokens.input).toBe(12_000);
      expect(rec.pages.changed).toBe(2);

      const records = readUsage(ctxDir);
      expect(getRefreshes(records)).toHaveLength(1);
    });

    it("records failed refreshes with an error message", () => {
      recordRefresh(ctxDir, {
        actor: "ci:withctx",
        trigger: "schedule",
        forced: false,
        model: "claude-sonnet-4",
        tokens: { input: 0, output: 0 },
        cost: 0,
        pages: { added: 0, changed: 0, removed: 0 },
        duration_ms: 42,
        success: false,
        error: "JIRA_TOKEN not set",
      });

      const refreshes = getRefreshes(readUsage(ctxDir));
      expect(refreshes).toHaveLength(1);
      expect(refreshes[0].success).toBe(false);
      expect(refreshes[0].error).toBe("JIRA_TOKEN not set");
    });

    it("getLastRefresh returns the most recent record", () => {
      recordRefresh(ctxDir, {
        actor: "a",
        trigger: "sync",
        forced: false,
        model: "m",
        tokens: { input: 1, output: 1 },
        cost: 0,
        pages: { added: 0, changed: 0, removed: 0 },
        duration_ms: 1,
        success: true,
        error: null,
      });
      recordRefresh(ctxDir, {
        actor: "b",
        trigger: "force",
        forced: true,
        model: "m",
        tokens: { input: 1, output: 1 },
        cost: 0,
        pages: { added: 0, changed: 0, removed: 0 },
        duration_ms: 1,
        success: true,
        error: null,
      });

      const last = getLastRefresh(readUsage(ctxDir));
      expect(last).not.toBeNull();
      expect(last!.actor).toBe("b");
      expect(last!.forced).toBe(true);
    });

    it("getLastRefresh returns null when no refreshes exist", () => {
      recordCall(ctxDir, "ingest", "claude-sonnet-4", { input: 10, output: 5 });
      const last = getLastRefresh(readUsage(ctxDir));
      expect(last).toBeNull();
    });
  });

  describe("readUsage", () => {
    it("returns empty array when no usage.jsonl exists", () => {
      expect(readUsage(ctxDir)).toEqual([]);
    });

    it("skips corrupt JSONL lines without throwing", () => {
      const path = join(ctxDir.path, "usage.jsonl");
      writeFileSync(
        path,
        [
          JSON.stringify({ ts: "2026-04-10T00:00:00Z", kind: "call", op: "ingest", model: "claude-sonnet-4", in: 100, out: 50, cost: 0.001 }),
          "{not json{",
          JSON.stringify({ ts: "2026-04-10T00:00:01Z", kind: "call", op: "query", model: "claude-sonnet-4", in: 200, out: 100, cost: 0.002 }),
          "",
        ].join("\n") + "\n"
      );
      const records = readUsage(ctxDir);
      expect(records).toHaveLength(2);
      expect(getCalls(records).map((c) => c.op)).toEqual(["ingest", "query"]);
    });
  });
});
