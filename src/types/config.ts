import { z } from "zod";

// --- URL safety ---
//
// SSRF guard for every `base_url` field in the config. A malicious
// ctx.yaml (or a compromised upstream config) can otherwise point the
// connector at `http://169.254.169.254/` (AWS instance metadata),
// `file:///etc/passwd`, `http://127.0.0.1:9200/` (internal
// Elasticsearch), etc.
//
// Policy:
//   1. Scheme MUST be http or https. No `file://`, `ftp://`,
//      `gopher://`, etc.
//   2. Hostname MUST NOT be in a private or link-local range:
//        - 127.0.0.0/8      (loopback)
//        - 10.0.0.0/8       (RFC1918)
//        - 172.16.0.0/12    (RFC1918)
//        - 192.168.0.0/16   (RFC1918)
//        - 169.254.0.0/16   (link-local, AWS/Azure/GCP metadata)
//        - 0.0.0.0          (default route)
//        - ::1, fc00::/7, fe80::/10 (IPv6 loopback, ULA, link-local)
//        - localhost
//
// The only escape hatch is the `WITHCTX_ALLOW_PRIVATE_URLS=1` env
// var, meant for local dev against a mock server — you have to
// opt into it on every run, so it can't be set accidentally via
// ctx.yaml or a checked-in file.
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "" || h === "0.0.0.0") return true;
  // IPv6 loopback / link-local / ULA
  if (h === "::1" || h === "[::1]") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA fc00::/7
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  // IPv4 private/link-local ranges
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m) {
    const octet = Number(m[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  return false;
}

const SafeHttpUrl = z
  .string()
  .url()
  .refine(
    (url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "URL scheme must be http:// or https://" }
  )
  .refine(
    (url) => {
      if (process.env.WITHCTX_ALLOW_PRIVATE_URLS === "1") return true;
      try {
        const parsed = new URL(url);
        return !isPrivateHost(parsed.hostname);
      } catch {
        return false;
      }
    },
    {
      message:
        "URL points to a private / link-local address (loopback, RFC1918, AWS metadata). " +
        "Set WITHCTX_ALLOW_PRIVATE_URLS=1 to override for local development.",
    }
  );

// --- Source schemas ---

const LocalSourceSchema = z.object({
  name: z.string(),
  path: z.string(),
});

const JiraSourceSchema = z.object({
  name: z.string(),
  base_url: SafeHttpUrl,
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
  base_url: SafeHttpUrl,
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
  /**
   * GitHub API token. Optional here because the connector will fall
   * back to `GITHUB_TOKEN` or `GH_TOKEN` from the environment — that
   * makes the same ctx.yaml work unchanged in a GitHub Actions
   * workflow, where the token is injected automatically.
   */
  token: z.string().optional(),
  owner: z.string(),
  repo: z.string().optional(),
  /**
   * Optional GitHub Enterprise API base URL. Omit for github.com.
   *
   * You may write it in any common form — the connector normalises:
   *   • github.com                    → https://api.github.com
   *   • https://github.corp.com       → https://github.corp.com/api/v3
   *   • https://github.corp.com/api/v3 (passthrough)
   *
   * When running inside GitHub Actions on GHES, omit this field and
   * the connector will use the `GITHUB_API_URL` the runner injects.
   *
   * Goes through SafeHttpUrl so a hostile config cannot point Octokit
   * at `http://169.254.169.254/` or an internal service. Validated
   * with the same scheme + private-IP rules as every other `base_url`
   * in this file.
   */
  base_url: SafeHttpUrl.optional(),
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
  /**
   * Optional API base URL. For `github-actions`, this is the GitHub
   * Enterprise Server API endpoint. Same normalisation + env-var
   * fallback as the `github` source: omit on a GHES Actions runner
   * and `GITHUB_API_URL` is picked up automatically.
   */
  base_url: SafeHttpUrl.optional(),
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
  /**
   * Remote URL to fetch the OpenAPI / Swagger spec from. Goes through
   * SafeHttpUrl so an ctx.yaml cannot aim the connector at
   * `http://169.254.169.254/latest/meta-data/` or an internal API.
   *
   * This URL is handed directly to `resilientFetch` — the SSRF guard
   * has to live in the schema, not at the call site.
   */
  url: SafeHttpUrl.optional(),
});

const NotionSourceSchema = z.object({
  name: z.string(),
  database_ids: z.array(z.string()).optional(),
  page_ids: z.array(z.string()).optional(),
  token: z.string().optional(),
  base_url: SafeHttpUrl.optional(),
});

const SlackSourceSchema = z.object({
  name: z.string(),
  channels: z.array(z.string()),
  token: z.string().optional(),
  since: z.string().optional(),
  base_url: SafeHttpUrl.optional(),
});

/**
 * SharePoint / OneDrive source.
 *
 * You can list multiple entries under `sharepoint:` to pull from
 * several sites at once — each entry is a separate connector with
 * its own name, so `ctx sync --source <name>` can target a single
 * site without touching the others.
 *
 * Auth is shared with the Teams connector: the Microsoft Graph app
 * registration reads its tenant/client/secret from environment
 * variables (`TEAMS_TENANT_ID`, `TEAMS_CLIENT_ID`,
 * `TEAMS_CLIENT_SECRET`) so the ctx.yaml stays free of secrets.
 *
 * Example:
 *
 *   sources:
 *     sharepoint:
 *       - name: engineering-drive
 *         site: acme.sharepoint.com/sites/engineering
 *         paths: [/Shared Documents/Handbook, /Shared Documents/ADRs]
 *         filetypes: [.docx, .pdf, .xlsx]
 *       - name: finance-drive
 *         site: acme.sharepoint.com/sites/finance
 *         files: [/Shared Documents/FY24/budget.xlsx]
 */
const SharePointSourceSchema = z.object({
  name: z.string(),
  /**
   * SharePoint site URL, either full (`https://acme.sharepoint.com/sites/engineering`)
   * or host+path form (`acme.sharepoint.com/sites/engineering`). The
   * connector normalises the scheme internally.
   */
  site: z.string(),
  /**
   * Folder paths within the site's default drive to crawl
   * recursively. Omit to skip folder crawling (use `files` below
   * instead).
   */
  paths: z.array(z.string()).optional(),
  /**
   * Individual files to fetch, each as a path inside the drive
   * (e.g. `/Shared Documents/handbook.docx`). Useful for pulling a
   * curated set without crawling a whole folder tree.
   */
  files: z.array(z.string()).optional(),
  /**
   * Which file extensions to process. Defaults to
   * `[.docx, .xlsx, .pptx, .pdf, .md]` when omitted.
   */
  filetypes: z.array(z.string()).optional(),
});

const SourcesSchema = z.object({
  local: z.array(LocalSourceSchema).optional(),
  jira: z.array(JiraSourceSchema).optional(),
  confluence: z.array(ConfluenceSourceSchema).optional(),
  github: z.array(GitHubSourceSchema).optional(),
  teams: z.array(TeamsSourceSchema).optional(),
  sharepoint: z.array(SharePointSourceSchema).optional(),
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

/**
 * Per-model pricing in USD per 1M tokens. Supplied by users who run against
 * corporate / private endpoints (Core42, Azure OpenAI, self-hosted vLLM, a
 * model they fine-tuned internally) whose model names aren't in the built-in
 * pricing table, or who have negotiated rates different from list price.
 *
 * Merged on top of the built-in table at startup via `setCustomPricing()`.
 */
const PricingEntrySchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
});

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
  /**
   * Custom HTTP headers attached to every request to the LLM provider.
   * Needed for corporate / Azure-style endpoints that authenticate with
   * `api-key` instead of `Authorization: Bearer`, or that require tenant
   * routing headers like `x-ms-region`.
   *
   * Supports `${VAR}` interpolation so secrets can stay in the environment:
   *   headers:
   *     api-key: ${CORE42_API_KEY}
   *     x-ms-region: eu-west
   */
  headers: z.record(z.string(), z.string()).optional(),
  /**
   * Custom pricing in USD per 1M tokens, keyed by model name. Overrides the
   * built-in pricing table so corporate / self-hosted models get accurate
   * cost tracking without touching source code.
   *
   *   pricing:
   *     our-private-llama-3: { input: 0.1, output: 0.4 }
   *     claude-sonnet-4:     { input: 2.5, output: 12 }   # negotiated rate
   */
  pricing: z.record(z.string(), PricingEntrySchema).optional(),
});

