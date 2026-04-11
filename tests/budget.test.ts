import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CtxDirectory } from "../src/storage/ctx-dir.js";
import { recordCall } from "../src/usage/recorder.js";
import {
  assertWithinBudget,
  BudgetExceededError,
  currentMonthSpend,
  getBudgetStatus,
  checkBudgetWarning,
} from "../src/usage/budget.js";
import type { CtxConfig } from "../src/types/config.js";

function makeTempCtxDir(): { dir: string; ctxDir: CtxDirectory } {
  const dir = mkdtempSync(join(tmpdir(), "ctx-budget-test-"));
  mkdirSync(join(dir, ".ctx"), { recursive: true });
  const ctxDir = new CtxDirectory(dir);
  return { dir, ctxDir };
}

function makeConfig(budget?: number): CtxConfig {
  return {
    project: "test",
    version: "1.4",
    costs: budget !== undefined
      ? { budget, alert_at: 80, model: "claude-sonnet-4" }
      : undefined,
  } as CtxConfig;
}

describe("currentMonthSpend", () => {
  let dir: string;
  let ctxDir: CtxDirectory;
  beforeEach(() => {
    ({ dir, ctxDir } = makeTempCtxDir());
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CTX_IGNORE_BUDGET;
  });

  it("returns 0 for empty usage", () => {
    expect(currentMonthSpend(ctxDir)).toBe(0);
  });

  it("sums call costs for the current calendar month", () => {
    recordCall(ctxDir, "query", "claude-sonnet-4", {
      input: 1_000_000,
      output: 500_000,
    });
    // 1M * 3/M + 0.5M * 15/M = 3 + 7.5 = 10.50
    expect(currentMonthSpend(ctxDir)).toBeCloseTo(10.5, 2);
  });

  it("skips records outside the current calendar month", () => {
    // Hand-craft an old record by appending to usage.jsonl directly.
    const old = {
      ts: "2020-01-15T12:00:00.000Z",
      kind: "call",
      op: "query",
      model: "claude-sonnet-4",
      in: 1_000_000,
      out: 1_000_000,
      cost: 18.0,
    };
    const path = join(dir, ".ctx", "usage.jsonl");
    writeFileSync(path, JSON.stringify(old) + "\n");

    // And a current-month record.
    recordCall(ctxDir, "query", "claude-sonnet-4", {
      input: 100_000,
      output: 50_000,
    });
    // Old record excluded; only the current one counted.
    expect(currentMonthSpend(ctxDir)).toBeCloseTo(0.3 + 0.75, 2);
  });
});

describe("assertWithinBudget", () => {
  let dir: string;
  let ctxDir: CtxDirectory;
  beforeEach(() => {
    ({ dir, ctxDir } = makeTempCtxDir());
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CTX_IGNORE_BUDGET;
  });

  it("is a no-op when no budget is set", () => {
    const config = makeConfig();
    expect(() => assertWithinBudget(ctxDir, config, 1000, "test")).not.toThrow();
  });

  it("passes when spend + estimated cost is under budget", () => {
    const config = makeConfig(10);
    recordCall(ctxDir, "query", "claude-sonnet-4", {
      input: 100_000,
      output: 50_000,
    });
    // Current spend ≈ $1.05, adding $0.50 is still < $10.
    expect(() => assertWithinBudget(ctxDir, config, 0.5, "test")).not.toThrow();
  });

  it("throws BudgetExceededError when budget would be exceeded", () => {
    const config = makeConfig(5);
    recordCall(ctxDir, "query", "claude-sonnet-4", {
      input: 1_000_000,
      output: 500_000,
    });
    // Current spend ≈ $10.50 already > $5 budget.
    expect(() => assertWithinBudget(ctxDir, config, 0.01, "test")).toThrow(BudgetExceededError);
  });

  it("respects CTX_IGNORE_BUDGET=1 env escape hatch", () => {
    const config = makeConfig(0.01);
    recordCall(ctxDir, "query", "claude-sonnet-4", {
      input: 1_000_000,
      output: 1_000_000,
    });
    process.env.CTX_IGNORE_BUDGET = "1";
    expect(() => assertWithinBudget(ctxDir, config, 1000, "test")).not.toThrow();
  });

  it("includes actionable options in the error message", () => {
    const config = makeConfig(1);
    try {
      recordCall(ctxDir, "query", "claude-sonnet-4", {
        input: 1_000_000,
        output: 0,
      });
      assertWithinBudget(ctxDir, config, 0.01, "ctx query");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      const msg = (err as Error).message;
      expect(msg).toContain("Monthly budget exceeded");
      expect(msg).toContain("ctx.yaml");
      expect(msg).toContain("CTX_IGNORE_BUDGET");
    }
  });
});

describe("getBudgetStatus", () => {
  let dir: string;
  let ctxDir: CtxDirectory;
  beforeEach(() => {
    ({ dir, ctxDir } = makeTempCtxDir());
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a fraction when a budget is set", () => {
    const config = makeConfig(10);
    recordCall(ctxDir, "query", "claude-sonnet-4", {
      input: 1_000_000,
      output: 500_000,
    });
    const status = getBudgetStatus(ctxDir, config);
    expect(status.budget).toBe(10);
    expect(status.monthSpend).toBeCloseTo(10.5, 2);
    expect(status.fraction).toBeCloseTo(1.05, 2);
    expect(status.summary).toContain("$10.50 / $10.00");
  });

  it("reports null fraction when no budget is set", () => {
    const config = makeConfig();
    const status = getBudgetStatus(ctxDir, config);
    expect(status.budget).toBeNull();
    expect(status.fraction).toBeNull();
    expect(status.summary).toContain("no budget set");
  });
});

describe("checkBudgetWarning", () => {
  let dir: string;
  let ctxDir: CtxDirectory;
  beforeEach(() => {
    ({ dir, ctxDir } = makeTempCtxDir());
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no budget is set", () => {
    expect(checkBudgetWarning(ctxDir, makeConfig(), 10)).toBeNull();
  });

  it("returns null when well under alert threshold", () => {
    const config = makeConfig(100);
    // No prior spend, adding $5 → 5% used → below 80% alert
    expect(checkBudgetWarning(ctxDir, config, 5)).toBeNull();
  });

  it("returns a warning when would cross alert threshold", () => {
    const config = makeConfig(10);
    recordCall(ctxDir, "query", "claude-sonnet-4", {
      input: 2_500_000,
      output: 50_000,
    });
    // 2.5M * 3/M + 0.05M * 15/M = 7.5 + 0.75 = $8.25
    // Adding $0.50 → $8.75 → 87.5% of $10 → warn
    const warning = checkBudgetWarning(ctxDir, config, 0.5);
    expect(warning).toContain("month-to-date");
    expect(warning).toContain("$10.00");
  });
});
