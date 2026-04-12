import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConnectors } from "../src/connectors/build.js";
import type { CtxConfig } from "../src/types/config.js";

/**
 * Regression coverage for the "orphaned connector" bug: before
 * `src/connectors/build.ts` existed, `ctx ingest` and `ctx sync` each
 * had their own `buildConnectors` helper and BOTH only registered
 * `LocalFilesConnector`. A user with a perfectly valid `jira:` or
 * `confluence:` block in ctx.yaml saw zero external data appear in
 * their wiki and no error — the worst possible UX.
 *
 * These tests assert that every source type in the ctx.yaml produces
 * a connector in the registry. They don't make any network calls —
 * they only check registration, which is the specific thing that
 * historically broke.
 */

describe("buildConnectors (registry wiring)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "withctx-build-"));
    // Allow private URLs so we can use example.com-ish hosts without
    // tripping the SSRF guard (the schema validates base_url even in
    // tests).
    process.env.WITHCTX_ALLOW_PRIVATE_URLS = "1";
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    delete process.env.WITHCTX_ALLOW_PRIVATE_URLS;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  it("returns an empty registry when the config has no sources section", () => {
    const config: CtxConfig = { project: "empty" };
    const registry = buildConnectors(config, projectRoot);
    expect(registry.getAll()).toHaveLength(0);
  });

  it("registers a local-files connector for each entry under sources.local", () => {
    // safeResolve checks the path exists on disk — create a folder.
    mkdirSync(join(projectRoot, "src"));
    writeFileSync(join(projectRoot, "src", "a.md"), "# hello");

    const config: CtxConfig = {
      project: "local-only",
      sources: {
        local: [{ name: "app-src", path: "./src" }],
      },
    };

    const registry = buildConnectors(config, projectRoot);
    const connectors = registry.getAll();
    expect(connectors).toHaveLength(1);
    expect(connectors[0].name).toBe("app-src");
    expect(connectors[0].type).toBe("local");
  });

  it("registers a Jira connector (this was the pre-1.4 regression)", () => {
    const config: CtxConfig = {
      project: "jira-repro",
      sources: {
        jira: [
          {
            name: "corp-jira",
            base_url: "https://jira.corp.example.com",
            token: "pat-token",
            project: "ENG",
          },
        ],
      },
    };

    const registry = buildConnectors(config, projectRoot);
    const connectors = registry.getAll();
    expect(connectors).toHaveLength(1);
    expect(connectors[0].type).toBe("jira");
    expect(connectors[0].name).toBe("corp-jira");
  });

  it("registers a Confluence connector (this was the pre-1.4 regression)", () => {
    const config: CtxConfig = {
      project: "confluence-repro",
      sources: {
        confluence: [
          {
            name: "corp-wiki",
            base_url: "https://confluence.corp.example.com",
            token: "pat-token",
            space: "ENG",
          },
        ],
      },
    };

    const registry = buildConnectors(config, projectRoot);
    const connectors = registry.getAll();
    expect(connectors).toHaveLength(1);
    expect(connectors[0].type).toBe("confluence");
    expect(connectors[0].name).toBe("corp-wiki");
  });

  it("registers a GitHub connector using GITHUB_TOKEN from env", () => {
    process.env.GITHUB_TOKEN = "ghp_from_env";

    const config: CtxConfig = {
      project: "github-env-token",
      sources: {
        github: [
          {
            name: "corp-github",
            owner: "acme",
            repo: "platform",
          },
        ],
      },
    };

    const registry = buildConnectors(config, projectRoot);
    const connectors = registry.getAll();
    expect(connectors).toHaveLength(1);
    expect(connectors[0].type).toBe("github");
    expect(connectors[0].name).toBe("corp-github");
  });

  it("skips a misconfigured GitHub source (no token) but keeps every other connector", () => {
    // No GITHUB_TOKEN set → GitHubConnector constructor throws →
    // build.ts should catch, warn, and keep going.
    mkdirSync(join(projectRoot, "src"));

    const config: CtxConfig = {
      project: "mixed",
      sources: {
        local: [{ name: "app", path: "./src" }],
        github: [{ name: "broken-github", owner: "acme" }],
        jira: [
          {
            name: "corp-jira",
            base_url: "https://jira.corp.example.com",
            token: "t",
          },
        ],
      },
    };

    const registry = buildConnectors(config, projectRoot);
    const connectors = registry.getAll();
    const types = connectors.map((c) => c.type).sort();
    expect(types).toEqual(["jira", "local"]);
    // And the GitHub one was NOT registered.
    expect(connectors.find((c) => c.name === "broken-github")).toBeUndefined();
  });

  it("registers every SharePoint site when the config lists multiple", () => {
    // Teams env vars aren't needed for construction — the SharePoint
    // connector only consults them inside validate(), not the ctor.
    const config: CtxConfig = {
      project: "multi-sharepoint",
      sources: {
        sharepoint: [
          {
            name: "engineering-drive",
            site: "acme.sharepoint.com/sites/engineering",
            paths: ["/Shared Documents/Handbook"],
          },
          {
            name: "finance-drive",
            site: "acme.sharepoint.com/sites/finance",
            files: ["/Shared Documents/FY24/budget.xlsx"],
          },
        ],
      },
    };

    const registry = buildConnectors(config, projectRoot);
    const connectors = registry.getAll();
    expect(connectors).toHaveLength(2);
    expect(connectors.map((c) => c.name).sort()).toEqual([
      "engineering-drive",
      "finance-drive",
    ]);
    for (const c of connectors) {
      expect(c.type).toBe("sharepoint");
    }
  });

  it("registers Teams connector when sources.teams is populated", () => {
    const config: CtxConfig = {
      project: "teams-wired",
      sources: {
        teams: [
          {
            name: "corp-teams",
            tenant_id: "tenant-id",
            client_id: "client-id",
            client_secret: "secret",
            channels: [{ team: "Platform", channel: "General" }],
          },
        ],
      },
    };

    const registry = buildConnectors(config, projectRoot);
    const connectors = registry.getAll();
    expect(connectors).toHaveLength(1);
    expect(connectors[0].type).toBe("teams");
  });

  it("honours sourceFilter — only the named source is registered", () => {
    const config: CtxConfig = {
      project: "filtered",
      sources: {
        jira: [
          {
            name: "jira-a",
            base_url: "https://jira-a.corp.example.com",
            token: "t",
          },
          {
            name: "jira-b",
            base_url: "https://jira-b.corp.example.com",
            token: "t",
          },
        ],
        confluence: [
          {
            name: "wiki-a",
            base_url: "https://wiki.corp.example.com",
            token: "t",
            space: "ENG",
          },
        ],
      },
    };

    const registry = buildConnectors(config, projectRoot, {
      sourceFilter: "jira-b",
    });
    const connectors = registry.getAll();
    expect(connectors).toHaveLength(1);
    expect(connectors[0].name).toBe("jira-b");
  });

  it("registers a full heterogeneous config end-to-end", () => {
    process.env.GITHUB_TOKEN = "ghp_env";
    mkdirSync(join(projectRoot, "docs"));

    const config: CtxConfig = {
      project: "full",
      sources: {
        local: [{ name: "docs", path: "./docs" }],
        jira: [
          {
            name: "corp-jira",
            base_url: "https://jira.corp.example.com",
            token: "t",
          },
        ],
        confluence: [
          {
            name: "corp-wiki",
            base_url: "https://confluence.corp.example.com",
            token: "t",
            space: "ENG",
          },
        ],
        github: [{ name: "corp-github", owner: "acme" }],
        teams: [
          {
            name: "corp-teams",
            tenant_id: "t",
            client_id: "c",
            client_secret: "s",
            channels: [{ team: "Platform", channel: "General" }],
          },
        ],
        sharepoint: [
          {
            name: "corp-sharepoint",
            site: "acme.sharepoint.com/sites/eng",
          },
        ],
      },
    };

    const registry = buildConnectors(config, projectRoot);
    const types = registry.getAll().map((c) => c.type).sort();
    // Every declared source type should be present. This is the
    // guardrail that would have caught the pre-1.4 silent-drop bug.
    expect(types).toEqual([
      "confluence",
      "github",
      "jira",
      "local",
      "sharepoint",
      "teams",
    ]);
  });
});
