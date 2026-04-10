import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NotionConnector } from "../src/connectors/notion.js";
import type { NotionSource } from "../src/types/config.js";
import type { RawDocument } from "../src/types/source.js";
import { startMockServer, MockServer } from "./helpers/mock-server.js";
import { buildNotionRoutes } from "./helpers/notion-fixtures.js";

async function collect(gen: AsyncGenerator<RawDocument>): Promise<RawDocument[]> {
  const out: RawDocument[] = [];
  for await (const doc of gen) out.push(doc);
  return out;
}

describe("NotionConnector (mock server)", () => {
  let server: MockServer;

  beforeAll(async () => {
    server = await startMockServer(buildNotionRoutes());
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.reset();
  });

  function makeConfig(overrides: Partial<NotionSource> = {}): NotionSource {
    return {
      name: "test-notion",
      // Connector appends paths starting with /databases, /pages, /blocks, /users
      // onto the base URL — so base_url must include the /v1 suffix.
      base_url: `${server.url}/v1`,
      token: "ntn-test-token",
      ...overrides,
    } as NotionSource;
  }

  it("validate() succeeds when /v1/users/me returns 200", async () => {
    const connector = new NotionConnector(makeConfig());
    const result = await connector.validate();
    expect(result).toBe(true);
    expect(connector.getStatus().status).toBe("connected");
    expect(server.requests.some((r) => r.path === "/v1/users/me")).toBe(true);
    // Bearer token + Notion-Version headers should be set.
    const headers = server.requests[0].headers;
    expect(headers["authorization"]).toBe("Bearer ntn-test-token");
    expect(headers["notion-version"]).toBeDefined();
  });

  it("validate() returns false when /v1/users/me returns 401", async () => {
    const failing = await startMockServer(buildNotionRoutes({ meStatus: 401 }));
    try {
      const connector = new NotionConnector({
        name: "fail",
        base_url: `${failing.url}/v1`,
        token: "bad",
      } as NotionSource);
      const result = await connector.validate();
      expect(result).toBe(false);
      expect(connector.getStatus().status).toBe("error");
    } finally {
      await failing.close();
    }
  });

  it("fetch() returns pages from a configured database", async () => {
    const connector = new NotionConnector(
      makeConfig({ database_ids: ["db-engineering"] }),
    );
    const docs = await collect(connector.fetch());

    // All three sample pages in db-engineering have block children → should
    // all come back as documents.
    expect(docs.length).toBe(3);
    const titles = docs.map((d) => d.title);
    expect(titles).toContain("Architecture Overview");
    expect(titles).toContain("Release Process");
    expect(titles).toContain("Old Notes");
  });

  it("fetch() converts Notion blocks to markdown (headings, lists, code)", async () => {
    const connector = new NotionConnector(
      makeConfig({ database_ids: ["db-engineering"] }),
    );
    const docs = await collect(connector.fetch());

    const arch = docs.find((d) => d.title === "Architecture Overview");
    expect(arch).toBeDefined();
    expect(arch!.content).toContain("# Architecture");
    expect(arch!.content).toContain("- Service A");
    expect(arch!.content).toContain("- Service B");
    expect(arch!.content).toMatch(/```typescript\s*\nconst x = 1;\s*\n```/);
  });

  it("fetch() with `since` applies the last_edited_time filter on the database query", async () => {
    const connector = new NotionConnector(
      makeConfig({ database_ids: ["db-engineering"] }),
    );
    // Ask only for pages edited after Jan 1 2025 — page-003 (edited Dec 2024) must drop out.
    const since = new Date("2025-01-01T00:00:00.000Z");
    const docs: RawDocument[] = [];
    for await (const d of connector.fetch({ since })) docs.push(d);

    const titles = docs.map((d) => d.title);
    expect(titles).not.toContain("Old Notes");
    expect(titles).toContain("Architecture Overview");
    expect(titles).toContain("Release Process");

    // And the POST body to /databases/:id/query should have carried the filter.
    const queryCall = server.requests.find(
      (r) => r.method === "POST" && r.path.startsWith("/v1/databases/"),
    );
    expect(queryCall).toBeDefined();
    const parsed = JSON.parse(queryCall!.body);
    expect(parsed.filter.timestamp).toBe("last_edited_time");
    expect(parsed.filter.last_edited_time.after).toBe(since.toISOString());
  });
});
