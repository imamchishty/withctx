import { describe, it, expect } from "vitest";
import { __internals } from "../src/cli/commands/completion.js";

const { bashScript, zshScript, fishScript, CORE_COMMANDS, POWER_COMMANDS } = __internals;

describe("completion — command coverage", () => {
  it("lists setup, query, chat, sync in the core set", () => {
    const names = CORE_COMMANDS.map((c) => c.name);
    expect(names).toContain("setup");
    expect(names).toContain("query");
    expect(names).toContain("chat");
    expect(names).toContain("sync");
    expect(names).toContain("help");
  });

  it("keeps power commands separate from core", () => {
    const coreNames = new Set(CORE_COMMANDS.map((c) => c.name));
    const powerNames = new Set(POWER_COMMANDS.map((c) => c.name));
    // No overlap — every command lives in exactly one bucket.
    for (const n of coreNames) expect(powerNames.has(n)).toBe(false);
  });
});

describe("completion — bash script", () => {
  const script = bashScript();
  it("is valid bash function syntax (rough shape)", () => {
    expect(script).toContain("_ctx_complete()");
    expect(script).toContain("complete -F _ctx_complete ctx");
    expect(script).toContain("COMPREPLY=");
  });
  it("mentions every command name", () => {
    for (const cmd of [...CORE_COMMANDS, ...POWER_COMMANDS]) {
      expect(script).toContain(cmd.name);
    }
  });
  it("includes global flags", () => {
    expect(script).toContain("--help");
    expect(script).toContain("--json");
  });
});

describe("completion — zsh script", () => {
  const script = zshScript();
  it("starts with #compdef ctx", () => {
    expect(script.startsWith("#compdef ctx")).toBe(true);
  });
  it("uses _describe for both command buckets", () => {
    expect(script).toContain("_describe -t core-commands");
    expect(script).toContain("_describe -t power-commands");
  });
  it("mentions every command", () => {
    for (const cmd of [...CORE_COMMANDS, ...POWER_COMMANDS]) {
      expect(script).toContain(cmd.name);
    }
  });
  it("every command line uses the name:description shape", () => {
    // _describe expects 'name:description' — no unescaped colons in
    // the description half would break zsh completion with a silent
    // "no such command" error.
    // Filter to the command-entry lines specifically — skip the
    // `_arguments` state-transition lines like `'1: :->cmd'` which
    // legitimately have multiple colons and aren't command entries.
    const lines = script
      .split("\n")
      .filter((l) => l.trim().startsWith("'"))
      .filter((l) => !l.includes("->"))
      .filter((l) => !l.includes("["));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const unescaped = line.replace(/\\:/g, "");
      const colons = (unescaped.match(/:/g) ?? []).length;
      expect(colons).toBe(1);
    }
  });
});

describe("completion — fish script", () => {
  const script = fishScript();
  it("disables file completion at the top level", () => {
    expect(script).toContain("complete -c ctx -f");
  });
  it("emits a `complete -c ctx` line for every command", () => {
    for (const cmd of [...CORE_COMMANDS, ...POWER_COMMANDS]) {
      expect(script).toContain(`-a "${cmd.name}"`);
    }
  });
  it("emits long-flag completions for global flags", () => {
    expect(script).toContain("-l json");
    expect(script).toContain("-l help");
  });
});
