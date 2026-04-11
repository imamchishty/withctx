import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { CtxDirectory } from "../src/storage/ctx-dir.js";
import { recordRefresh } from "../src/usage/recorder.js";
import {
  detectActor,
  detectTrigger,
  readLastRefresh,
} from "../src/usage/refresh-context.js";

describe("refresh-context helpers", () => {
  let projectRoot: string;
  let ctxDir: CtxDirectory;

  beforeEach(() => {
    projectRoot = join(tmpdir(), `withctx-refresh-${randomUUID()}`);
    mkdirSync(projectRoot, { recursive: true });
    ctxDir = new CtxDirectory(projectRoot);
    ctxDir.initialize();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_WORKFLOW;
    delete process.env.GITHUB_EVENT_NAME;
  });

  describe("detectActor", () => {
    it("returns ci:<workflow> when running under GitHub Actions", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_WORKFLOW = "refresh-wiki";
      expect(detectActor()).toBe("ci:refresh-wiki");
    });

    it("falls back to ci:unknown when workflow name is missing", () => {
      process.env.GITHUB_ACTIONS = "true";
      delete process.env.GITHUB_WORKFLOW;
      expect(detectActor()).toBe("ci:unknown");
    });

    it("returns user@host for local runs", () => {
      delete process.env.GITHUB_ACTIONS;
      const actor = detectActor();
      expect(actor).toMatch(/@/);
      expect(actor.startsWith("ci:")).toBe(false);
    });
  });

  describe("detectTrigger", () => {
    afterEach(() => {
      delete process.env.GITHUB_ACTIONS;
      delete process.env.GITHUB_EVENT_NAME;
    });

    it("classifies CI events by GITHUB_EVENT_NAME", () => {
      process.env.GITHUB_ACTIONS = "true";
      process.env.GITHUB_EVENT_NAME = "schedule";
      expect(detectTrigger("sync", false)).toBe("schedule");

      process.env.GITHUB_EVENT_NAME = "push";
      expect(detectTrigger("sync", false)).toBe("push");

      process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
      expect(detectTrigger("sync", false)).toBe("manual");
    });

    it("returns 'force' when forced, regardless of command", () => {
      expect(detectTrigger("sync", true)).toBe("force");
      expect(detectTrigger("ingest", true)).toBe("force");
      expect(detectTrigger("setup", true)).toBe("force");
    });

    it("maps sync/setup commands to their own trigger names locally", () => {
      delete process.env.GITHUB_ACTIONS;
      expect(detectTrigger("sync", false)).toBe("sync");
      expect(detectTrigger("setup", false)).toBe("setup");
      expect(detectTrigger("ingest", false)).toBe("setup");
    });
  });

  describe("readLastRefresh", () => {
    it("returns null when no refreshes exist", () => {
      expect(readLastRefresh(ctxDir)).toBeNull();
    });

    it("returns the most recent refresh", () => {
      recordRefresh(ctxDir, {
        actor: "first",
        trigger: "sync",
        forced: false,
        model: "claude-sonnet-4",
        tokens: { input: 1, output: 1 },
        cost: 0.01,
        pages: { added: 0, changed: 0, removed: 0 },
        duration_ms: 100,
        success: true,
        error: null,
      });
      recordRefresh(ctxDir, {
        actor: "second",
        trigger: "sync",
        forced: false,
        model: "claude-sonnet-4",
        tokens: { input: 2, output: 2 },
        cost: 0.02,
        pages: { added: 1, changed: 0, removed: 0 },
        duration_ms: 200,
        success: true,
        error: null,
      });

      const last = readLastRefresh(ctxDir);
      expect(last).not.toBeNull();
      expect(last!.actor).toBe("second");
      expect(last!.cost).toBeCloseTo(0.02);
    });
  });
});
