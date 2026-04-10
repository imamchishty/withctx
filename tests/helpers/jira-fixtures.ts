import type { MockRoute } from "./mock-server.js";

/** Minimal Jira issue fixture shape. Matches what the connector reads. */
export interface FixtureJiraIssue {
  key: string;
  id: string;
  self: string;
  fields: {
    summary: string;
    description: string | null;
    status: { name: string };
    issuetype: { name: string };
    priority?: { name: string };
    assignee?: { displayName: string; emailAddress?: string } | null;
    reporter?: { displayName: string; emailAddress?: string } | null;
    labels: string[];
    components: Array<{ name: string }>;
    fixVersions: Array<{ name: string }>;
    created: string;
    updated: string;
    resolution?: { name: string } | null;
    parent?: { key: string; fields?: { summary?: string } };
    project?: { key: string };
    comment?: {
      comments: Array<{
        author: { displayName: string };
        body: string;
        created: string;
        updated: string;
      }>;
      total: number;
    };
    issuelinks?: Array<unknown>;
  };
}

function buildIssue(
  overrides: Partial<FixtureJiraIssue> & { key: string; project: string },
): FixtureJiraIssue {
  return {
    id: overrides.key.replace(/\D/g, "") || "1",
    self: `http://jira.mock/rest/api/2/issue/${overrides.key}`,
    key: overrides.key,
    fields: {
      summary: `Summary for ${overrides.key}`,
      description: `Description for ${overrides.key}`,
      status: { name: "In Progress" },
      issuetype: { name: "Task" },
      priority: { name: "Medium" },
      assignee: { displayName: "Alice Engineer" },
      reporter: { displayName: "Bob Manager" },
      labels: [],
      components: [],
      fixVersions: [],
      created: "2025-01-10T10:00:00.000+0000",
      updated: "2025-03-15T10:00:00.000+0000",
      resolution: null,
      project: { key: overrides.project },
      comment: { comments: [], total: 0 },
      issuelinks: [],
      ...(overrides.fields || {}),
    },
  };
}

/** A larger set of issues so we can test pagination (page size = 50). */
export function buildSampleIssues(): FixtureJiraIssue[] {
  const issues: FixtureJiraIssue[] = [];

  // 3 issues in PROJECT ALPHA with varied statuses
  issues.push(
    buildIssue({
      key: "ALPHA-1",
      project: "ALPHA",
      fields: {
        summary: "Ship onboarding flow",
        description: "Build the initial onboarding experience.",
        status: { name: "In Progress" },
        issuetype: { name: "Story" },
        priority: { name: "High" },
        assignee: { displayName: "Alice" },
        reporter: { displayName: "Bob" },
        labels: ["onboarding"],
        components: [{ name: "frontend" }],
        fixVersions: [],
        created: "2025-01-01T00:00:00.000+0000",
        updated: "2025-03-15T10:00:00.000+0000",
      },
    }),
    buildIssue({
      key: "ALPHA-2",
      project: "ALPHA",
      fields: {
        summary: "Fix login bug",
        description: "Users cannot log in on Safari.",
        status: { name: "Done" },
        issuetype: { name: "Bug" },
        priority: { name: "Critical" },
        assignee: { displayName: "Alice" },
        reporter: { displayName: "Bob" },
        labels: [],
        components: [],
        fixVersions: [{ name: "1.1.0" }],
        created: "2025-02-01T00:00:00.000+0000",
        updated: "2025-02-15T00:00:00.000+0000",
        resolution: { name: "Fixed" },
      },
    }),
    buildIssue({
      key: "ALPHA-3",
      project: "ALPHA",
      fields: {
        summary: "Obsolete ticket",
        description: "This will be closed.",
        status: { name: "Closed" },
        issuetype: { name: "Task" },
        priority: { name: "Low" },
        assignee: null,
        reporter: { displayName: "Bob" },
        labels: ["stale"],
        components: [],
        fixVersions: [],
        created: "2024-11-01T00:00:00.000+0000",
        updated: "2024-12-01T00:00:00.000+0000",
      },
    }),
  );

  // 2 issues in PROJECT BETA
  issues.push(
    buildIssue({
      key: "BETA-1",
      project: "BETA",
      fields: {
        summary: "Add billing integration",
        description: "Stripe integration",
        status: { name: "In Progress" },
        issuetype: { name: "Story" },
        priority: { name: "High" },
        assignee: { displayName: "Charlie" },
        reporter: { displayName: "Dana" },
        labels: ["billing"],
        components: [],
        fixVersions: [],
        created: "2025-02-20T00:00:00.000+0000",
        updated: "2025-03-10T00:00:00.000+0000",
      },
    }),
    buildIssue({
      key: "BETA-2",
      project: "BETA",
      fields: {
        summary: "Beta feedback survey",
        description: null,
        status: { name: "To Do" },
        issuetype: { name: "Task" },
        priority: { name: "Medium" },
        assignee: null,
        reporter: { displayName: "Dana" },
        labels: [],
        components: [],
        fixVersions: [],
        created: "2025-03-01T00:00:00.000+0000",
        updated: "2025-03-05T00:00:00.000+0000",
      },
    }),
  );

  // Fill up PAGINATION project with 60 issues so we get 2 pages of 50.
  for (let i = 1; i <= 60; i++) {
    issues.push(
      buildIssue({
        key: `PAGE-${i}`,
        project: "PAGINATION",
        fields: {
          summary: `Paginated issue ${i}`,
          description: `Content ${i}`,
          status: { name: "Open" },
          issuetype: { name: "Task" },
          assignee: null,
          reporter: { displayName: "Bot" },
          labels: [],
          components: [],
          fixVersions: [],
          created: "2025-01-01T00:00:00.000+0000",
          updated: "2025-01-01T00:00:00.000+0000",
        },
      }),
    );
  }

  return issues;
}

