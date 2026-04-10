import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  appendSourceToConfig,
  readRawConfig,
  writeRawConfig,
} from "../src/cli/commands/sources-interactive.js";

/**
 * Regression tests for the "ctx add confluence silently does nothing"
 * class of bugs. Before this test file existed, sources-interactive.ts
 * was 806 lines of zero-coverage code that mutates the user's ctx.yaml
 * — a combination the user paid for on a real work laptop.
 *
 * What we pin down here:
 *   1. appendSourceToConfig actually writes the entry to disk.
 *   2. It works with every shape of existing `sources:` block
 *      (missing, null, populated, other-types-present).
 *   3. It is idempotent-friendly — calling it twice adds two entries,
 *      not overwriting the first.
 *   4. It doesn't clobber unrelated top-level keys (project, ai, costs).
 */

function makeTempCtxYaml(initialContent: string): {
  dir: string;
  configPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "ctx-test-"));
  const configPath = join(dir, "ctx.yaml");
  writeFileSync(configPath, initialContent);
  return {
    dir,
    configPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("appendSourceToConfig", () => {
  let fixture: ReturnType<typeof makeTempCtxYaml>;

  afterEach(() => {
    if (fixture) fixture.cleanup();
  });

  it("adds a confluence source to a minimal ctx.yaml (no sources: block)", () => {
    fixture = makeTempCtxYaml(`project: demo\n`);

    appendSourceToConfig(fixture.configPath, "confluence", {
      name: "wiki",
      base_url: "https://acme.atlassian.net/wiki",
      token: "${CONFLUENCE_TOKEN}",
    });

    // Read it back and assert the entry is actually there on disk.
    // This is the test that would have caught the original bug.
    const reloaded = parseYaml(readFileSync(fixture.configPath, "utf-8")) as {
      project: string;
      sources: { confluence: Array<{ name: string; base_url: string; token: string }> };
    };
    expect(reloaded.project).toBe("demo");
    expect(reloaded.sources.confluence).toHaveLength(1);
    expect(reloaded.sources.confluence[0]).toEqual({
      name: "wiki",
      base_url: "https://acme.atlassian.net/wiki",
      token: "${CONFLUENCE_TOKEN}",
    });
  });

  it("handles sources: null (empty block)", () => {
    fixture = makeTempCtxYaml(`project: demo\nsources:\n`);

    appendSourceToConfig(fixture.configPath, "confluence", {
      name: "wiki",
      base_url: "https://acme.atlassian.net/wiki",
      token: "${CONFLUENCE_TOKEN}",
    });

    const reloaded = parseYaml(readFileSync(fixture.configPath, "utf-8")) as {
      sources: { confluence: unknown[] };
    };
    expect(reloaded.sources.confluence).toHaveLength(1);
  });

  it("appends to an existing confluence list without clobbering earlier entries", () => {
    fixture = makeTempCtxYaml(`project: demo
sources:
  confluence:
    - name: eng-wiki
      base_url: https://acme.atlassian.net/wiki
      token: \${CONFLUENCE_TOKEN}
`);

    appendSourceToConfig(fixture.configPath, "confluence", {
      name: "ops-wiki",
      base_url: "https://acme.atlassian.net/wiki",
      token: "${CONFLUENCE_TOKEN}",
    });

    const reloaded = parseYaml(readFileSync(fixture.configPath, "utf-8")) as {
      sources: { confluence: Array<{ name: string }> };
    };
    expect(reloaded.sources.confluence).toHaveLength(2);
    expect(reloaded.sources.confluence[0].name).toBe("eng-wiki");
    expect(reloaded.sources.confluence[1].name).toBe("ops-wiki");
  });

  it("adds a new source type when other types are already present", () => {
    fixture = makeTempCtxYaml(`project: demo
sources:
  local:
    - name: docs
      path: ./docs
`);

    appendSourceToConfig(fixture.configPath, "jira", {
      name: "jira",
      base_url: "https://acme.atlassian.net",
      token: "${JIRA_TOKEN}",
    });

    const reloaded = parseYaml(readFileSync(fixture.configPath, "utf-8")) as {
      sources: {
        local: Array<{ name: string }>;
        jira: Array<{ name: string }>;
      };
    };
    expect(reloaded.sources.local).toHaveLength(1);
    expect(reloaded.sources.local[0].name).toBe("docs");
    expect(reloaded.sources.jira).toHaveLength(1);
    expect(reloaded.sources.jira[0].name).toBe("jira");
  });

  it("preserves unrelated top-level keys (project, ai, costs, access)", () => {
    fixture = makeTempCtxYaml(`project: demo
ai:
  provider: anthropic
  model: claude-sonnet-4-20250514
costs:
  budget: 50
  alert_at: 80
access:
  sensitive:
    - pattern: secret
sources:
  local:
    - name: docs
      path: ./docs
`);

    appendSourceToConfig(fixture.configPath, "github", {
      name: "gh",
      token: "${GITHUB_TOKEN}",
      owner: "acme",
    });

    const reloaded = parseYaml(readFileSync(fixture.configPath, "utf-8")) as {
      project: string;
      ai: { provider: string; model: string };
      costs: { budget: number; alert_at: number };
      access: { sensitive: Array<{ pattern: string }> };
      sources: { local: unknown[]; github: unknown[] };
    };
    expect(reloaded.project).toBe("demo");
    expect(reloaded.ai.provider).toBe("anthropic");
    expect(reloaded.ai.model).toBe("claude-sonnet-4-20250514");
    expect(reloaded.costs.budget).toBe(50);
    expect(reloaded.costs.alert_at).toBe(80);
    expect(reloaded.access.sensitive).toHaveLength(1);
    expect(reloaded.sources.local).toHaveLength(1);
    expect(reloaded.sources.github).toHaveLength(1);
  });

  it("calling twice adds two entries (no accidental overwrite)", () => {
    fixture = makeTempCtxYaml(`project: demo\n`);

    appendSourceToConfig(fixture.configPath, "confluence", {
      name: "first",
      base_url: "https://a.example.com",
      token: "${CONFLUENCE_TOKEN}",
    });
    appendSourceToConfig(fixture.configPath, "confluence", {
      name: "second",
      base_url: "https://b.example.com",
      token: "${CONFLUENCE_TOKEN}",
    });

    const reloaded = parseYaml(readFileSync(fixture.configPath, "utf-8")) as {
      sources: { confluence: Array<{ name: string }> };
    };
    expect(reloaded.sources.confluence).toHaveLength(2);
    expect(reloaded.sources.confluence.map((c) => c.name)).toEqual(["first", "second"]);
  });

  it("writes every source type this function supports", () => {
    // Runs through all 6 source types the interactive flow knows about,
    // asserting each lands in its own array. This would catch a typo
    // in a future SOURCE_TYPE_NAMES change.
    fixture = makeTempCtxYaml(`project: demo\n`);

    const cases: Array<[string, Record<string, unknown>]> = [
      ["confluence", { name: "c", base_url: "https://c", token: "${CONFLUENCE_TOKEN}" }],
      ["jira", { name: "j", base_url: "https://j", token: "${JIRA_TOKEN}" }],
      ["github", { name: "g", token: "${GITHUB_TOKEN}", owner: "acme" }],
      ["slack", { name: "s", token: "${SLACK_TOKEN}", channels: ["general"] }],
      ["notion", { name: "n", token: "${NOTION_TOKEN}" }],
      ["local", { name: "l", path: "./docs" }],
    ];

    for (const [type, entry] of cases) {
      appendSourceToConfig(
        fixture.configPath,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type as any,
        entry
      );
    }

    const reloaded = parseYaml(readFileSync(fixture.configPath, "utf-8")) as {
      sources: Record<string, unknown[]>;
    };
    for (const [type] of cases) {
      expect(reloaded.sources[type]).toHaveLength(1);
    }
  });
});

describe("readRawConfig / writeRawConfig round-trip", () => {
  let fixture: ReturnType<typeof makeTempCtxYaml>;

  afterEach(() => {
    if (fixture) fixture.cleanup();
  });

  it("round-trips a realistic config without losing fields", () => {
    const original = `project: my-app
ai:
  provider: openai
  base_url: https://api.core42.ai/v1
  model: gpt-4o
sources:
  local:
    - name: code
      path: .
  jira:
    - name: jira
      base_url: https://acme.atlassian.net
      token: \${JIRA_TOKEN}
      project: ENG
costs:
  budget: 25
  model: gpt-4o
`;
    fixture = makeTempCtxYaml(original);

    const data = readRawConfig(fixture.configPath);
    writeRawConfig(fixture.configPath, data);

    const reloaded = parseYaml(readFileSync(fixture.configPath, "utf-8"));
    const originalParsed = parseYaml(original);
    expect(reloaded).toEqual(originalParsed);
  });

  it("writeRawConfig creates a file that readRawConfig can read back", () => {
    fixture = makeTempCtxYaml("project: demo\n");
    const data = { project: "demo", sources: { local: [{ name: "a", path: "./a" }] } };
    writeRawConfig(fixture.configPath, data);

    expect(existsSync(fixture.configPath)).toBe(true);
    const reloaded = readRawConfig(fixture.configPath);
    expect(reloaded).toEqual(data);
  });
});
