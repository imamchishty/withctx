import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ConfluenceConnector } from "../src/connectors/confluence.js";
import type { ConfluenceSource } from "../src/types/config.js";
import type { RawDocument } from "../src/types/source.js";
import { startMockServer, MockServer } from "./helpers/mock-server.js";
import { buildConfluenceRoutes, SAMPLE_PAGES, TREE_PAGES } from "./helpers/confluence-fixtures.js";

async function collect(gen: AsyncGenerator<RawDocument>): Promise<RawDocument[]> {
  const out: RawDocument[] = [];
  for await (const doc of gen) out.push(doc);
  return out;
}

describe("ConfluenceConnector (mock server)", () => {
  let server: MockServer;

  beforeAll(async () => {
    server = await startMockServer(buildConfluenceRoutes());
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.reset();
  });

  function makeConfig(overrides: Partial<ConfluenceSource> = {}): ConfluenceSource {
    return {
      name: "test-confluence",
      base_url: server.url,
      email: "alice@example.com",
      token: "secret-token",
      ...overrides,
    } as ConfluenceSource;
  }

  it("validate() succeeds on 200 from /rest/api/user/current", async () => {
    const connector = new ConfluenceConnector(makeConfig({ space: "ENG" }));
    const result = await connector.validate();
    expect(result).toBe(true);
    expect(connector.getStatus().status).toBe("connected");
    expect(server.requests.some((r) => r.path.startsWith("/rest/api/user/current"))).toBe(true);
  });

  it("validate() fails on 401 from both endpoints", async () => {
    const failingServer = await startMockServer(
      buildConfluenceRoutes({ userCurrentStatus: 401, spaceStatus: 401 }),
    );
    try {
      const connector = new ConfluenceConnector({
        name: "failing",
        base_url: failingServer.url,
        email: "alice@example.com",
        token: "bad-token",
      } as ConfluenceSource);
      const result = await connector.validate();
      expect(result).toBe(false);
      expect(connector.getStatus().status).toBe("error");
    } finally {
      await failingServer.close();
    }
  });

  it("fetch() with single space returns pages only for that space", async () => {
    const connector = new ConfluenceConnector(makeConfig({ space: "ENG" }));
    const docs = await collect(connector.fetch());

    const engPages = SAMPLE_PAGES.filter((p) => p.spaceKey === "ENG");
    expect(docs.length).toBe(engPages.length);
    for (const doc of docs) {
      const id = doc.metadata.pageId as string;
      const page = SAMPLE_PAGES.find((p) => p.id === id);
      expect(page?.spaceKey).toBe("ENG");
    }
  });

  it("fetch() with multi-space array iterates all given spaces", async () => {
    const connector = new ConfluenceConnector(makeConfig({ space: ["ENG", "PLATFORM"] }));
    const docs = await collect(connector.fetch());

    // All sample pages (both ENG and PLATFORM) should be included.
    expect(docs.length).toBe(SAMPLE_PAGES.length);

    const spacesSeen = new Set(
      docs
        .map((d) => SAMPLE_PAGES.find((p) => p.id === d.metadata.pageId)?.spaceKey)
        .filter(Boolean),
    );
    expect(spacesSeen.has("ENG")).toBe(true);
    expect(spacesSeen.has("PLATFORM")).toBe(true);

    // And the mock should have received a search call for each space.
    const searchCalls = server.requests.filter((r) =>
      r.path.startsWith("/rest/api/content/search"),
    );
    expect(searchCalls.length).toBeGreaterThanOrEqual(2);
    const cqlStrings = searchCalls.map((c) => decodeURIComponent(c.path));
    expect(cqlStrings.some((c) => c.includes('space = "ENG"'))).toBe(true);
    expect(cqlStrings.some((c) => c.includes('space = "PLATFORM"'))).toBe(true);
  });

  it("fetch() with pages[] returns exactly the requested pages", async () => {
    const connector = new ConfluenceConnector(
      makeConfig({ pages: [{ id: "10001" }, { id: "20001" }] }),
    );
    const docs = await collect(connector.fetch());
    expect(docs.length).toBe(2);
    const ids = docs.map((d) => d.metadata.pageId).sort();
    expect(ids).toEqual(["10001", "20001"]);
  });

  it("fetch() with parent returns children of that parent via the tree endpoint", async () => {
    const connector = new ConfluenceConnector(makeConfig({ parent: "30000" }));
    const docs = await collect(connector.fetch());

    // Both children should be returned.
    expect(docs.length).toBe(TREE_PAGES.length);
    const childIds = docs.map((d) => d.metadata.pageId).sort();
    expect(childIds).toEqual(["30001", "30002"]);

    // And the connector should have hit the /child/page endpoint.
    expect(
      server.requests.some((r) => r.path.startsWith("/rest/api/content/30000/child/page")),
    ).toBe(true);
  });

  it("fetch() respects exclude.label — pages with excluded labels are filtered out", async () => {
    const connector = new ConfluenceConnector(
      makeConfig({ space: "ENG", exclude: { label: ["draft"] } }),
    );
    const docs = await collect(connector.fetch());

    const titles = docs.map((d) => d.title);
    expect(titles).not.toContain("Draft Architecture Notes");
    // The other ENG pages are still present.
    expect(titles).toContain("Engineering Onboarding");
    expect(titles).toContain("Deployment Runbook");
  });

  it("fetch() sends Basic auth header when email+token are provided", async () => {
    const connector = new ConfluenceConnector(makeConfig({ space: "ENG" }));
    await collect(connector.fetch());

    const authHeader = server.requests[0].headers["authorization"];
    expect(authHeader).toBeDefined();
    expect(authHeader.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(authHeader.substring(6), "base64").toString("utf8");
    expect(decoded).toBe("alice@example.com:secret-token");
  });

  it("fetch() sends Bearer auth when only token provided (on-prem style)", async () => {
    const connector = new ConfluenceConnector({
      name: "test",
      base_url: server.url,
      token: "onprem-token",
      space: "ENG",
    } as ConfluenceSource);
    await collect(connector.fetch());

    const authHeader = server.requests[0].headers["authorization"];
    expect(authHeader).toBeDefined();
    expect(authHeader).toBe("Bearer onprem-token");
  });

  it("fetch() converts Confluence storage-format HTML to markdown", async () => {
    const connector = new ConfluenceConnector(makeConfig({ space: "ENG" }));
    const docs = await collect(connector.fetch());

    const onboarding = docs.find((d) => d.title === "Engineering Onboarding");
    expect(onboarding).toBeDefined();
    // HTML tags must be stripped; strong/em converted to markdown markers.
    expect(onboarding!.content).not.toMatch(/<h1>/);
    expect(onboarding!.content).not.toMatch(/<strong>/);
    expect(onboarding!.content).toContain("**Engineering Onboarding**");
    // Link conversion.
    expect(onboarding!.content).toContain("[a link](https://example.com)");
  });

  it("fetch() populates metadata (labels, version, url)", async () => {
    const connector = new ConfluenceConnector(makeConfig({ space: "ENG" }));
    const docs = await collect(connector.fetch());

    const runbook = docs.find((d) => d.title === "Deployment Runbook");
    expect(runbook).toBeDefined();
    expect(runbook!.metadata.labels).toEqual(expect.arrayContaining(["runbook", "ops"]));
    expect(runbook!.metadata.version).toBe(1);
    expect(runbook!.url).toContain(server.url);
    expect(runbook!.sourceType).toBe("confluence");
    expect(runbook!.sourceName).toBe("test-confluence");
  });
});
