/**
 * GitHub URL + token helpers shared by the `github` and `cicd`
 * (github-actions) connectors.
 *
 * The goal is that the same withctx setup works in every common GitHub
 * deployment mode:
 *
 *   1. github.com (cloud)
 *   2. GitHub Enterprise Server (on-prem, self-hosted)
 *   3. Running inside a GitHub Actions workflow on either of the above
 *
 * The ENTIRE difference between those modes, from our perspective, is:
 *
 *   - The API base URL (github.com → https://api.github.com, GHES →
 *     https://<host>/api/v3).
 *   - Where the token comes from (ctx.yaml credential vs. the ambient
 *     `GITHUB_TOKEN` injected by Actions).
 *
 * This module centralises both so we never have two connectors with
 * subtly different heuristics.
 */

/**
 * Normalise a user-supplied GitHub API base URL so Octokit gets the form
 * it expects:
 *
 *   • github.com                         → https://api.github.com
 *   • https://github.com                 → https://api.github.com
 *   • https://api.github.com             → https://api.github.com  (passthrough)
 *   • https://github.corp.com            → https://github.corp.com/api/v3
 *   • https://github.corp.com/           → https://github.corp.com/api/v3
 *   • https://github.corp.com/api/v3     → https://github.corp.com/api/v3  (passthrough)
 *   • https://github.corp.com/api/v3/    → https://github.corp.com/api/v3
 *
 * Anything that isn't a parseable URL is returned as-is — the Zod
 * SafeHttpUrl refinement upstream is responsible for rejecting obviously
 * hostile inputs, and we do not want this helper to throw on a typo and
 * kill the whole CLI.
 */
export function normalizeGitHubBaseUrl(raw: string): string {
  if (!raw || typeof raw !== "string") return raw;
  const trimmed = raw.trim().replace(/\/+$/, "");

  // Bare hostnames like "github.com" or "github.corp.com" — wrap with
  // https:// and recurse so the URL-parsing branch handles them.
  if (!/^https?:\/\//i.test(trimmed)) {
    return normalizeGitHubBaseUrl(`https://${trimmed}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "");

  // Cloud: github.com or api.github.com → always https://api.github.com
  if (host === "github.com" || host === "api.github.com" || host === "www.github.com") {
    return "https://api.github.com";
  }

  // Enterprise Server — ensure /api/v3 suffix.
  if (path === "" || path === "/") {
    return `${parsed.origin}/api/v3`;
  }
  if (path === "/api/v3" || path.startsWith("/api/v3/")) {
    return `${parsed.origin}${path}`;
  }

  // Some GHES installs sit behind a reverse proxy at a custom context
  // path (e.g. https://corp.com/github/api/v3). Preserve whatever the
  // user configured as long as it ends with /api/v3.
  if (path.endsWith("/api/v3")) {
    return `${parsed.origin}${path}`;
  }

  // Fallback: append /api/v3 to whatever path prefix they gave us.
  return `${parsed.origin}${path}/api/v3`;
}

/**
 * Resolve the GitHub API base URL using (in order):
 *
 *   1. The explicit `base_url` in ctx.yaml, normalised for GHES.
 *   2. `GITHUB_API_URL` env var — set automatically by GitHub Actions
 *      on both github.com and GHES runners; on GHES it already
 *      includes the `/api/v3` suffix.
 *   3. Undefined, which tells Octokit to use its github.com default.
 *
 * This means a workflow on GHES that just does `ctx sync` with a
 * minimal config picks up the right API host with zero configuration.
 */
export function resolveGitHubBaseUrl(configBaseUrl?: string): string | undefined {
  if (configBaseUrl) {
    return normalizeGitHubBaseUrl(configBaseUrl);
  }
  const envUrl = process.env.GITHUB_API_URL;
  if (envUrl && envUrl.trim() !== "") {
    return normalizeGitHubBaseUrl(envUrl.trim());
  }
  return undefined;
}

/**
 * Resolve the GitHub token using (in order):
 *
 *   1. The explicit `token` in ctx.yaml.
 *   2. The `GITHUB_TOKEN` env var (GitHub Actions default).
 *   3. The `GH_TOKEN` env var (gh CLI convention, sometimes used in CI).
 *
 * Returns null if none is set. The caller decides whether that is
 * fatal (github connector requires a token) or acceptable.
 */
export function resolveGitHubToken(configToken?: string): string | null {
  if (configToken && configToken.trim() !== "") return configToken;
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (envToken && envToken.trim() !== "") return envToken;
  return null;
}

/**
 * True if we look like we're running inside a GitHub Actions workflow.
 * Used by setup/doctor to skip interactive prompts, pick the right
 * token source, and trust `GITHUB_API_URL` automatically.
 */
export function isRunningInGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}