// --- Main config schema ---

export const CtxConfigSchema = z.object({
  /**
   * Schema version. New configs always include this so future
   * migrations can detect legacy files and upgrade them cleanly. The
   * loader warns (but does not fail) when the field is missing.
   *
   * Current version: `"1.4"`. See `src/config/migrate.ts` for the
   * upgrade path from earlier versions.
   */
  version: z.string().optional(),
  project: z.string(),
  /**
   * Who refreshes this wiki. Controls whether local `ctx ingest` /
   * `ctx sync` are allowed, or whether refresh is reserved for CI.
   *
   * - `"local"` (default): anyone can refresh. The ergonomic default.
   * - `"ci"`: local refresh is blocked unless the user passes
   *   `--allow-local-refresh`. Use this on shared wiki repos where a
   *   GitHub Action is the source of truth — prevents accidentally
   *   burning LLM budget on a per-developer rebuild.
   *
   * Set by `ctx publish` when it scaffolds a CI-refreshed wiki. Users
   * writing `ctx.yaml` by hand can also set it explicitly.
   *
   * Read out loud: "this wiki is refreshed by CI" — the name is meant
   * to be obvious from a glance at the yaml, no docs needed.
   */
  refreshed_by: z.enum(["local", "ci"]).optional(),
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
export type SharePointSource = z.infer<typeof SharePointSourceSchema>;
export type CicdSource = z.infer<typeof CicdSourceSchema>;
export type CoverageSource = z.infer<typeof CoverageSourceSchema>;
export type PullRequestsSource = z.infer<typeof PullRequestsSourceSchema>;
export type OpenApiSource = z.infer<typeof OpenApiSourceSchema>;
export type NotionSource = z.infer<typeof NotionSourceSchema>;
export type SlackSource = z.infer<typeof SlackSourceSchema>;
export type Repo = z.infer<typeof RepoSchema>;
export type CostsConfig = z.infer<typeof CostsSchema>;
export type AccessConfig = z.infer<typeof AccessSchema>;
