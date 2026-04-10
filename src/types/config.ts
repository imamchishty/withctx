import { z } from "zod";

// --- Source schemas ---

const LocalSourceSchema = z.object({
  name: z.string(),
  path: z.string(),
});

const JiraSourceSchema = z.object({
  name: z.string(),
  base_url: z.string().url(),
  email: z.string().email().optional(),
  token: z.string(),
  project: z.string().optional(),
  jql: z.string().optional(),
  epic: z.string().optional(),
  component: z.string().optional(),
  exclude: z
    .object({
      type: z.array(z.string()).optional(),
      status: z.array(z.string()).optional(),
      label: z.array(z.string()).optional(),
    })
    .optional(),
});

const ConfluenceSourceSchema = z.object({
  name: z.string(),
  base_url: z.string().url(),
  email: z.string().email().optional(),
  token: z.string(),
  space: z.union([z.string(), z.array(z.string())]).optional(),
  pages: z
    .array(
      z.object({
        id: z.string().optional(),
        url: z.string().url().optional(),
      })
    )
    .optional(),
  label: z.string().optional(),
  parent: z.string().optional(),
  exclude: z
    .object({
      label: z.array(z.string()).optional(),
      title: z.array(z.string()).optional(),
    })
    .optional(),
});

const GitHubSourceSchema = z.object({
  name: z.string(),
  token: z.string(),
  owner: z.string(),
  repo: z.string().optional(),
});

const TeamsSourceSchema = z.object({
  name: z.string(),
  tenant_id: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
  channels: z.array(
    z.object({
      team: z.string(),
      channel: z.string(),
    })
  ),
});

const CicdSourceSchema = z.object({
  name: z.string(),
  provider: z.enum(["github-actions", "jenkins", "gitlab-ci"]),
  repo: z.string(),
  token: z.string().optional(),
  limit: z.number().positive().optional(),
});

const CoverageSourceSchema = z.object({
  name: z.string(),
  path: z.string(),
  format: z.enum(["lcov", "cobertura", "istanbul-json"]).optional(),
});

const PullRequestsSourceSchema = z.object({
  name: z.string(),
  repo: z.string(),
  token: z.string().optional(),
  include: z.enum(["merged", "open", "all"]).optional(),
  since: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

const OpenApiSourceSchema = z.object({
  name: z.string(),
  path: z.string().optional(),
  url: z.string().url().optional(),
});

const NotionSourceSchema = z.object({
  name: z.string(),
  database_ids: z.array(z.string()).optional(),
  page_ids: z.array(z.string()).optional(),
  token: z.string().optional(),
  base_url: z.string().url().optional(),
});

const SlackSourceSchema = z.object({
  name: z.string(),
  channels: z.array(z.string()),
  token: z.string().optional(),
  since: z.string().optional(),
  base_url: z.string().url().optional(),
});

const SourcesSchema = z.object({
  local: z.array(LocalSourceSchema).optional(),
  jira: z.array(JiraSourceSchema).optional(),
  confluence: z.array(ConfluenceSourceSchema).optional(),
  github: z.array(GitHubSourceSchema).optional(),
  teams: z.array(TeamsSourceSchema).optional(),
  cicd: z.array(CicdSourceSchema).optional(),
  coverage: z.array(CoverageSourceSchema).optional(),
  "pull-requests": z.array(PullRequestsSourceSchema).optional(),
  openapi: z.array(OpenApiSourceSchema).optional(),
  notion: z.array(NotionSourceSchema).optional(),
  slack: z.array(SlackSourceSchema).optional(),
});

// --- Repo schema ---

const RepoSchema = z.object({
  name: z.string(),
  github: z.string(),
  branch: z.string().optional(),
});

// --- Cost schema ---

const CostModelOverrideSchema = z.record(z.string(), z.string());

const CostsSchema = z.object({
  budget: z.number().positive().optional(),
  alert_at: z.number().min(0).max(100).optional().default(80),
  model: z.string().optional().default("claude-sonnet-4"),
  model_override: CostModelOverrideSchema.optional(),
});

// --- Access schema ---

const AccessSchema = z.object({
  sensitive: z
    .array(
      z.object({
        pattern: z.string().optional(),
        tag: z.string().optional(),
      })
    )
    .optional(),
});

// --- AI provider schema ---

const AiSchema = z.object({
  provider: z.enum(["anthropic", "openai", "google", "ollama"]).default("anthropic"),
  model: z.string().optional(),
  base_url: z.string().optional(),
  /**
   * API key for the selected provider.
   *
   * Resolution order at runtime:
   *   1. The provider's env var (ANTHROPIC_API_KEY, OPENAI_API_KEY,
   *      GOOGLE_API_KEY) — always wins if set.
   *   2. This field (from `ctx.yaml`) — fallback.
   *   3. Nothing — requests will fail with "unauthorized".
   *
   * Best practice is still to use env vars (especially in CI and shared
   * repos). This field exists as an escape hatch for solo / local use
   * where a single committed `ctx.yaml` is the simplest workflow.
   *
   * Supports `${VAR}` interpolation, so you can put
   *   api_key: ${MY_KEY}
   * in the file and keep the actual value in the environment anyway.
   */
  api_key: z.string().optional(),
  models: z.record(z.string()).optional(),
});

// --- Main config schema ---

export const CtxConfigSchema = z.object({
  project: z.string(),
  repos: z.array(RepoSchema).optional(),
  sources: SourcesSchema.optional(),
  costs: CostsSchema.optional(),
  access: AccessSchema.optional(),
  ai: AiSchema.optional(),
});

export type CtxConfig = z.infer<typeof CtxConfigSchema>;
export type AiConfig = z.infer<typeof AiSchema>;
export type LocalSource = z.infer<typeof LocalSourceSchema>;
export type JiraSource = z.infer<typeof JiraSourceSchema>;
export type ConfluenceSource = z.infer<typeof ConfluenceSourceSchema>;
export type GitHubSource = z.infer<typeof GitHubSourceSchema>;
export type TeamsSource = z.infer<typeof TeamsSourceSchema>;
export type CicdSource = z.infer<typeof CicdSourceSchema>;
export type CoverageSource = z.infer<typeof CoverageSourceSchema>;
export type PullRequestsSource = z.infer<typeof PullRequestsSourceSchema>;
export type OpenApiSource = z.infer<typeof OpenApiSourceSchema>;
export type NotionSource = z.infer<typeof NotionSourceSchema>;
export type SlackSource = z.infer<typeof SlackSourceSchema>;
export type Repo = z.infer<typeof RepoSchema>;
export type CostsConfig = z.infer<typeof CostsSchema>;
export type AccessConfig = z.infer<typeof AccessSchema>;
