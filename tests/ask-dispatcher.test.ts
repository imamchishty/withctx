import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rewriteAskArgs, applyAskRewrite } from "../src/cli/ask-dispatcher.js";

// ── rewriteAskArgs: pure function, easy to unit test ──────────────────

describe("rewriteAskArgs", () => {
  it("returns null when the first arg is not `ask`", () => {
    expect(rewriteAskArgs([])).toBeNull();
    expect(rewriteAskArgs(["setup"])).toBeNull();
    expect(rewriteAskArgs(["sync", "--watch"])).toBeNull();
    expect(rewriteAskArgs(["status"])).toBeNull();
  });

  it("rewrites `ask \"question\"` to `query \"question\"` (default mode)", () => {
    const result = rewriteAskArgs(["ask", "how does auth work?"]);
    expect(result).toEqual({
      args: ["query", "how does auth work?"],
      mode: "query",
    });
  });

  it("forwards the --continue flag to the query command", () => {
    const result = rewriteAskArgs(["ask", "follow up", "--continue"]);
    expect(result?.args).toEqual(["query", "follow up", "--continue"]);
    expect(result?.mode).toBe("query");
  });

  it("forwards the --json flag to the query command", () => {
    const result = rewriteAskArgs(["ask", "list deps", "--json"]);
    expect(result?.args).toEqual(["query", "list deps", "--json"]);
  });

  it("rewrites `ask --chat` to `chat`", () => {
    const result = rewriteAskArgs(["ask", "--chat"]);
    expect(result).toEqual({
      args: ["chat"],
      mode: "chat",
    });
  });

  it("strips the --chat flag when rewriting to chat", () => {
    const result = rewriteAskArgs(["ask", "--chat", "--resume"]);
    expect(result?.args).toEqual(["chat", "--resume"]);
  });

  it("rewrites `ask --search \"term\"` to `search \"term\"`", () => {
    const result = rewriteAskArgs(["ask", "--search", "rate limiting"]);
    expect(result).toEqual({
      args: ["search", "rate limiting"],
      mode: "search",
    });
  });

  it("forwards search-specific flags through --search mode", () => {
    const result = rewriteAskArgs([
      "ask",
      "--search",
      "deploys",
      "--limit",
      "3",
      "--json",
    ]);
    expect(result?.args).toEqual(["search", "deploys", "--limit", "3", "--json"]);
  });

  it("rewrites `ask --grep \"TODO\"` to a grep-mode search invocation", () => {
    const result = rewriteAskArgs(["ask", "--grep", "TODO"]);
    expect(result?.mode).toBe("grep");
    expect(result?.args[0]).toBe("search");
    expect(result?.args).toContain("TODO");
  });

  it("rewrites `ask --who \"payments service\"` to `who \"payments service\"`", () => {
    const result = rewriteAskArgs(["ask", "--who", "payments service"]);
    expect(result).toEqual({
      args: ["who", "payments service"],
      mode: "who",
    });
  });

  it("handles flag ordering — mode flag can come before or after positionals", () => {
    const a = rewriteAskArgs(["ask", "--search", "foo"]);
    const b = rewriteAskArgs(["ask", "foo", "--search"]);
    // Both should route to search mode; the positional comes through.
    expect(a?.mode).toBe("search");
    expect(b?.mode).toBe("search");
    expect(a?.args.includes("foo")).toBe(true);
    expect(b?.args.includes("foo")).toBe(true);
  });

  it("picks the first mode flag when multiple are passed", () => {
    // Should not throw — picks chat (the first in precedence order).
    const result = rewriteAskArgs(["ask", "--chat", "--search", "x"]);
    expect(result?.mode).toBe("chat");
  });

  it("leaves `ask` alone with no positional and no mode flag", () => {
    const result = rewriteAskArgs(["ask"]);
    expect(result).toEqual({ args: ["query"], mode: "query" });
  });
});

// ── applyAskRewrite: argv mutation hook ───────────────────────────────

describe("applyAskRewrite", () => {
  let originalArgv: string[];
  let originalMode: string | undefined;

  beforeEach(() => {
    originalArgv = process.argv.slice();
    originalMode = process.env.CTX_ASK_MODE;
    delete process.env.CTX_ASK_MODE;
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalMode === undefined) {
      delete process.env.CTX_ASK_MODE;
    } else {
      process.env.CTX_ASK_MODE = originalMode;
    }
  });

  it("is a no-op when the command is not `ask`", () => {
    const argv = ["/usr/bin/node", "/app/ctx", "sync"];
    applyAskRewrite(argv);
    expect(argv).toEqual(["/usr/bin/node", "/app/ctx", "sync"]);
    expect(process.env.CTX_ASK_MODE).toBeUndefined();
  });

  it("rewrites `ctx ask \"question\"` in place", () => {
    const argv = ["/usr/bin/node", "/app/ctx", "ask", "how does auth work?"];
    applyAskRewrite(argv);
    expect(argv).toEqual([
      "/usr/bin/node",
      "/app/ctx",
      "query",
      "how does auth work?",
    ]);
    expect(process.env.CTX_ASK_MODE).toBe("query");
  });

  it("rewrites `ctx ask --chat` to `ctx chat`", () => {
    const argv = ["/usr/bin/node", "/app/ctx", "ask", "--chat"];
    applyAskRewrite(argv);
    expect(argv).toEqual(["/usr/bin/node", "/app/ctx", "chat"]);
    expect(process.env.CTX_ASK_MODE).toBe("chat");
  });

  it("sets CTX_ASK_MODE to the resolved mode for downstream introspection", () => {
    const argv = ["/usr/bin/node", "/app/ctx", "ask", "--search", "deploys"];
    applyAskRewrite(argv);
    expect(process.env.CTX_ASK_MODE).toBe("search");
    expect(argv).toEqual([
      "/usr/bin/node",
      "/app/ctx",
      "search",
      "deploys",
    ]);
  });

  it("leaves CTX_ASK_MODE unset when no rewrite happens", () => {
    const argv = ["/usr/bin/node", "/app/ctx", "status"];
    applyAskRewrite(argv);
    expect(process.env.CTX_ASK_MODE).toBeUndefined();
  });
});
