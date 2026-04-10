import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CtxDirectory } from "../src/storage/ctx-dir.js";
import {
  recordCall,
  recordSnapshot,
  readUsage,
  getCalls,
  getSnapshots,
  calculateCost,
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
