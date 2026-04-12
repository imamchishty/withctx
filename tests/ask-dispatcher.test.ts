import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  rewriteAskArgs,
  applyAskRewrite,
  formatAskHelp,
  isAskHelpRequest,
} from "../src/cli/ask-dispatcher.js";

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

// ── Help-path short-circuit ─────────────────────────────────────────
//
// Regression coverage for two user-reported bugs:
//   1. `ctx ask --help` printed the 12-verb core help grid instead of
//      ask-specific usage, because the root program overrides
//      Commander's formatHelp and the override cascaded to subcommands.
//   2. `ctx ask` with no args errored with "missing required argument
//      'question'", leaking the internal `query` command name to
//      users who were trying to discover the verb.
//
// Fix: applyAskRewrite detects the help path and prints formatAskHelp
// directly, then exits 0. These tests cover the detection logic plus
// the exit-path integration.

describe("isAskHelpRequest", () => {
  it("treats an empty tail as a help request (bare `ctx ask`)", () => {
    expect(isAskHelpRequest([])).toBe(true);
  });

  it("detects --help", () => {
    expect(isAskHelpRequest(["--help"])).toBe(true);
    expect(isAskHelpRequest(["foo", "--help"])).toBe(true);
  });

  it("detects -h", () => {
    expect(isAskHelpRequest(["-h"])).toBe(true);
    expect(isAskHelpRequest(["foo", "-h"])).toBe(true);
  });

  it("does not treat a normal question as a help request", () => {
    expect(isAskHelpRequest(["how does auth work?"])).toBe(false);
    expect(isAskHelpRequest(["--chat"])).toBe(false);
    expect(isAskHelpRequest(["--json", "question"])).toBe(false);
  });
});

describe("formatAskHelp", () => {
  const help = formatAskHelp();

  it("mentions the primary usage form first", () => {
    expect(help).toContain("ctx ask \"<question>\"");
  });

  it("documents every mode flag", () => {
    expect(help).toContain("--chat");
    expect(help).toContain("--search");
    expect(help).toContain("--grep");
    expect(help).toContain("--who");
    expect(help).toContain("--json");
  });

  it("does NOT mention the internal `query` verb name", () => {
    // Leaking the internal verb was the original UX bug — make sure
    // we never regress by accidentally reintroducing it in the help.
    expect(help).not.toMatch(/\bctx query\b/);
  });

  it("references the core help for further reading", () => {
    expect(help).toContain("ctx help");
  });
});

describe("applyAskRewrite — help-path short circuit", () => {
  let originalArgv: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalArgv = process.argv.slice();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      // Throw instead of actually exiting so we can assert.
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  const writtenBlob = (): string => {
    const calls = stdoutSpy.mock.calls as unknown as Array<[string]>;
    return calls.map((c) => c[0]).join("");
  };

  it("prints ask-specific help on `ctx ask --help` and exits 0", () => {
    const argv = ["/usr/bin/node", "/app/ctx", "ask", "--help"];
    expect(() => applyAskRewrite(argv)).toThrow(/process\.exit\(0\)/);
    const out = writtenBlob();
    expect(out).toContain("ctx ask");
    expect(out).not.toContain("missing required argument");
    expect(out).not.toContain("Start"); // the 12-verb grid heading
  });

  it("prints ask-specific help on `ctx ask -h` and exits 0", () => {
    const argv = ["/usr/bin/node", "/app/ctx", "ask", "-h"];
    expect(() => applyAskRewrite(argv)).toThrow(/process\.exit\(0\)/);
    expect(writtenBlob()).toContain("ctx ask");
  });

  it("prints ask-specific help on bare `ctx ask` (no args) and exits 0", () => {
    const argv = ["/usr/bin/node", "/app/ctx", "ask"];
    expect(() => applyAskRewrite(argv)).toThrow(/process\.exit\(0\)/);
    const out = writtenBlob();
    expect(out).toContain("USAGE");
    // Must NOT leak the internal `query` command name.
    expect(out).not.toMatch(/missing required argument/i);
    expect(out).not.toMatch(/\bctx query\b/);
  });

  it("still rewrites a real question and does NOT print help", () => {
    const argv = ["/usr/bin/node", "/app/ctx", "ask", "how does auth work?"];
    applyAskRewrite(argv); // should not throw
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(argv).toEqual([
      "/usr/bin/node",
      "/app/ctx",
      "query",
      "how does auth work?",
    ]);
  });
});
