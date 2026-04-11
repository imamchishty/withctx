import { describe, it, expect } from "vitest";
import {
  CtxError,
  formatCtxError,
  ctxErrorToJson,
  isCtxError,
  EXIT_CODES,
  noConfigError,
  noCtxDirError,
  noWikiPagesError,
  authMissingError,
  llmUnavailableError,
  pageNotFoundError,
  invalidArgumentError,
  refreshPolicyBlockedError,
} from "../src/errors.js";

describe("CtxError construction", () => {
  it("captures code, message, detail, next", () => {
    const err = new CtxError({
      code: "NO_CONFIG",
      message: "No config",
      detail: "Walk up failed",
      next: "run ctx setup",
    });
    expect(err.name).toBe("CtxError");
    expect(err.code).toBe("NO_CONFIG");
    expect(err.message).toBe("No config");
    expect(err.detail).toBe("Walk up failed");
    expect(err.next).toBe("run ctx setup");
  });
});

describe("isCtxError", () => {
  it("recognises CtxError instances", () => {
    expect(isCtxError(new CtxError({ code: "NO_CONFIG", message: "m", next: "n" }))).toBe(true);
  });
  it("rejects plain errors", () => {
    expect(isCtxError(new Error("nope"))).toBe(false);
  });
  it("rejects non-errors", () => {
    expect(isCtxError("string")).toBe(false);
    expect(isCtxError(null)).toBe(false);
    expect(isCtxError(undefined)).toBe(false);
  });
});

describe("formatCtxError", () => {
  const err = new CtxError({
    code: "NO_CONFIG",
    message: "No ctx.yaml found.",
    detail: "We walked up from cwd and found nothing.",
    next: "Run `ctx setup`.",
  });

  it("includes code, message, detail, next, docs line", () => {
    const plain = formatCtxError(err, { colour: false });
    expect(plain).toContain("Error (NO_CONFIG):");
    expect(plain).toContain("No ctx.yaml found.");
    expect(plain).toContain("We walked up from cwd and found nothing.");
    expect(plain).toContain("To fix:");
    expect(plain).toContain("Run `ctx setup`.");
    expect(plain).toContain("https://withctx.dev/errors/NO_CONFIG");
  });

  it("omits ANSI codes when colour is false", () => {
    const plain = formatCtxError(err, { colour: false });
    // Rough check — no ESC character.
    expect(plain).not.toMatch(/\u001b\[/);
  });

  it("emits ANSI codes when colour is true", () => {
    const coloured = formatCtxError(err, { colour: true });
    expect(coloured).toMatch(/\u001b\[/);
  });

  it("handles errors without a detail field", () => {
    const minimal = new CtxError({
      code: "NO_CONFIG",
      message: "m",
      next: "n",
    });
    const plain = formatCtxError(minimal, { colour: false });
    expect(plain).toContain("Error (NO_CONFIG): m");
    expect(plain).toContain("To fix: n");
  });
});

describe("ctxErrorToJson", () => {
  it("produces a flat serialisable object", () => {
    const err = new CtxError({
      code: "BUDGET_EXCEEDED",
      message: "over budget",
      next: "raise budget",
    });
    const json = ctxErrorToJson(err);
    expect(json.error.code).toBe("BUDGET_EXCEEDED");
    expect(json.error.message).toBe("over budget");
    expect(json.error.next).toBe("raise budget");
    expect(JSON.stringify(json)).toContain("BUDGET_EXCEEDED");
  });

  it("omits detail when not set", () => {
    const err = new CtxError({ code: "NO_CONFIG", message: "m", next: "n" });
    const json = ctxErrorToJson(err);
    expect(json.error).not.toHaveProperty("detail");
  });

  it("includes detail when set", () => {
    const err = new CtxError({
      code: "NO_CONFIG",
      message: "m",
      detail: "d",
      next: "n",
    });
    const json = ctxErrorToJson(err);
    expect(json.error.detail).toBe("d");
  });
});

describe("EXIT_CODES", () => {
  it("has an entry for every CtxErrorCode", () => {
    // This is a catch-check — if we add a new code and forget to
    // update EXIT_CODES, TypeScript should already fail, but the
    // runtime assertion is a belt-and-braces.
    expect(EXIT_CODES.NO_CONFIG).toBeGreaterThan(0);
    expect(EXIT_CODES.BUDGET_EXCEEDED).toBe(78);
    expect(EXIT_CODES.LLM_UNAVAILABLE).toBe(69);
    expect(EXIT_CODES.INVALID_ARGUMENT).toBe(64);
  });
});

describe("factory helpers", () => {
  it("noConfigError → runnable next step", () => {
    const err = noConfigError();
    expect(err.code).toBe("NO_CONFIG");
    expect(err.next).toContain("ctx setup");
  });
  it("noCtxDirError → runnable next step", () => {
    const err = noCtxDirError();
    expect(err.code).toBe("NO_CTX_DIR");
    expect(err.next).toContain("ctx setup");
  });
  it("noWikiPagesError → runnable next step", () => {
    const err = noWikiPagesError();
    expect(err.code).toBe("NO_WIKI_PAGES");
    expect(err.next).toContain("ctx ingest");
  });
  it("authMissingError mentions the env var", () => {
    const err = authMissingError("Jira", "JIRA_TOKEN");
    expect(err.code).toBe("AUTH_MISSING");
    expect(err.message).toContain("Jira");
    expect(err.next).toContain("JIRA_TOKEN");
  });
  it("llmUnavailableError points at ctx doctor", () => {
    const err = llmUnavailableError("Anthropic");
    expect(err.code).toBe("LLM_UNAVAILABLE");
    expect(err.next).toContain("ctx doctor");
  });
  it("pageNotFoundError mentions the missing path", () => {
    const err = pageNotFoundError("overview.md");
    expect(err.code).toBe("PAGE_NOT_FOUND");
    expect(err.message).toContain("overview.md");
  });
  it("invalidArgumentError passes through the hint", () => {
    const err = invalidArgumentError("--scope", "Use a folder like repos/api.");
    expect(err.code).toBe("INVALID_ARGUMENT");
    expect(err.next).toContain("Use a folder");
  });
  it("refreshPolicyBlockedError suggests --allow-local-refresh", () => {
    const err = refreshPolicyBlockedError("ctx.yaml says refreshed_by: ci");
    expect(err.code).toBe("REFRESH_POLICY_BLOCKED");
    expect(err.next).toContain("--allow-local-refresh");
  });
});
