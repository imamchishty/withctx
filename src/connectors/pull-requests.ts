import { Octokit } from "@octokit/rest";
import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";
import type { PullRequestsSource } from "../types/config.js";

interface PullRequestData {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  labels: Array<{ name?: string } | string>;
  base: { ref: string };
  head: { ref: string };
  additions: number;
  deletions: number;
  changed_files: number;
}

interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

interface PullRequestReview {
  user: { login: string } | null;
  state: string;
  submitted_at: string | null;
}

/**
 * Connector for pull request history.
 * Fetches merged/open PR data from GitHub to understand recent changes and patterns.
 */
export class PullRequestsConnector implements SourceConnector {
  readonly type = "pull-requests" as const;
  readonly name: string;
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private include: "merged" | "open" | "all";
  private sinceDuration: string;
  private labels: string[];
  private status: SourceStatus;

  constructor(config: PullRequestsSource) {
    this.name = config.name;
    this.include = config.include || "merged";
    this.sinceDuration = config.since || "30d";
    this.labels = config.labels || [];

    const [owner, repo] = config.repo.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid repo format "${config.repo}". Expected "owner/repo".`);
    }
    this.owner = owner;
    this.repo = repo;

    this.status = {
      name: config.name,
      type: "pull-requests",
      status: "disconnected",
    };

    const token = config.token || process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error("No token provided and GITHUB_TOKEN env var not set.");
    }

    this.octokit = new Octokit({ auth: token });
  }

  async validate(): Promise<boolean> {
    try {
      await this.octokit.rest.repos.get({
        owner: this.owner,
        repo: this.repo,
      });
      this.status.status = "connected";
      return true;
    } catch (error) {
      this.status.status = "error";
      this.status.error = `Failed to validate pull-requests connector: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";
    let count = 0;

    try {
      const sinceDate = options?.since || this.parseDuration(this.sinceDuration);
      const prs = await this.fetchPullRequests(sinceDate);

      // Filter by labels if specified
      const filteredPrs = this.labels.length > 0
        ? prs.filter((pr) => {
            const prLabels = pr.labels.map((l) =>
              typeof l === "string" ? l : l.name || ""
            );
            return this.labels.some((label) => prLabels.includes(label));
          })
        : prs;

      // Yield individual PR documents
      for (const pr of filteredPrs) {
        const doc = await this.buildPrDocument(pr);
        count++;
        yield doc;
        if (options?.limit && count >= options.limit) break;
      }

      // Yield summary documents
      if (!options?.limit || count < options.limit) {
        const activitySummary = this.buildActivitySummary(filteredPrs);
        count++;
        yield activitySummary;
      }

      if (!options?.limit || count < options.limit) {
        const recentChanges = this.buildRecentChangesDocument(filteredPrs);
        count++;
        yield recentChanges;
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

  private async fetchPullRequests(since: Date): Promise<PullRequestData[]> {
    const prs: PullRequestData[] = [];
    const state = this.include === "open" ? "open" : this.include === "merged" ? "closed" : "all";

    for await (const response of this.octokit.paginate.iterator(
      this.octokit.rest.pulls.list,
      {
        owner: this.owner,
        repo: this.repo,
        state,
        sort: "updated",
        direction: "desc",
        per_page: 100,
      }
    )) {
      for (const pr of response.data) {
        const prData = pr as unknown as PullRequestData;

        // Stop pagination if we've gone past the since date
        if (new Date(prData.updated_at) < since) {
          return prs;
        }

        // Filter merged-only if include is "merged"
        if (this.include === "merged" && !prData.merged_at) {
          continue;
        }

        prs.push(prData);
      }
    }

    return prs;
  }

  private async fetchFilesForPr(prNumber: number): Promise<PullRequestFile[]> {
    try {
      const { data } = await this.octokit.rest.pulls.listFiles({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100,
      });
      return data as unknown as PullRequestFile[];
    } catch {
      return [];
    }
  }

  private async fetchReviewsForPr(prNumber: number): Promise<PullRequestReview[]> {
    try {
      const { data } = await this.octokit.rest.pulls.listReviews({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      });
      return data as unknown as PullRequestReview[];
    } catch {
      return [];
    }
  }

  private async buildPrDocument(pr: PullRequestData): Promise<RawDocument> {
    const [files, reviews] = await Promise.all([
      this.fetchFilesForPr(pr.number),
      this.fetchReviewsForPr(pr.number),
    ]);

    const labels = pr.labels
      .map((l) => (typeof l === "string" ? l : l.name || ""))
      .filter(Boolean);
    const reviewers = [...new Set(reviews.map((r) => r.user?.login).filter(Boolean))];
    const approvedBy = reviews
      .filter((r) => r.state === "APPROVED")
      .map((r) => r.user?.login)
      .filter(Boolean);

    let content = `# PR #${pr.number}: ${pr.title}\n\n`;
    content += `| Field | Value |\n|-------|-------|\n`;
    content += `| **Author** | ${pr.user?.login || "unknown"} |\n`;
    content += `| **State** | ${pr.state}${pr.merged_at ? " (merged)" : ""} |\n`;
    content += `| **Base** | ${pr.base.ref} <- ${pr.head.ref} |\n`;
    content += `| **Labels** | ${labels.join(", ") || "none"} |\n`;
    content += `| **Reviewers** | ${reviewers.join(", ") || "none"} |\n`;
    content += `| **Approved by** | ${approvedBy.join(", ") || "none"} |\n`;
    content += `| **Created** | ${pr.created_at} |\n`;
    if (pr.merged_at) {
      content += `| **Merged** | ${pr.merged_at} |\n`;
    }
    content += `| **Changes** | +${pr.additions} / -${pr.deletions} across ${pr.changed_files} files |\n`;
    content += `| **URL** | ${pr.html_url} |\n\n`;

    // Description
    if (pr.body) {
      content += `## Description\n\n${pr.body}\n\n`;
    }

    // Files changed
    if (files.length > 0) {
      content += `## Files Changed\n\n`;
      content += `| File | Status | +/- |\n|------|--------|-----|\n`;
      for (const file of files) {
        content += `| ${file.filename} | ${file.status} | +${file.additions}/-${file.deletions} |\n`;
      }
      content += "\n";
    }

    // Review timeline
    if (reviews.length > 0) {
      content += `## Reviews\n\n`;
      content += `| Reviewer | State | Date |\n|----------|-------|------|\n`;
      for (const review of reviews) {
        content += `| ${review.user?.login || "unknown"} | ${review.state} | ${review.submitted_at || "N/A"} |\n`;
      }
      content += "\n";
    }

    return {
      id: `pull-requests:${this.name}:${this.owner}/${this.repo}:pr:${pr.number}`,
      sourceType: "pull-requests",
      sourceName: this.name,
      title: `PR #${pr.number}: ${pr.title}`,
      content,
      contentType: "text",
      url: pr.html_url,
      author: pr.user?.login,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      metadata: {
        repo: `${this.owner}/${this.repo}`,
        number: pr.number,
        author: pr.user?.login,
        reviewers,
        filesChanged: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
        mergedAt: pr.merged_at,
        labels,
      },
    };
  }

  private buildActivitySummary(prs: PullRequestData[]): RawDocument {
    const now = new Date();

    // PRs per week
    const weekMap = new Map<string, number>();
    for (const pr of prs) {
      const date = new Date(pr.merged_at || pr.created_at);
      const weekStart = new Date(date);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const weekKey = weekStart.toISOString().split("T")[0]!;
      weekMap.set(weekKey, (weekMap.get(weekKey) || 0) + 1);
    }

    // Avg review time (created -> merged)
    const reviewTimes: number[] = [];
    for (const pr of prs) {
      if (pr.merged_at) {
        const created = new Date(pr.created_at).getTime();
        const merged = new Date(pr.merged_at).getTime();
        reviewTimes.push((merged - created) / (1000 * 60 * 60)); // hours
      }
    }
    const avgReviewTime = reviewTimes.length > 0
      ? reviewTimes.reduce((a, b) => a + b, 0) / reviewTimes.length
      : 0;

    // Most active contributors
    const authorCounts = new Map<string, number>();
    for (const pr of prs) {
      const author = pr.user?.login || "unknown";
      authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
    }

    // Most changed files/directories
    const dirCounts = new Map<string, number>();
    // We don't have file data in the summary PR objects, so track from metadata we do have
    // Instead, count by PR changed_files as a proxy
    for (const pr of prs) {
      // Track branches as a proxy for area of change
      const branch = pr.head.ref;
      const prefix = branch.split("/")[0] || branch;
      dirCounts.set(prefix, (dirCounts.get(prefix) || 0) + 1);
    }

    // Common labels
    const labelCounts = new Map<string, number>();
    for (const pr of prs) {
      const labels = pr.labels.map((l) => (typeof l === "string" ? l : l.name || "")).filter(Boolean);
      for (const label of labels) {
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
      }
    }

    let content = `# PR Activity Summary for ${this.owner}/${this.repo}\n\n`;
    content += `**Period:** ${this.sinceDuration}\n`;
    content += `**Total PRs:** ${prs.length}\n`;
    content += `**Avg Review Time:** ${avgReviewTime > 0 ? this.formatHours(avgReviewTime) : "N/A"}\n\n`;

    content += `## PRs per Week\n\n`;
    content += `| Week Starting | PRs |\n|---------------|-----|\n`;
    const sortedWeeks = [...weekMap.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    for (const [week, count] of sortedWeeks) {
      content += `| ${week} | ${count} |\n`;
    }
    content += "\n";

    content += `## Most Active Contributors\n\n`;
    content += `| Author | PRs |\n|--------|-----|\n`;
    const sortedAuthors = [...authorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [author, count] of sortedAuthors) {
      content += `| ${author} | ${count} |\n`;
    }
    content += "\n";

    if (labelCounts.size > 0) {
      content += `## Common Labels\n\n`;
      content += `| Label | Count |\n|-------|-------|\n`;
      const sortedLabels = [...labelCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [label, count] of sortedLabels) {
        content += `| ${label} | ${count} |\n`;
      }
      content += "\n";
    }

    content += `## Change Volume\n\n`;
    const totalAdditions = prs.reduce((sum, pr) => sum + pr.additions, 0);
    const totalDeletions = prs.reduce((sum, pr) => sum + pr.deletions, 0);
    const totalFilesChanged = prs.reduce((sum, pr) => sum + pr.changed_files, 0);
    content += `| Metric | Value |\n|--------|-------|\n`;
    content += `| Total Additions | +${totalAdditions} |\n`;
    content += `| Total Deletions | -${totalDeletions} |\n`;
    content += `| Total Files Changed | ${totalFilesChanged} |\n`;
    content += `| Avg Files per PR | ${prs.length > 0 ? (totalFilesChanged / prs.length).toFixed(1) : "0"} |\n\n`;

    return {
      id: `pull-requests:${this.name}:${this.owner}/${this.repo}:activity-summary`,
      sourceType: "pull-requests",
      sourceName: this.name,
      title: `PR Activity Summary for ${this.owner}/${this.repo}`,
      content,
      contentType: "text",
      url: `https://github.com/${this.owner}/${this.repo}/pulls`,
      metadata: {
        repo: `${this.owner}/${this.repo}`,
        totalPrs: prs.length,
        avgReviewTimeHours: parseFloat(avgReviewTime.toFixed(1)),
        totalAdditions,
        totalDeletions,
        timestamp: now.toISOString(),
      },
    };
  }

  private buildRecentChangesDocument(prs: PullRequestData[]): RawDocument {
    // Sort by merged_at or created_at, most recent first
    const sorted = [...prs].sort((a, b) => {
      const aDate = a.merged_at || a.created_at;
      const bDate = b.merged_at || b.created_at;
      return new Date(bDate).getTime() - new Date(aDate).getTime();
    });

    const recent = sorted.slice(0, 20);

    let content = `# Recent Changes for ${this.owner}/${this.repo}\n\n`;
    content += `Last ${recent.length} PRs:\n\n`;
    content += `| # | Title | Author | Date | +/- |\n|---|-------|--------|------|-----|\n`;

    for (const pr of recent) {
      const date = (pr.merged_at || pr.created_at).split("T")[0];
      const title = pr.title.length > 60 ? pr.title.substring(0, 57) + "..." : pr.title;
      content += `| [#${pr.number}](${pr.html_url}) | ${title} | ${pr.user?.login || "?"} | ${date} | +${pr.additions}/-${pr.deletions} |\n`;
    }
    content += "\n";

    return {
      id: `pull-requests:${this.name}:${this.owner}/${this.repo}:recent-changes`,
      sourceType: "pull-requests",
      sourceName: this.name,
      title: `Recent Changes for ${this.owner}/${this.repo}`,
      content,
      contentType: "text",
      url: `https://github.com/${this.owner}/${this.repo}/pulls?q=is%3Apr+is%3Amerged+sort%3Aupdated-desc`,
      metadata: {
        repo: `${this.owner}/${this.repo}`,
        count: recent.length,
        timestamp: new Date().toISOString(),
      },
    };
  }

  private parseDuration(duration: string): Date {
    const match = duration.match(/^(\d+)([dhwm])$/);
    if (!match) {
      // Default to 30 days
      const date = new Date();
      date.setDate(date.getDate() - 30);
      return date;
    }

    const value = parseInt(match[1]!, 10);
    const unit = match[2]!;
    const date = new Date();

    switch (unit) {
      case "d":
        date.setDate(date.getDate() - value);
        break;
      case "h":
        date.setHours(date.getHours() - value);
        break;
      case "w":
        date.setDate(date.getDate() - value * 7);
        break;
      case "m":
        date.setMonth(date.getMonth() - value);
        break;
    }

    return date;
  }

  private formatHours(hours: number): string {
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 24) return `${hours.toFixed(1)}h`;
    const days = Math.floor(hours / 24);
    const remainingHours = Math.round(hours % 24);
    return `${days}d ${remainingHours}h`;
  }
}
