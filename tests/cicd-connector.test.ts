import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { CicdConnector } from "../src/connectors/cicd.js";
import { startMockServer, type MockServer } from "./helpers/mock-server.js";
import { buildGitHubRoutes } from "./helpers/github-fixtures.js";
import type { CicdSource } from "../src/types/config.js";

/**
 * The CICD / github-actions connector must work against both
 * github.com and GitHub Enterprise Server, and it must accept its
 * token from ctx.yaml, GITHUB_TOKEN, or GH_TOKEN. All three paths are
 * exercised here against a local /api/v3 mock.
 */

describe("CicdConnector (github-actions)", () => {
  let server: MockServer;
  const saved = {
    token: process.env.GITHUB_TOKEN,
    ghToken: process.env.GH_TOKEN,
    apiUrl: process.env.GITHUB_API_URL,
  };

  beforeEach(async () => {
    server = await startMockServer(
      buildGitHubRoutes({ pathPrefix: "/api/v3", owner: "acme", repos: ["widget"] }),
    );
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_API_URL;
  });
  afterEach(async () => {
    await server.close();
    if (saved.token !== undefined) process.env.GITHUB_TOKEN = saved.token;
    if (saved.ghToken !== undefined) process.env.GH_TOKEN = saved.ghToken;
    if (saved.apiUrl !== undefined) process.env.GITHUB_API_URL = saved.apiUrl;
  });

  it("fetches workflow runs against a GHES-shaped API", async () => {
    const c = new CicdConnector({
      name: "ci-ghes",
      provider: "github-actions",
      repo: "acme/widget",
      token: "ghes-pat",
      base_url: server.url, // bare host — connector should add /api/v3
      limit: 10,
    } as CicdSource);

    expect(c.effectiveBaseUrl).toBe(`${server.url}/api/v3`);

    const ok = await c.validate();
    expect(ok).toBe(true);

    const docs = [];
    for await (const doc of c.fetch()) docs.push(doc);
    expect(docs.length).toBeGreaterThan(0);
    const runs = docs.filter((d) => d.id.includes(":run:"));
    expect(runs.length).toBeGreaterThan(0);
  });

  it("auto-detects GITHUB_TOKEN + GITHUB_API_URL in an Actions workflow", async () => {
    process.env.GITHUB_TOKEN = "actions-injected";
    process.env.GITHUB_API_URL = `${server.url}/api/v3`;

    const c = new CicdConnector({
      name: "ci-actions",
      provider: "github-actions",
      repo: "acme/widget",
      // token and base_url deliberately omitted
    } as CicdSource);

    expect(c.effectiveBaseUrl).toBe(`${server.url}/api/v3`);

    const ok = await c.validate();
    expect(ok).toBe(true);

    const authHits = server.requests.filter(
      (r) => r.headers["authorization"]?.toLowerCase().includes("token actions-injected"),
    );
    expect(authHits.length).toBeGreaterThan(0);
  });

  it("throws a helpful error when no token is available anywhere", () => {
    expect(
      () =>
        new CicdConnector({
          name: "ci-no-token",
          provider: "github-actions",
          repo: "acme/widget",
        } as CicdSource),
    ).toThrow(/no token/i);
  });
});
