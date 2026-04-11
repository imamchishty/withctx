import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  ConfluenceConnector,
  normalizeConfluenceBaseUrl,
} from "../src/connectors/confluence.js";
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

// ──────────────────────────────────────────────────────────────────────
// normalizeConfluenceBaseUrl — unit tests for the Cloud /wiki heuristic
// ──────────────────────────────────────────────────────────────────────
describe("normalizeConfluenceBaseUrl", () => {
  it("appends /wiki to an atlassian.net host without a path", () => {
    expect(normalizeConfluenceBaseUrl("https://acme.atlassian.net")).toBe(
      "https://acme.atlassian.net/wiki"
    );
  });

  it("strips trailing slash before appending /wiki", () => {
    expect(normalizeConfluenceBaseUrl("https://acme.atlassian.net/")).toBe(
      "https://acme.atlassian.net/wiki"
    );
  });

  it("leaves atlassian.net URLs that already include /wiki alone", () => {
    expect(normalizeConfluenceBaseUrl("https://acme.atlassian.net/wiki")).toBe(
      "https://acme.atlassian.net/wiki"
    );
    expect(
      normalizeConfluenceBaseUrl("https://acme.atlassian.net/wiki/")
    ).toBe("https://acme.atlassian.net/wiki");
  });

  it("leaves atlassian.net URLs with deeper /wiki/... paths alone", () => {
    expect(
      normalizeConfluenceBaseUrl("https://acme.atlassian.net/wiki/spaces/ENG")
    ).toBe("https://acme.atlassian.net/wiki/spaces/ENG");
  });

  it("does not touch a Server / Data Center hostname", () => {
    expect(
      normalizeConfluenceBaseUrl("https://confluence.acme.internal")
    ).toBe("https://confluence.acme.internal");
    expect(
      normalizeConfluenceBaseUrl("https://confluence.acme.internal/")
    ).toBe("https://confluence.acme.internal");
    expect(
      normalizeConfluenceBaseUrl("https://confluence.acme.internal/custom-base")
    ).toBe("https://confluence.acme.internal/custom-base");
  });

  it("is case-insensitive on the atlassian.net suffix", () => {
    // Node's URL parser lowercases the hostname in `origin`, so the
    // output is normalised to the canonical lowercase form — the
    // point of this test is to prove that an upper-case input still
    // gets the `/wiki` prefix appended, not that case is preserved.
    expect(normalizeConfluenceBaseUrl("https://Acme.Atlassian.Net")).toBe(
      "https://acme.atlassian.net/wiki"
    );
  });

  it("leaves malformed URLs unchanged (SafeHttpUrl should have caught them earlier)", () => {
    expect(normalizeConfluenceBaseUrl("not a url")).toBe("not a url");
  });

  it("does not match a lookalike host like atlassian.net.evil.com", () => {
    // The heuristic must anchor the suffix, otherwise a typosquat
    // `acme.atlassian.net.evil.com` would be treated as Cloud and
    // silently have `/wiki` appended.
    expect(normalizeConfluenceBaseUrl("https://acme.atlassian.net.evil.com")).toBe(
      "https://acme.atlassian.net.evil.com"
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// Confluence Cloud — /wiki-prefixed layout
// ──────────────────────────────────────────────────────────────────────
//
// Confluence Cloud mounts every REST endpoint under /wiki/rest/api/...
// The mock server is started with `pathPrefix: "/wiki"` so every route
// lives at that prefix. If the connector forgets to normalize the
// base_url, the requests land on the plain /rest/api/... routes which
// don't exist and return 404, and the assertions below fail loudly.
describe("ConfluenceConnector (Cloud / *.atlassian.net)", () => {
  let server: MockServer;

  beforeAll(async () => {
    server = await startMockServer(buildConfluenceRoutes({ pathPrefix: "/wiki" }));
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.reset();
  });

  // We can't literally point the connector at `https://acme.atlassian.net`
  // in a test (no network) — instead we hand it the mock server URL with
  // `/wiki` already appended, which is exactly what the normalizer
  // would have produced. A separate test above already proves the
  // normalizer turns the user-friendly bare hostname into this form.
  function cloudConfig(overrides: Partial<ConfluenceSource> = {}): ConfluenceSource {
    return {
      name: "cloud-confluence",
      base_url: `${server.url}/wiki`,
      email: "alice@example.com",
      token: "cloud-token",
      ...overrides,
    } as ConfluenceSource;
  }

  it("validate() succeeds against /wiki/rest/api/user/current", async () => {
    const connector = new ConfluenceConnector(cloudConfig({ space: "ENG" }));
    const ok = await connector.validate();
    expect(ok).toBe(true);

    const call = server.requests.find((r) =>
      r.path.startsWith("/wiki/rest/api/user/current")
    );
    expect(call).toBeDefined();
    // Sanity: the connector did NOT fall back to /rest/api/... without /wiki.
    const nonWikiCalls = server.requests.filter((r) =>
      r.path.startsWith("/rest/api/")
    );
    expect(nonWikiCalls.length).toBe(0);
  });

  it("fetch() hits /wiki/rest/api/content/search with Basic auth", async () => {
    const connector = new ConfluenceConnector(cloudConfig({ space: "ENG" }));
    const docs = await collect(connector.fetch());

    expect(docs.length).toBeGreaterThan(0);

    const searchCall = server.requests.find((r) =>
      r.path.startsWith("/wiki/rest/api/content/search"),
    );
    expect(searchCall).toBeDefined();
    const auth = searchCall!.headers["authorization"];
    expect(auth).toBeDefined();
    expect(auth.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(auth.substring(6), "base64").toString("utf8");
    expect(decoded).toBe("alice@example.com:cloud-token");
  });

  it("accepts a base_url that was already normalized by the constructor", () => {
    // The constructor calls normalizeConfluenceBaseUrl — we can observe
    // this indirectly by confirming that a bare atlassian.net input
    // turns into something that would resolve against the /wiki mock.
    const c = new ConfluenceConnector({
      name: "cloud-bare",
      base_url: "https://acme.atlassian.net",
      email: "alice@example.com",
      token: "t",
      space: "ENG",
    } as ConfluenceSource);
    // Private field — reach into the instance for the test. Reasonable
    // because this is the one invariant we want to pin down.
    expect((c as unknown as { baseUrl: string }).baseUrl).toBe(
      "https://acme.atlassian.net/wiki"
    );
  });
});
