import { describe, it, expect } from "vitest";
import { checkRefreshPolicy } from "../src/config/refresh-policy.js";
import type { CtxConfig } from "../src/types/config.js";

function cfg(overrides: Partial<CtxConfig> = {}): CtxConfig {
  return {
    project: "test",
    ...overrides,
  } as CtxConfig;
}

describe("checkRefreshPolicy", () => {
  it("allows refresh when config is null", () => {
    const result = checkRefreshPolicy(null, "sync");
    expect(result.allowed).toBe(true);
  });

  it("allows refresh when refreshed_by is unset (the default)", () => {
    const result = checkRefreshPolicy(cfg(), "sync");
    expect(result.allowed).toBe(true);
  });

  it("allows refresh when refreshed_by is explicitly local", () => {
    const result = checkRefreshPolicy(cfg({ refreshed_by: "local" }), "sync");
    expect(result.allowed).toBe(true);
  });

  it("blocks refresh when refreshed_by is ci", () => {
    const result = checkRefreshPolicy(cfg({ refreshed_by: "ci" }), "sync");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("refreshed by CI");
    expect(result.reason).toContain("--allow-local-refresh");
  });

  it("unblocks when allowLocalRefresh is true, even on ci wiki", () => {
    const result = checkRefreshPolicy(
      cfg({ refreshed_by: "ci" }),
      "sync",
      { allowLocalRefresh: true }
    );
    expect(result.allowed).toBe(true);
  });

  it("includes the command name in the reason so users can copy-paste", () => {
    const result = checkRefreshPolicy(cfg({ refreshed_by: "ci" }), "ingest");
    expect(result.reason).toContain("ctx ingest");
  });

  it("allowLocalRefresh is a no-op on non-ci wikis", () => {
    const result = checkRefreshPolicy(
      cfg({ refreshed_by: "local" }),
      "sync",
      { allowLocalRefresh: true }
    );
    expect(result.allowed).toBe(true);
  });
});
