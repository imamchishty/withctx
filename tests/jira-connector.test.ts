import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { JiraConnector } from "../src/connectors/jira.js";
import type { JiraSource } from "../src/types/config.js";
import type { RawDocument } from "../src/types/source.js";
import { startMockServer, MockServer } from "./helpers/mock-server.js";
import { buildJiraRoutes } from "./helpers/jira-fixtures.js";

async function collect(gen: AsyncGenerator<RawDocument>): Promise<RawDocument[]> {
  const out: RawDocument[] = [];
  for await (const doc of gen) out.push(doc);
  return out;
}

describe("JiraConnector (mock server)", () => {
  let server: MockServer;

  beforeAll(async () => {
    server = await startMockServer(buildJiraRoutes());
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.reset();
  });

  function makeConfig(overrides: Partial<JiraSource> = {}): JiraSource {
    return {
      name: "test-jira",
      base_url: server.url,
      email: "alice@example.com",
      token: "secret-token",
      ...overrides,
    } as JiraSource;
  }

  it("validate() returns true when /rest/api/2/myself responds 200", async () => {
    const connector = new JiraConnector(makeConfig({ project: "ALPHA" }));
    const result = await connector.validate();
    expect(result).toBe(true);
    expect(connector.getStatus().status).toBe("connected");
    expect(server.requests.some((r) => r.path === "/rest/api/2/myself")).toBe(true);
  });

  it("validate() returns false on 401", async () => {
    const failing = await startMockServer(buildJiraRoutes({ myselfStatus: 401 }));
    try {
      const connector = new JiraConnector({
        name: "failing",
        base_url: failing.url,
        email: "alice@example.com",
        token: "bad",
      } as JiraSource);
      const result = await connector.validate();
      expect(result).toBe(false);
      expect(connector.getStatus().status).toBe("error");
    } finally {
      await failing.close();
    }
  });

  it("fetch() with a project filter returns issues for that project", async () => {
    const connector = new JiraConnector(makeConfig({ project: "ALPHA" }));
    const docs = await collect(connector.fetch());

    const keys = docs.map((d) => d.metadata.key as string).sort();
    expect(keys).toEqual(["ALPHA-1", "ALPHA-2", "ALPHA-3"]);

    // The connector builds: project = "ALPHA" ORDER BY updated DESC
    const searchCall = server.requests.find((r) => r.path.startsWith("/rest/api/2/search"));
    expect(searchCall).toBeDefined();
    const jqlParam = new URL(searchCall!.path, "http://x").searchParams.get("jql");
    expect(jqlParam).toContain('project = "ALPHA"');
  });

  it("fetch() with raw JQL passes the JQL straight through", async () => {
    const connector = new JiraConnector(
      makeConfig({ jql: 'project = "BETA"' }),
    );
    const docs = await collect(connector.fetch());

    const keys = docs.map((d) => d.metadata.key as string).sort();
    expect(keys).toEqual(["BETA-1", "BETA-2"]);
  });

  it("fetch() paginates across multiple pages of results", async () => {
    const connector = new JiraConnector(makeConfig({ project: "PAGINATION" }));
    const docs = await collect(connector.fetch());

    // PAGINATION project has 60 issues; page size is 50 so we expect 60 in two pages.
    expect(docs.length).toBe(60);

    const searchCalls = server.requests.filter((r) =>
      r.path.startsWith("/rest/api/2/search"),
    );
    expect(searchCalls.length).toBeGreaterThanOrEqual(2);
    // Second call must have startAt=50
    const startAts = searchCalls
      .map((c) => new URL(c.path, "http://x").searchParams.get("startAt"))
      .filter((v): v is string => !!v);
    expect(startAts).toContain("0");
    expect(startAts).toContain("50");
  });

  it("fetch() filters out issues matching exclude.status", async () => {
    const connector = new JiraConnector(
      makeConfig({ project: "ALPHA", exclude: { status: ["Closed", "Done"] } }),
    );
    const docs = await collect(connector.fetch());

    const keys = docs.map((d) => d.metadata.key as string);
    expect(keys).toContain("ALPHA-1"); // In Progress — kept
    expect(keys).not.toContain("ALPHA-2"); // Done — excluded
    expect(keys).not.toContain("ALPHA-3"); // Closed — excluded
  });

  it("fetch() renders issue content with Jira metadata fields", async () => {
    const connector = new JiraConnector(makeConfig({ project: "ALPHA" }));
    const docs = await collect(connector.fetch());

    const alpha1 = docs.find((d) => (d.metadata.key as string) === "ALPHA-1");
    expect(alpha1).toBeDefined();
    expect(alpha1!.title).toBe("ALPHA-1: Ship onboarding flow");
    expect(alpha1!.content).toContain("**Type:** Story");
    expect(alpha1!.content).toContain("**Status:** In Progress");
    expect(alpha1!.content).toContain("**Priority:** High");
    expect(alpha1!.url).toBe(`${server.url}/browse/ALPHA-1`);
  });
});
