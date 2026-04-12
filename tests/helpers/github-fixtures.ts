import type { MockRoute } from "./mock-server.js";

/**
 * Mock route builder for the GitHub REST API. The same fixture drives
 * both github.com (no path prefix) and GitHub Enterprise Server (where
 * the API lives under `/api/v3`) — pass `pathPrefix: "/api/v3"` to
 * mount the routes under the GHES layout.
 *
 * Only the endpoints our GitHub + CICD connectors actually hit are
 * implemented. Everything else falls through to the mock server's 404.
 */
export interface GitHubFixtureOptions {
  /** Path prefix to mount the routes under. "" for cloud, "/api/v3" for GHES. */
  pathPrefix?: string;
  /** Username the token belongs to. Defaults to "testuser". */
  authenticatedUser?: string;
  /** Owner whose repos to return. */
  owner?: string;
  /** Repos to list for that owner. */
  repos?: string[];
}

export function buildGitHubRoutes(
  options: GitHubFixtureOptions = {},
): MockRoute[] {
  const prefix = options.pathPrefix ?? "";
  const user = options.authenticatedUser ?? "testuser";
  const owner = options.owner ?? "acme";
  const repos = options.repos ?? ["widget"];

  const fixed = (suffix: string): string => `${prefix}${suffix}`;
  const dyn = (suffix: RegExp): RegExp => {
    if (!prefix) return suffix;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const src = suffix.source.startsWith("^") ? suffix.source.slice(1) : suffix.source;
    return new RegExp(`^${escaped}${src}`, suffix.flags);
  };

  const routes: MockRoute[] = [
    // --- auth ---
    {
      method: "GET",
      path: fixed("/user"),
      handler: (_req, res) => {
        res.status(200).json({ login: user, id: 1, type: "User" });
      },
    },
    {
      method: "GET",
      path: dyn(/^\/users\/[^/]+$/),
      handler: (req, res) => {
        const name = req.pathname.split("/").pop() ?? "unknown";
        res.status(200).json({ login: name, id: 2, type: "User" });
      },
    },

    // --- list repos for owner ---
    {
      method: "GET",
      path: dyn(/^\/users\/[^/]+\/repos$/),
      handler: (req, res) => {
        const u = req.pathname.split("/")[2];
        const data = repos.map((name, i) => ({
          id: 100 + i,
          name,
          full_name: `${u}/${name}`,
          owner: { login: u },
          private: false,
          html_url: `https://example.test/${u}/${name}`,
          default_branch: "main",
        }));
        res.status(200).json(data);
      },
    },

    // --- single repo (when config.repo is set) ---
    {
      method: "GET",
      path: dyn(/^\/repos\/[^/]+\/[^/]+$/),
      handler: (req, res) => {
        const parts = req.pathname.split("/");
        // [prefix..., '', 'repos', owner, repo]
        const o = parts[parts.length - 2];
        const r = parts[parts.length - 1];
        res.status(200).json({
          id: 42,
          name: r,
          full_name: `${o}/${r}`,
          owner: { login: o },
          private: false,
          html_url: `https://example.test/${o}/${r}`,
          default_branch: "main",
        });
      },
    },

    // --- README ---
    {
      method: "GET",
      path: dyn(/^\/repos\/[^/]+\/[^/]+\/readme$/),
      handler: (req, res) => {
        if (req.headers["accept"]?.includes("raw")) {
          res.status(200).header("content-type", "text/plain").send("# Hello\n");
          return;
        }
        const parts = req.pathname.split("/");
        const r = parts[parts.length - 2];
        res.status(200).json({
          name: "README.md",
          path: "README.md",
          content: Buffer.from(`# ${r}\n`).toString("base64"),
          encoding: "base64",
        });
      },
    },

    // --- issues for a repo ---
    {
      method: "GET",
      path: dyn(/^\/repos\/[^/]+\/[^/]+\/issues$/),
      handler: (_req, res) => {
        res.status(200).json([
          {
            id: 1001,
            number: 1,
            title: "First issue",
            body: "This is the first issue body.",
            state: "open",
            user: { login: "alice" },
            labels: [{ name: "bug" }],
            assignees: [{ login: "alice" }],
            comments: 0,
            pull_request: undefined,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
            html_url: "https://example.test/issues/1",
          },
        ]);
      },
    },

    // --- pull requests for a repo ---
    {
      method: "GET",
      path: dyn(/^\/repos\/[^/]+\/[^/]+\/pulls$/),
      handler: (_req, res) => {
        res.status(200).json([
          {
            id: 2001,
            number: 10,
            title: "First PR",
            body: "PR body.",
            state: "closed",
            merged_at: "2026-01-05T00:00:00Z",
            user: { login: "bob" },
            base: { ref: "main" },
            head: { ref: "feature" },
            review_comments: 0,
            created_at: "2026-01-03T00:00:00Z",
            updated_at: "2026-01-05T00:00:00Z",
            html_url: "https://example.test/pulls/10",
          },
        ]);
      },
    },

    // --- Actions: list workflow runs for a repo ---
    {
      method: "GET",
      path: dyn(/^\/repos\/[^/]+\/[^/]+\/actions\/runs$/),
      handler: (_req, res) => {
        res.status(200).json({
          total_count: 1,
          workflow_runs: [
            {
              id: 5001,
              name: "CI",
              run_number: 42,
              status: "completed",
              conclusion: "success",
              head_branch: "main",
              head_sha: "deadbeefcafebabefeed1234567890abcdef0000",
              html_url: "https://example.test/actions/runs/5001",
              created_at: "2026-02-01T00:00:00Z",
              updated_at: "2026-02-01T00:10:00Z",
              run_started_at: "2026-02-01T00:00:30Z",
              run_attempt: 1,
              event: "push",
            },
          ],
        });
      },
    },

    // --- Actions: jobs for a run ---
    {
      method: "GET",
      path: dyn(/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/jobs$/),
      handler: (_req, res) => {
        res.status(200).json({
          total_count: 1,
          jobs: [
            {
              id: 6001,
              name: "build",
              status: "completed",
              conclusion: "success",
              started_at: "2026-02-01T00:00:30Z",
              completed_at: "2026-02-01T00:09:00Z",
              steps: [
                { name: "checkout", status: "completed", conclusion: "success", number: 1 },
                { name: "build", status: "completed", conclusion: "success", number: 2 },
              ],
            },
          ],
        });
      },
    },
  ];

  return routes;
}
