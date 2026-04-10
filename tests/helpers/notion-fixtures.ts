import type { MockRoute } from "./mock-server.js";

export interface FixtureNotionPage {
  id: string;
  created_time: string;
  last_edited_time: string;
  properties: Record<string, unknown>;
  url: string;
  databaseId?: string;
}

export interface FixtureNotionBlock {
  id: string;
  type: string;
  [key: string]: unknown;
}

function titleProperty(text: string) {
  return { type: "title", title: [{ plain_text: text }] };
}

function richTextProperty(text: string) {
  return { type: "rich_text", rich_text: [{ plain_text: text }] };
}

function selectProperty(name: string) {
  return { type: "select", select: { name } };
}

/** Canonical pages keyed by id, grouped by database. */
export const SAMPLE_PAGES: FixtureNotionPage[] = [
  {
    id: "page-001",
    created_time: "2025-01-05T10:00:00.000Z",
    last_edited_time: "2025-03-10T10:00:00.000Z",
    url: "https://www.notion.so/page-001",
    databaseId: "db-engineering",
    properties: {
      Name: titleProperty("Architecture Overview"),
      Status: selectProperty("Published"),
      Owner: richTextProperty("Alice"),
    },
  },
  {
    id: "page-002",
    created_time: "2025-02-01T10:00:00.000Z",
    last_edited_time: "2025-03-20T10:00:00.000Z",
    url: "https://www.notion.so/page-002",
    databaseId: "db-engineering",
    properties: {
      Name: titleProperty("Release Process"),
      Status: selectProperty("Draft"),
    },
  },
  {
    id: "page-003",
    created_time: "2024-12-01T10:00:00.000Z",
    last_edited_time: "2024-12-05T10:00:00.000Z",
    url: "https://www.notion.so/page-003",
    databaseId: "db-engineering",
    properties: {
      Name: titleProperty("Old Notes"),
    },
  },
];

/** Blocks keyed by page id. The connector calls /v1/blocks/:id/children. */
export const SAMPLE_BLOCKS: Record<string, FixtureNotionBlock[]> = {
  "page-001": [
    {
      id: "b1",
      type: "heading_1",
      heading_1: { rich_text: [{ plain_text: "Architecture" }] },
    },
    {
      id: "b2",
      type: "paragraph",
      paragraph: {
        rich_text: [
          { plain_text: "This page describes the overall architecture." },
        ],
      },
    },
    {
      id: "b3",
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: [{ plain_text: "Service A" }] },
    },
    {
      id: "b4",
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: [{ plain_text: "Service B" }] },
    },
    {
      id: "b5",
      type: "code",
      code: {
        language: "typescript",
        rich_text: [{ plain_text: "const x = 1;" }],
      },
    },
  ],
  "page-002": [
    {
      id: "b10",
      type: "paragraph",
      paragraph: {
        rich_text: [{ plain_text: "Release steps and checklist." }],
      },
    },
    {
      id: "b11",
      type: "to_do",
      to_do: {
        checked: false,
        rich_text: [{ plain_text: "Tag release" }],
      },
    },
  ],
  "page-003": [
    {
      id: "b20",
      type: "paragraph",
      paragraph: { rich_text: [{ plain_text: "Legacy notes" }] },
    },
  ],
};

/** Build Notion mock routes for the subset the connector uses. */
export function buildNotionRoutes(
  opts: {
    pages?: FixtureNotionPage[];
    blocks?: Record<string, FixtureNotionBlock[]>;
    meStatus?: number;
  } = {},
): MockRoute[] {
  const pages = opts.pages ?? SAMPLE_PAGES;
  const blocks = opts.blocks ?? SAMPLE_BLOCKS;
  const meStatus = opts.meStatus ?? 200;

  return [
    {
      method: "GET",
      path: "/v1/users/me",
      handler: (_req, res) => {
        if (meStatus !== 200) {
          res.status(meStatus).json({ message: "Unauthorized", code: "unauthorized" });
          return;
        }
        res.json({ type: "bot", id: "bot-id", name: "Mock Bot" });
      },
    },
    {
      method: "POST",
      path: /^\/v1\/databases\/([^/]+)\/query$/,
      handler: (req, res) => {
        const databaseId = req.match?.[1];
        const body = req.json<{
          filter?: {
            timestamp?: string;
            last_edited_time?: { after?: string };
          };
        }>();

        let dbPages = pages.filter((p) => p.databaseId === databaseId);

        // Honor incremental filter: { timestamp: "last_edited_time", last_edited_time: { after } }
        if (body.filter?.timestamp === "last_edited_time" && body.filter.last_edited_time?.after) {
          const after = new Date(body.filter.last_edited_time.after);
          dbPages = dbPages.filter((p) => new Date(p.last_edited_time) > after);
        }

        res.json({
          results: dbPages,
          has_more: false,
          next_cursor: null,
        });
      },
    },
    {
      method: "GET",
      path: /^\/v1\/pages\/([^/]+)$/,
      handler: (req, res) => {
        const id = req.match?.[1];
        const page = pages.find((p) => p.id === id);
        if (!page) {
          res.status(404).json({ message: "Page not found" });
          return;
        }
        res.json(page);
      },
    },
    {
      method: "GET",
      path: /^\/v1\/blocks\/([^/]+)\/children$/,
      handler: (req, res) => {
        const id = req.match?.[1];
        const children = blocks[id!] || [];
        res.json({
          results: children,
          has_more: false,
          next_cursor: null,
        });
      },
    },
  ];
}
