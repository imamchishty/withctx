import { Octokit } from "@octokit/rest";
import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";
import type { GitHubSource } from "../types/config.js";

/**
 * Connector for GitHub repositories.
 * Uses @octokit/rest to fetch repos, READMEs, issues, and PRs.
 * Supports GitHub Enterprise via custom baseUrl.
 */
export class GitHubConnector implements SourceConnector {
  readonly type = "github" as const;
  readonly name: string;
  private octokit: Octokit;
  private owner: string;
  private repo?: string;
  private status: SourceStatus;

  constructor(config: GitHubSource & { baseUrl?: string }) {
    this.name = config.name;
    this.owner = config.owner;
    this.repo = config.repo;
    this.status = {
      name: config.name,
      type: "github",
      status: "disconnected",
    };

    const octokitOptions: ConstructorParameters<typeof Octokit>[0] = {
      auth: config.token,
    };
    if (config.baseUrl) {
      octokitOptions.baseUrl = config.baseUrl;
    }
    this.octokit = new Octokit(octokitOptions);
  }

  async validate(): Promise<boolean> {
    try {
      await this.octokit.rest.users.getAuthenticated();
      this.status.status = "connected";
      return true;
    } catch (error) {
      // Token might be a fine-grained token that can't call getAuthenticated.
      // Fall back to checking the owner exists.
      try {
        await this.octokit.rest.users.getByUsername({ username: this.owner });
        this.status.status = "connected";
        return true;
      } catch {
        this.status.status = "error";
        this.status.error = `Failed to authenticate with GitHub: ${error instanceof Error ? error.message : String(error)}`;
        return false;
      }
    }
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";
    let count = 0;

    try {
      const repos = await this.getRepos();

      for (const repo of repos) {
        // Fetch README
        try {
          const readme = await this.fetchReadme(repo.owner.login, repo.name);
          if (readme) {
            count++;
            yield readme;
            if (options?.limit && count >= options.limit) break;
          }
        } catch {
          // README may not exist, skip
        }

        // Fetch issues
        const issuesSince = options?.since?.toISOString();
        for await (const issue of this.fetchIssues(repo.owner.login, repo.name, issuesSince)) {
          count++;
          yield issue;
          if (options?.limit && count >= options.limit) break;
        }
        if (options?.limit && count >= options.limit) break;

        // Fetch PRs
        for await (const pr of this.fetchPullRequests(repo.owner.login, repo.name, issuesSince)) {
          count++;
          yield pr;
          if (options?.limit && count >= options.limit) break;
        }
        if (options?.limit && count >= options.limit) break;
      }

      this.status.status = "connected";
      this.status.lastSyncAt = new Date().toISOString();
      this.status.itemCount = count;
    } catch (error) {
      this.status.status = "error";
      this.status.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  getStatus(): SourceStatus {
    return { ...this.status };
  }

  private async getRepos(): Promise<Array<{ name: string; owner: { login: string }; full_name: string }>> {
    if (this.repo) {
      const { data } = await this.octokit.rest.repos.get({
        owner: this.owner,
        repo: this.repo,
      });
      return [data];
    }

    // List all repos for the owner
    const repos: Array<{ name: string; owner: { login: string }; full_name: string }> = [];
    for await (const response of this.octokit.paginate.iterator(
      this.octokit.rest.repos.listForUser,
      { username: this.owner, per_page: 100, sort: "updated" }
    )) {
      repos.push(...response.data);
    }
    return repos;
  }

  private async fetchReadme(owner: string, repo: string): Promise<RawDocument | null> {
    try {
      const { data } = await this.octokit.rest.repos.getReadme({
        owner,
        repo,
        mediaType: { format: "raw" },
      });

      const content = typeof data === "string" ? data : String(data);

      return {
        id: `github:${this.name}:${owner}/${repo}:readme`,
        sourceType: "github",
        sourceName: this.name,
        title: `${owner}/${repo} - README`,
        content,
        contentType: "text",
        url: `https://github.com/${owner}/${repo}#readme`,
        metadata: {
          owner,
          repo,
          docType: "readme",
        },
      };
    } catch {
      return null;
    }
  }

  private async *fetchIssues(
    owner: string,
    repo: string,
    since?: string
  ): AsyncGenerator<RawDocument> {
    const params: Parameters<typeof this.octokit.rest.issues.listForRepo>[0] = {
      owner,
      repo,
      state: "all",
      per_page: 100,
      sort: "updated",
      direction: "desc",
    };
    if (since) {
      params.since = since;
    }

    for await (const response of this.octokit.paginate.iterator(
      this.octokit.rest.issues.listForRepo,
      params
    )) {
      for (const issue of response.data) {
        // Skip pull requests (GitHub API includes them in issues endpoint)
        if (issue.pull_request) continue;

        const labels = issue.labels
          .map((l) => (typeof l === "string" ? l : l.name))
          .filter(Boolean);

        let content = issue.body || "(no description)";
        content = `# ${issue.title}\n\n**State:** ${issue.state}\n**Labels:** ${labels.join(", ") || "none"}\n**Author:** ${issue.user?.login || "unknown"}\n\n${content}`;

        yield {
          id: `github:${this.name}:${owner}/${repo}:issue:${issue.number}`,
          sourceType: "github",
          sourceName: this.name,
          title: `${owner}/${repo} #${issue.number}: ${issue.title}`,
          content,
          contentType: "text",
          url: issue.html_url,
          author: issue.user?.login,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          metadata: {
            owner,
            repo,
            docType: "issue",
            number: issue.number,
            state: issue.state,
            labels,
            assignees: issue.assignees?.map((a) => a.login) || [],
            commentCount: issue.comments,
          },
        };
      }
    }
  }

  private async *fetchPullRequests(
    owner: string,
    repo: string,
    since?: string
  ): AsyncGenerator<RawDocument> {
    const params: Parameters<typeof this.octokit.rest.pulls.list>[0] = {
      owner,
      repo,
      state: "all",
      per_page: 100,
      sort: "updated",
      direction: "desc",
    };

    for await (const response of this.octokit.paginate.iterator(
      this.octokit.rest.pulls.list,
      params
    )) {
      for (const pr of response.data) {
        // Incremental filter for PRs
        if (since && pr.updated_at && new Date(pr.updated_at) < new Date(since)) {
          return; // PRs sorted by updated desc, so we can stop
        }

        let content = pr.body || "(no description)";
        content = `# ${pr.title}\n\n**State:** ${pr.state}${pr.merged_at ? " (merged)" : ""}\n**Author:** ${pr.user?.login || "unknown"}\n**Base:** ${pr.base.ref} <- ${pr.head.ref}\n\n${content}`;

        yield {
          id: `github:${this.name}:${owner}/${repo}:pr:${pr.number}`,
          sourceType: "github",
          sourceName: this.name,
          title: `${owner}/${repo} PR #${pr.number}: ${pr.title}`,
          content,
          contentType: "text",
          url: pr.html_url,
          author: pr.user?.login,
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          metadata: {
            owner,
            repo,
            docType: "pull_request",
            number: pr.number,
            state: pr.state,
            merged: !!pr.merged_at,
            mergedAt: pr.merged_at,
            baseBranch: pr.base.ref,
            headBranch: pr.head.ref,
            reviewComments: (pr as unknown as { review_comments: number }).review_comments,
          },
        };
      }
    }
  }
}