export const SAMPLE_ISSUES = buildSampleIssues();

/**
 * Extract a project key from a JQL like `project = "ALPHA" ORDER BY ...`.
 */
function extractProjectFromJql(jql: string): string | undefined {
  const m = jql.match(/project\s*=\s*"([^"]+)"/);
  return m?.[1];
}

/**
 * Build Jira mock routes. Implements:
 *  - GET /rest/api/2/myself
 *  - GET /rest/api/2/search
 *  - GET /rest/api/2/issue/:key
 *
 * The connector uses API v2 (see src/connectors/jira.ts).
 */
export function buildJiraRoutes(
  opts: {
    issues?: FixtureJiraIssue[];
    myselfStatus?: number;
  } = {},
): MockRoute[] {
  const issues = opts.issues ?? SAMPLE_ISSUES;
  const myselfStatus = opts.myselfStatus ?? 200;

  return [
    {
      method: "GET",
      path: "/rest/api/2/myself",
      handler: (_req, res) => {
        if (myselfStatus !== 200) {
          res.status(myselfStatus).json({ message: "Unauthorized" });
          return;
        }
        res.json({
          accountId: "test-account",
          displayName: "Test User",
          emailAddress: "test@example.com",
        });
      },
    },
    {
      method: "GET",
      path: "/rest/api/2/search",
      handler: (req, res) => {
        const jql = req.query.jql || "";
        const startAt = parseInt(req.query.startAt || "0", 10);
        const maxResults = parseInt(req.query.maxResults || "50", 10);

        const projectFilter = extractProjectFromJql(jql);
        let filtered = issues;
        if (projectFilter) {
          filtered = issues.filter((i) => i.fields.project?.key === projectFilter);
        }

        const slice = filtered.slice(startAt, startAt + maxResults);
        res.json({
          issues: slice,
          total: filtered.length,
          startAt,
          maxResults,
        });
      },
    },
    {
      method: "GET",
      path: /^\/rest\/api\/2\/issue\/([A-Z0-9-]+)$/,
      handler: (req, res) => {
        const key = req.match?.[1];
        const issue = issues.find((i) => i.key === key);
        if (!issue) {
          res.status(404).json({ message: "Issue Not Found" });
          return;
        }
        res.json(issue);
      },
    },
  ];
}
