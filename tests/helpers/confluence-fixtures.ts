import type { MockRoute } from "./mock-server.js";

/** Shape that matches the ConfluencePage interface in src/connectors/confluence.ts */
export interface FixtureConfluencePage {
  id: string;
  type: string;
  status: string;
  title: string;
  spaceKey: string; // used internally for filtering by the mock
  body: {
    storage: { value: string };
  };
  version: {
    number: number;
    when: string;
    by: { displayName: string; email?: string };
  };
  history: {
    createdDate: string;
    createdBy: { displayName: string };
  };
  _links: {
    webui: string;
    self: string;
  };
  metadata: {
    labels: {
      results: Array<{ name: string }>;
    };
  };
  children: {
    attachment: {
      results: Array<{
        title: string;
        mediaType: string;
        _links?: { download?: string };
      }>;
    };
  };
  parentId?: string;
}

/** Helper to build a realistic Confluence fixture page. */
export function buildFixturePage(
  overrides: Partial<FixtureConfluencePage> & { id: string; spaceKey: string; title: string },
): FixtureConfluencePage {
  return {
    type: "page",
    status: "current",
    body: {
      storage: {
        value: `<h1>${overrides.title}</h1><p>This is a sample Confluence page about <strong>${overrides.title}</strong>.</p><p>It contains <a href="https://example.com">a link</a> and an <em>emphasized</em> phrase.</p>`,
      },
    },
    version: {
      number: 1,
      when: "2025-03-15T10:00:00.000Z",
      by: { displayName: "Alice Engineer", email: "alice@example.com" },
    },
    history: {
      createdDate: "2025-02-01T09:00:00.000Z",
      createdBy: { displayName: "Alice Engineer" },
    },
    _links: {
      webui: `/spaces/${overrides.spaceKey}/pages/${overrides.id}/${encodeURIComponent(overrides.title)}`,
      self: `/rest/api/content/${overrides.id}`,
    },
    metadata: {
      labels: { results: [{ name: "documentation" }] },
    },
    children: {
      attachment: { results: [] },
    },
    ...overrides,
  };
}

/** Canonical set of sample pages used across Confluence tests. */
export const SAMPLE_PAGES: FixtureConfluencePage[] = [
  buildFixturePage({
    id: "10001",
    spaceKey: "ENG",
    title: "Engineering Onboarding",
  }),
  buildFixturePage({
    id: "10002",
    spaceKey: "ENG",
    title: "Deployment Runbook",
    metadata: { labels: { results: [{ name: "runbook" }, { name: "ops" }] } },
  }),
  buildFixturePage({
    id: "10003",
    spaceKey: "ENG",
    title: "Draft Architecture Notes",
    metadata: { labels: { results: [{ name: "draft" }] } },
  }),
  buildFixturePage({
    id: "20001",
    spaceKey: "PLATFORM",
    title: "Platform Overview",
  }),
  buildFixturePage({
    id: "20002",
    spaceKey: "PLATFORM",
    title: "Service Catalog",
    metadata: { labels: { results: [{ name: "catalog" }] } },
  }),
];

/** Pages forming a tree under parent 30000. */
export const TREE_PAGES: FixtureConfluencePage[] = [
  buildFixturePage({
    id: "30001",
    spaceKey: "ENG",
    title: "Child Page One",
    parentId: "30000",
  }),
  buildFixturePage({
    id: "30002",
    spaceKey: "ENG",
    title: "Child Page Two",
    parentId: "30000",
  }),
];

/**
 * Extract the space key from a CQL string like
 *   `type = page AND space = "ENG"` → "ENG"
 */
function extractSpaceFromCql(cql: string): string | undefined {
  const m = cql.match(/space\s*=\s*"([^"]+)"/);
  return m?.[1];
}

/**
 * Build the MockRoute[] array implementing the subset of the Confluence
 * REST API that the connector calls.
 */
export function buildConfluenceRoutes(
  opts: {
    pages?: FixtureConfluencePage[];
    treePages?: FixtureConfluencePage[];
    /** Force /rest/api/user/current to return this status. */
    userCurrentStatus?: number;
    /** Force /rest/api/space to return this status. */
    spaceStatus?: number;
  } = {},
): MockRoute[] {
  const pages = opts.pages ?? SAMPLE_PAGES;
  const treePages = opts.treePages ?? TREE_PAGES;
  const userCurrentStatus = opts.userCurrentStatus ?? 200;
  const spaceStatus = opts.spaceStatus ?? 200;

  return [
    {
      method: "GET",
      path: "/rest/api/user/current",
      handler: (_req, res) => {
        if (userCurrentStatus !== 200) {
          res.status(userCurrentStatus).json({ message: "Unauthorized" });
          return;
        }
        res.json({ displayName: "Test User", email: "test@example.com" });
      },
    },
    {
      method: "GET",
      path: "/rest/api/space",
      handler: (_req, res) => {
        if (spaceStatus !== 200) {
          res.status(spaceStatus).json({ message: "Unauthorized" });
          return;
        }
        res.json({
          results: [{ id: "1", key: "ENG", name: "Engineering" }],
          size: 1,
          start: 0,
          limit: 1,
        });
      },
    },
    {
      method: "GET",
      path: "/rest/api/content/search",
      handler: (req, res) => {
        const cql = req.query.cql || "";
        const start = parseInt(req.query.start || "0", 10);
        const limit = parseInt(req.query.limit || "25", 10);
        const space = extractSpaceFromCql(cql);

        let filtered = pages;
        if (space) {
          filtered = pages.filter((p) => p.spaceKey === space);
        }

        const slice = filtered.slice(start, start + limit);

        res.json({
          results: slice,
          start,
          limit,
          size: slice.length,
          _links: {},
        });
      },
    },
    {
      method: "GET",
      // /rest/api/content/:id where :id is digits and NOT followed by /child/page
      path: /^\/rest\/api\/content\/(\d+)$/,
      handler: (req, res) => {
        const id = req.match?.[1];
        const page = pages.find((p) => p.id === id) || treePages.find((p) => p.id === id);
        if (!page) {
          res.status(404).json({ message: "Not Found" });
          return;
        }
        res.json(page);
      },
    },
    {
      method: "GET",
      // /rest/api/content/:id/child/page
      path: /^\/rest\/api\/content\/(\d+)\/child\/page$/,
      handler: (req, res) => {
        const parentId = req.match?.[1];
        const limit = parseInt(req.query.limit || "25", 10);
        const start = parseInt(req.query.start || "0", 10);
        const children = treePages.filter((p) => p.parentId === parentId);
        const slice = children.slice(start, start + limit);
        res.json({
          results: slice,
          start,
          limit,
          size: slice.length,
          _links: {},
        });
      },
    },
  ];
}
