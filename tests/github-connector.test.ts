import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { GitHubConnector } from "../src/connectors/github.js";
import {
  normalizeGitHubBaseUrl,
  resolveGitHubBaseUrl,
  resolveGitHubToken,
  isRunningInGitHubActions,
} from "../src/connectors/github-url.js";
import { startMockServer, type MockServer } from "./helpers/mock-server.js";
import { buildGitHubRoutes } from "./helpers/github-fixtures.js";
import type { GitHubSource } from "../src/types/config.js";

/**
 * The GitHub connector must work identically against:
 *
 *   • github.com (cloud)           — no base_url
 *   • GitHub Enterprise Server      — base_url points at /api/v3
 *   • GitHub Actions runners        — token / base_url come from env
 *
 * All three branches run against a local mock HTTP server to prove the
 * request shapes match what Octokit emits. No network required.
 */

describe("normalizeGitHubBaseUrl", () => {
  it("collapses all github.com variants to https://api.github.com", () => {
    expect(normalizeGitHubBaseUrl("github.com")).toBe("https://api.github.com");
    expect(normalizeGitHubBaseUrl("https://github.com")).toBe("https://api.github.com");
    expect(normalizeGitHubBaseUrl("https://github.com/")).toBe("https://api.github.com");
    expect(normalizeGitHubBaseUrl("https://api.github.com")).toBe("https://api.github.com");
    expect(normalizeGitHubBaseUrl("https://www.github.com")).toBe("https://api.github.com");
  });

  it("auto-appends /api/v3 to a bare GHES host", () => {
    expect(normalizeGitHubBaseUrl("https://github.corp.com")).toBe(
      "https://github.corp.com/api/v3",
    );
    expect(normalizeGitHubBaseUrl("https://github.corp.com/")).toBe(
      "https://github.corp.com/api/v3",
    );
  });

  it("passes through a correctly-suffixed GHES URL", () => {
    expect(normalizeGitHubBaseUrl("https://github.corp.com/api/v3")).toBe(
      "https://github.corp.com/api/v3",
    );
    expect(normalizeGitHubBaseUrl("https://github.corp.com/api/v3/")).toBe(
      "https://github.corp.com/api/v3",
    );
  });

  it("handles a custom context path in front of /api/v3", () => {
    expect(normalizeGitHubBaseUrl("https://corp.com/github/api/v3")).toBe(
      "https://corp.com/github/api/v3",
    );
  });

  it("wraps a bare host with https:// and normalises", () => {
    expect(normalizeGitHubBaseUrl("github.corp.com")).toBe(
      "https://github.corp.com/api/v3",
    );
  });

  it("returns unparseable input unchanged so callers can surface a schema error", () => {
    expect(normalizeGitHubBaseUrl("")).toBe("");
  });
});

describe("resolveGitHubBaseUrl + resolveGitHubToken", () => {
  const saved = {
    apiUrl: process.env.GITHUB_API_URL,
    token: process.env.GITHUB_TOKEN,
    ghToken: process.env.GH_TOKEN,
    actions: process.env.GITHUB_ACTIONS,
  };

  beforeEach(() => {
    delete process.env.GITHUB_API_URL;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_ACTIONS;
  });

  afterEach(() => {
    if (saved.apiUrl !== undefined) process.env.GITHUB_API_URL = saved.apiUrl;
    if (saved.token !== undefined) process.env.GITHUB_TOKEN = saved.token;
    if (saved.ghToken !== undefined) process.env.GH_TOKEN = saved.ghToken;
    if (saved.actions !== undefined) process.env.GITHUB_ACTIONS = saved.actions;
  });

  it("prefers explicit config over env for base_url", () => {
    process.env.GITHUB_API_URL = "https://ignored.example.com/api/v3";
    expect(resolveGitHubBaseUrl("https://github.corp.com")).toBe(
      "https://github.corp.com/api/v3",
    );
  });

  it("falls back to GITHUB_API_URL when config.base_url is unset", () => {
    process.env.GITHUB_API_URL = "https://ghes.example.com/api/v3";
    expect(resolveGitHubBaseUrl(undefined)).toBe("https://ghes.example.com/api/v3");
  });

  it("normalises the env-supplied GHES URL if it is missing /api/v3", () => {
    process.env.GITHUB_API_URL = "https://ghes.example.com";
    expect(resolveGitHubBaseUrl(undefined)).toBe("https://ghes.example.com/api/v3");
  });

  it("returns undefined when neither config nor env is set", () => {
    expect(resolveGitHubBaseUrl(undefined)).toBeUndefined();
  });

  it("prefers explicit token over GITHUB_TOKEN over GH_TOKEN", () => {
    process.env.GITHUB_TOKEN = "env-primary";
    process.env.GH_TOKEN = "env-secondary";
    expect(resolveGitHubToken("from-config")).toBe("from-config");
    expect(resolveGitHubToken(undefined)).toBe("env-primary");
    delete process.env.GITHUB_TOKEN;
    expect(resolveGitHubToken(undefined)).toBe("env-secondary");
  });

  it("returns null when nothing is set", () => {
    expect(resolveGitHubToken(undefined)).toBeNull();
  });

  it("detects the GitHub Actions runner", () => {
    process.env.GITHUB_ACTIONS = "true";
    expect(isRunningInGitHubActions()).toBe(true);
    process.env.GITHUB_ACTIONS = "false";
    expect(isRunningInGitHubActions()).toBe(false);
    delete process.env.GITHUB_ACTIONS;
    expect(isRunningInGitHubActions()).toBe(false);
  });
});

