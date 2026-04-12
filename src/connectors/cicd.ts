import { Octokit } from "@octokit/rest";
import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";
import type { CicdSource } from "../types/config.js";
import { resolveGitHubBaseUrl, resolveGitHubToken } from "./github-url.js";

interface WorkflowRun {
  id: number;
  name: string | null;
  run_number: number;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  run_attempt?: number;
  event: string;
}

interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    number: number;
  }>;
}

/**
 * Connector for CI/CD pipeline data.
 *
 * Currently supports GitHub Actions (both github.com and GitHub
 * Enterprise Server). Extensible to Jenkins and GitLab CI, not yet
 * wired.
 *
 * Like the `github` source, this connector picks up `GITHUB_TOKEN`
 * from the environment and `GITHUB_API_URL` from Actions runners so
 * running it inside a workflow needs zero config.
 */
export class CicdConnector implements SourceConnector {
  readonly type = "cicd" as const;
  readonly name: string;
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private provider: string;
  private limit: number;
  private status: SourceStatus;
  /** Effective API base URL after normalisation — exposed for diagnostics. */
  readonly effectiveBaseUrl: string;

  constructor(config: CicdSource) {
    this.name = config.name;
    this.provider = config.provider;
    this.limit = config.limit ?? 50;

    const [owner, repo] = config.repo.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid repo format "${config.repo}". Expected "owner/repo".`);
    }
    this.owner = owner;
    this.repo = repo;

    this.status = {
      name: config.name,
      type: "cicd",
      status: "disconnected",
    };

    const token = resolveGitHubToken(config.token);
    if (!token) {
      throw new Error(
        `CI/CD source "${config.name}" has no token. Set it in ctx.yaml or ` +
          `export GITHUB_TOKEN / GH_TOKEN in your environment (GitHub Actions ` +
          `sets GITHUB_TOKEN for you automatically).`,
      );
    }

    const baseUrl = resolveGitHubBaseUrl(config.base_url);
    this.effectiveBaseUrl = baseUrl ?? "https://api.github.com";

    const octokitOptions: ConstructorParameters<typeof Octokit>[0] = { auth: token };
    if (baseUrl) {
      octokitOptions.baseUrl = baseUrl;
    }
    this.octokit = new Octokit(octokitOptions);
  }

  async validate(): Promise<boolean> {
    try {
      if (this.provider !== "github-actions") {
        this.status.status = "error";
        this.status.error = `Provider "${this.provider}" is not yet supported. Use "github-actions".`;
        return false;
      }

      await this.octokit.rest.repos.get({
        owner: this.owner,
        repo: this.repo,
      });
      this.status.status = "connected";
      return true;
    } catch (error) {
      this.status.status = "error";
      this.status.error = `Failed to validate CI/CD connector: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";
    let count = 0;

    try {
      const runs = await this.fetchWorkflowRuns(options?.since);

      // Yield individual run documents
      for (const run of runs) {
        const doc = await this.buildRunDocument(run);
        count++;
        yield doc;
        if (options?.limit && count >= options.limit) break;
      }

      // Yield summary document
      if (!options?.limit || count < options.limit) {
        const summary = this.buildSummaryDocument(runs);
        count++;
        yield summary;
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

  private async fetchWorkflowRuns(since?: Date): Promise<WorkflowRun[]> {
    const runs: WorkflowRun[] = [];
    const params: Record<string, unknown> = {
      owner: this.owner,
      repo: this.repo,
      per_page: Math.min(this.limit, 100),
    };

    if (since) {
      params.created = `>=${since.toISOString().split("T")[0]}`;
    }

    for await (const response of this.octokit.paginate.iterator(
      this.octokit.rest.actions.listWorkflowRunsForRepo,
      params as Parameters<typeof this.octokit.rest.actions.listWorkflowRunsForRepo>[0]
    )) {
      for (const run of response.data) {
        runs.push(run as unknown as WorkflowRun);
        if (runs.length >= this.limit) break;
      }
      if (runs.length >= this.limit) break;
    }

    return runs;
  }

  private async fetchJobsForRun(runId: number): Promise<WorkflowJob[]> {
    try {
      const { data } = await this.octokit.rest.actions.listJobsForWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        run_id: runId,
      });
      return data.jobs as unknown as WorkflowJob[];
    } catch {
      return [];
    }
  }

  private async buildRunDocument(run: WorkflowRun): Promise<RawDocument> {
    const jobs = await this.fetchJobsForRun(run.id);
    const duration = this.calculateDuration(run);
    const status = run.conclusion || run.status || "unknown";
    const workflowName = run.name || "Unknown Workflow";

    let content = `# CI: ${workflowName} #${run.run_number} -- ${status}\n\n`;
    content += `| Field | Value |\n|-------|-------|\n`;
    content += `| **Workflow** | ${workflowName} |\n`;
    content += `| **Status** | ${status} |\n`;
    content += `| **Branch** | ${run.head_branch || "unknown"} |\n`;
    content += `| **Commit** | \`${run.head_sha.substring(0, 7)}\` |\n`;
    content += `| **Event** | ${run.event} |\n`;
    content += `| **Started** | ${run.run_started_at || run.created_at} |\n`;
    content += `| **Duration** | ${duration ? this.formatDuration(duration) : "N/A"} |\n`;
    content += `| **Attempt** | ${run.run_attempt || 1} |\n`;
    content += `| **URL** | ${run.html_url} |\n\n`;

    if (jobs.length > 0) {
      content += `## Jobs\n\n`;
      content += `| Job | Status | Duration |\n|-----|--------|----------|\n`;
      for (const job of jobs) {
        const jobDuration = job.started_at && job.completed_at
          ? this.calculateTimeDiff(job.started_at, job.completed_at)
          : null;
        const jobStatus = job.conclusion || job.status;
        content += `| ${job.name} | ${jobStatus} | ${jobDuration ? this.formatDuration(jobDuration) : "N/A"} |\n`;
      }
      content += "\n";

      // Include failed job step details
      const failedJobs = jobs.filter((j) => j.conclusion === "failure");
      if (failedJobs.length > 0) {
        content += `## Failures\n\n`;
        for (const job of failedJobs) {
          content += `### ${job.name}\n\n`;
          if (job.steps) {
            const failedSteps = job.steps.filter((s) => s.conclusion === "failure");
            for (const step of failedSteps) {
              content += `- **Step ${step.number}:** ${step.name} -- ${step.conclusion}\n`;
            }
          }
          content += "\n";
        }
      }
    }

    return {
      id: `cicd:${this.name}:${this.owner}/${this.repo}:run:${run.id}`,
      sourceType: "cicd",
      sourceName: this.name,
      title: `CI: ${workflowName} #${run.run_number} -- ${status}`,
      content,
      contentType: "text",
      url: run.html_url,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      metadata: {
        provider: this.provider,
        repo: `${this.owner}/${this.repo}`,
        workflowName,
        status,
        duration,
        branch: run.head_branch,
      },
    };
  }

  private buildSummaryDocument(runs: WorkflowRun[]): RawDocument {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentRuns = runs.filter((r) => new Date(r.created_at) >= thirtyDaysAgo);

    const totalRuns = recentRuns.length;
    const successRuns = recentRuns.filter((r) => r.conclusion === "success").length;
    const failureRuns = recentRuns.filter((r) => r.conclusion === "failure").length;
    const cancelledRuns = recentRuns.filter((r) => r.conclusion === "cancelled").length;
    const successRate = totalRuns > 0 ? ((successRuns / totalRuns) * 100).toFixed(1) : "N/A";

    const durations = recentRuns
      .map((r) => this.calculateDuration(r))
      .filter((d): d is number => d !== null);
    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null;

    // Workflow breakdown
    const workflowStats = new Map<string, { total: number; success: number; failure: number }>();
    for (const run of recentRuns) {
      const name = run.name || "Unknown";
      const stats = workflowStats.get(name) || { total: 0, success: 0, failure: 0 };
      stats.total++;
      if (run.conclusion === "success") stats.success++;
      if (run.conclusion === "failure") stats.failure++;
      workflowStats.set(name, stats);
    }

    // Branch breakdown
    const branchCounts = new Map<string, number>();
    for (const run of recentRuns) {
      const branch = run.head_branch || "unknown";
      branchCounts.set(branch, (branchCounts.get(branch) || 0) + 1);
    }

    let content = `# CI Summary for ${this.owner}/${this.repo}\n\n`;
    content += `**Period:** Last 30 days\n\n`;
    content += `## Overview\n\n`;
    content += `| Metric | Value |\n|--------|-------|\n`;
    content += `| Total Runs | ${totalRuns} |\n`;
    content += `| Success Rate | ${successRate}% |\n`;
    content += `| Successes | ${successRuns} |\n`;
    content += `| Failures | ${failureRuns} |\n`;
    content += `| Cancelled | ${cancelledRuns} |\n`;
    content += `| Avg Build Time | ${avgDuration ? this.formatDuration(avgDuration) : "N/A"} |\n`;
    content += `| Deploy Frequency | ${(totalRuns / 4.3).toFixed(1)} runs/week |\n\n`;

    content += `## Workflow Breakdown\n\n`;
    content += `| Workflow | Runs | Success | Failure | Success Rate |\n|----------|------|---------|---------|-------------|\n`;
    for (const [name, stats] of workflowStats) {
      const rate = stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) : "0";
      content += `| ${name} | ${stats.total} | ${stats.success} | ${stats.failure} | ${rate}% |\n`;
    }
    content += "\n";

    content += `## Branch Activity\n\n`;
    content += `| Branch | Runs |\n|--------|------|\n`;
    const sortedBranches = [...branchCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [branch, count] of sortedBranches) {
      content += `| ${branch} | ${count} |\n`;
    }
    content += "\n";

    // Most common failures
    const failedRuns = recentRuns.filter((r) => r.conclusion === "failure");
    if (failedRuns.length > 0) {
      content += `## Most Common Failures\n\n`;
      const failureWorkflows = new Map<string, number>();
      for (const run of failedRuns) {
        const name = run.name || "Unknown";
        failureWorkflows.set(name, (failureWorkflows.get(name) || 0) + 1);
      }
      const sortedFailures = [...failureWorkflows.entries()].sort((a, b) => b[1] - a[1]);
      content += `| Workflow | Failure Count |\n|----------|---------------|\n`;
      for (const [name, count] of sortedFailures) {
        content += `| ${name} | ${count} |\n`;
      }
      content += "\n";
    }

    return {
      id: `cicd:${this.name}:${this.owner}/${this.repo}:summary`,
      sourceType: "cicd",
      sourceName: this.name,
      title: `CI Summary for ${this.owner}/${this.repo}`,
      content,
      contentType: "text",
      url: `https://github.com/${this.owner}/${this.repo}/actions`,
      metadata: {
        provider: this.provider,
        repo: `${this.owner}/${this.repo}`,
        totalRuns,
        successRate: totalRuns > 0 ? (successRuns / totalRuns) * 100 : 0,
        avgDuration,
        timestamp: now.toISOString(),
      },
    };
  }

  private calculateDuration(run: WorkflowRun): number | null {
    const start = run.run_started_at || run.created_at;
    const end = run.updated_at;
    if (!start || !end) return null;
    return this.calculateTimeDiff(start, end);
  }

  private calculateTimeDiff(start: string, end: string): number {
    return (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  }

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
}
