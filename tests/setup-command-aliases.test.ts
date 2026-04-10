import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerGoCommand } from "../src/cli/commands/go.js";

/**
 * Regression test for the init/go → setup merge.
 *
 * Before this commit there were THREE separate setup commands:
 *   - ctx init   (src/cli/commands/init.ts)
 *   - ctx setup  (src/cli/commands/setup.ts — interactive wizard)
 *   - ctx go     (src/cli/commands/go.ts — init + ingest)
 *
 * 1,342 lines across three files doing overlapping work is the reason
 * a user sat down at their work laptop and couldn't figure out how to
 * start. So we collapsed them: `ctx setup` is the only setup command,
 * `ctx init` and `ctx go` are commander aliases pointing at the same
 * action.
 *
 * This test pins that down. If a future change accidentally:
 *   - removes one of the aliases
 *   - renames the primary command
 *   - resurrects a separate init or setup command
 * it will fail here.
 */

describe("setup command aliases (init/go merge regression)", () => {
  it("registers a 'setup' command with 'init' and 'go' as aliases", () => {
    const program = new Command();
    registerGoCommand(program);

    const setup = program.commands.find((c) => c.name() === "setup");
    expect(setup, "setup command should be registered").toBeDefined();

    const aliases = setup!.aliases();
    expect(aliases).toContain("init");
    expect(aliases).toContain("go");
  });

  it("only registers ONE setup-style command (not three)", () => {
    const program = new Command();
    registerGoCommand(program);

    // After the merge there should be exactly one command whose name or
    // aliases include any of setup/init/go. Three separate commands
    // would be the regression we're guarding against.
    const setupish = program.commands.filter((c) => {
      const names = [c.name(), ...c.aliases()];
      return names.some((n) => ["setup", "init", "go"].includes(n));
    });
    expect(setupish).toHaveLength(1);
  });

  it("exposes all expected options", () => {
    const program = new Command();
    registerGoCommand(program);

    const setup = program.commands.find((c) => c.name() === "setup")!;
    const flags = setup.options.map((o) => o.long);

    // These options are the union of what old init.ts and old go.ts
    // each supported individually, plus the sibling-repo scan flags
    // added in the scan-repos follow-up. The merge must preserve all.
    expect(flags).toContain("--name");
    expect(flags).toContain("--with");
    expect(flags).toContain("--org");
    expect(flags).toContain("--token");
    expect(flags).toContain("--no-ingest");
    expect(flags).toContain("--scan");
    expect(flags).toContain("--no-scan");
    expect(flags).toContain("--yes");
  });

  it("has a description that mentions what the command does", () => {
    const program = new Command();
    registerGoCommand(program);

    const setup = program.commands.find((c) => c.name() === "setup")!;
    // The description should give a new user enough signal to know
    // this is the right command. Loose match so we don't over-specify.
    expect(setup.description().toLowerCase()).toMatch(/set up|setup|detect|compile|wiki/);
  });
});