/*
 * Why there is no separate "GitHub cloud / github.com" integration block:
 *
 *   Cloud is proven end-to-end by the GHES integration tests (which
 *   exercise the same code path — same Octokit, same fetch, same
 *   connector logic) plus the normalizeGitHubBaseUrl unit tests above.
 *
 *   We cannot point a local mock server at "api.github.com" without
 *   monkey-patching DNS, and any base_url we DO pass to the connector
 *   in a test gets treated as GHES by the normaliser. So the honest
 *   separation is:
 *
 *     - Unit tests prove cloud URLs collapse to https://api.github.com
 *     - Integration tests prove the full wire-up against a /api/v3
 *       mock — that exercises every code path the cloud path hits,
 *       just with a different hostname.
 *
 *   The on-prem smoke script (scripts/smoke-onprem.sh) runs against a
 *   real github.com token as the final acceptance check.
 */

describe("GitHubConnector (GitHub Enterprise Server / on-prem)", () => {
  let server: MockServer;

  beforeEach(async () => {
    server = await startMockServer(
      buildGitHubRoutes({ pathPrefix: "/api/v3", owner: "acme", repos: ["widget"] }),
    );
  });
  afterEach(async () => {
    await server.close();
  });

  it("auto-appends /api/v3 to a bare GHES host and validates", async () => {
    const c = new GitHubConnector({
      name: "gh-ghes",
      token: "ghes-token",
      owner: "acme",
      repo: "widget",
      base_url: server.url, // no /api/v3 — connector should add it
    } as GitHubSource);

    expect(c.effectiveBaseUrl).toBe(`${server.url}/api/v3`);

    const ok = await c.validate();
    expect(ok).toBe(true);

    // Every call must have hit /api/v3/*, never the bare root
    for (const req of server.requests) {
      expect(req.path.startsWith("/api/v3/")).toBe(true);
    }
  });

  it("passes through an already-suffixed GHES base_url", async () => {
    const c = new GitHubConnector({
      name: "gh-ghes-explicit",
      token: "ghes-token",
      owner: "acme",
      repo: "widget",
      base_url: `${server.url}/api/v3`,
    } as GitHubSource);
    expect(c.effectiveBaseUrl).toBe(`${server.url}/api/v3`);

    const docs = [];
    for await (const doc of c.fetch()) docs.push(doc);
    expect(docs.length).toBeGreaterThan(0);
  });
});

describe("GitHubConnector (running inside GitHub Actions)", () => {
  let server: MockServer;
  const saved = {
    apiUrl: process.env.GITHUB_API_URL,
    token: process.env.GITHUB_TOKEN,
    actions: process.env.GITHUB_ACTIONS,
  };

  beforeEach(async () => {
    server = await startMockServer(
      buildGitHubRoutes({ pathPrefix: "/api/v3", owner: "acme", repos: ["widget"] }),
    );
  });
  afterEach(async () => {
    await server.close();
    // Restore env
    if (saved.apiUrl !== undefined) process.env.GITHUB_API_URL = saved.apiUrl;
    else delete process.env.GITHUB_API_URL;
    if (saved.token !== undefined) process.env.GITHUB_TOKEN = saved.token;
    else delete process.env.GITHUB_TOKEN;
    if (saved.actions !== undefined) process.env.GITHUB_ACTIONS = saved.actions;
    else delete process.env.GITHUB_ACTIONS;
  });

  it("picks up GITHUB_TOKEN and GITHUB_API_URL when config omits both", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_TOKEN = "runner-injected-token";
    process.env.GITHUB_API_URL = `${server.url}/api/v3`;

    const c = new GitHubConnector({
      name: "gh-actions",
      owner: "acme",
      repo: "widget",
      // token and base_url deliberately omitted — workflow supplies them
    } as GitHubSource);

    expect(c.effectiveBaseUrl).toBe(`${server.url}/api/v3`);

    const ok = await c.validate();
    expect(ok).toBe(true);

    const authCall = server.requests.find((r) => r.path.endsWith("/user"));
    expect(authCall).toBeDefined();
    expect(authCall!.headers["authorization"]?.toLowerCase()).toContain(
      "token runner-injected-token",
    );
  });

  it("throws a clear error when no token is available anywhere", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    expect(
      () =>
        new GitHubConnector({
          name: "gh-missing-token",
          owner: "acme",
          repo: "widget",
        } as GitHubSource),
    ).toThrow(/no token/i);
  });
});
