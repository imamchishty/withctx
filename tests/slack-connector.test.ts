import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SlackConnector } from "../src/connectors/slack.js";
import type { SlackSource } from "../src/types/config.js";
import type { RawDocument } from "../src/types/source.js";
import { startMockServer, MockServer } from "./helpers/mock-server.js";
import { buildSlackRoutes } from "./helpers/slack-fixtures.js";

async function collect(gen: AsyncGenerator<RawDocument>): Promise<RawDocument[]> {
  const out: RawDocument[] = [];
  for await (const doc of gen) out.push(doc);
  return out;
}

describe("SlackConnector (mock server)", () => {
  let server: MockServer;

  beforeAll(async () => {
    server = await startMockServer(buildSlackRoutes());
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.reset();
  });

  function makeConfig(overrides: Partial<SlackSource> = {}): SlackSource {
    return {
      name: "test-slack",
      // Slack connector builds URLs like `${baseUrl}/${method}` — so base_url
      // must include the `/api` suffix to match Slack's real convention.
      base_url: `${server.url}/api`,
      token: "xoxb-test-token",
      channels: ["general", "engineering"],
      ...overrides,
    } as SlackSource;
  }

  it("validate() succeeds when auth.test returns ok:true", async () => {
    const connector = new SlackConnector(makeConfig());
    const result = await connector.validate();
    expect(result).toBe(true);
    expect(connector.getStatus().status).toBe("connected");
    expect(server.requests.some((r) => r.path.startsWith("/api/auth.test"))).toBe(true);
    // Bearer token header is sent.
    const authHeader = server.requests[0].headers["authorization"];
    expect(authHeader).toBe("Bearer xoxb-test-token");
  });

  it("validate() fails when auth.test returns ok:false", async () => {
    const failing = await startMockServer(buildSlackRoutes({ authOk: false }));
    try {
      const connector = new SlackConnector({
        name: "fail",
        base_url: `${failing.url}/api`,
        token: "bad",
        channels: ["general"],
      } as SlackSource);
      const result = await connector.validate();
      expect(result).toBe(false);
      expect(connector.getStatus().status).toBe("error");
    } finally {
      await failing.close();
    }
  });

  it("fetch() returns summary docs for configured channels", async () => {
    const connector = new SlackConnector(makeConfig());
    const docs = await collect(connector.fetch());

    // Each channel gets at least a summary doc. Thread documents are also
    // yielded when substantive threads exist.
    const summaryDocs = docs.filter((d) => d.title.includes("Summary"));
    expect(summaryDocs.length).toBeGreaterThanOrEqual(1);
    const channelNames = summaryDocs.map((d) => d.metadata.channelName as string);
    expect(channelNames).toContain("general");
    expect(channelNames).toContain("engineering");
  });

  it("fetch() yields thread documents with resolved author names from users.info", async () => {
    const connector = new SlackConnector(makeConfig());
    const docs = await collect(connector.fetch());

    const threadDocs = docs.filter((d) => (d.id as string).includes(":thread:"));
    expect(threadDocs.length).toBeGreaterThanOrEqual(1);

    // The connector must resolve user IDs via users.info and use the real names.
    expect(server.requests.some((r) => r.path.startsWith("/api/users.info"))).toBe(true);
    const anyThreadContent = threadDocs.map((d) => d.content).join("\n");
    expect(anyThreadContent).toMatch(/Alice Engineer|Bob Manager|Charlie Coder/);
  });

  it("fetch() filters out bot messages and noise (short + join events)", async () => {
    const connector = new SlackConnector(makeConfig());
    const docs = await collect(connector.fetch());

    // Bot messages and "hi"/join-channel noise must not appear as thread docs
    // or as referenced content in the summary.
    const joined = docs.map((d) => d.content).join("\n");
    expect(joined).not.toContain("bot message");
    expect(joined).not.toMatch(/has joined the channel/);
  });
});
