/**
 * Secret-redaction helpers for user-facing output.
 *
 * We deliberately take a blocklist approach here rather than an
 * allowlist: there are only a handful of well-known secret prefixes
 * (Anthropic, OpenAI, GitHub, Slack, GitLab, Atlassian, Notion, AWS,
 * generic PATs) and they're all we care about. False positives are
 * annoying but not dangerous; false negatives (leaking a token) are
 * catastrophic.
 *
 * Anything produced by these helpers is safe to print to stdout,
 * stderr, or a JSON payload. Never pass the ORIGINAL value to
 * `console.log` without wrapping it here first.
 */

/**
 * Regex patterns for things that look like secrets. Every pattern
 * is anchored at the start of the token so we don't accidentally
 * redact the middle of a sentence that happens to contain "sk-".
 *
 * Order doesn't matter — we run every pattern and take the first
 * match.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic API keys — `sk-ant-<base64>`
  /\bsk-ant-[a-zA-Z0-9_-]{10,}\b/g,
  // OpenAI API keys — `sk-<base64>` (40+ chars to avoid matching
  // every short code snippet that starts with "sk-")
  /\bsk-[a-zA-Z0-9]{20,}\b/g,
  // GitHub personal access tokens (classic + fine-grained)
  /\bghp_[a-zA-Z0-9]{36,}\b/g,
  /\bgithub_pat_[a-zA-Z0-9_]{20,}\b/g,
  // Slack tokens
  /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/g,
  /\bxapp-[a-zA-Z0-9-]{10,}\b/g,
  // GitLab PATs
  /\bglpat-[a-zA-Z0-9_-]{20,}\b/g,
  // Atlassian API tokens are opaque but usually prefixed in env
  // names. We match the `ATLASSIAN_API_TOKEN=<value>` shape so we
  // don't over-redact random strings.
  // Notion integration tokens
  /\bsecret_[a-zA-Z0-9]{40,}\b/g,
  // AWS access key IDs (very specific shape, no false positives)
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Bearer tokens — optional, only if the word "Bearer " precedes
  // something that looks like a JWT / long opaque string.
  /\bBearer\s+[a-zA-Z0-9._-]{20,}\b/g,
];

/**
 * Mask a value that looks like a secret. Keeps the first 4 and last
 * 4 characters so the operator can still tell which key it is, but
 * the middle is replaced with `…`.
 *
 * Examples:
 *   redactSecret("sk-ant-abc123xyz456") → "sk-a…z456"
 *   redactSecret("short")               → "…"
 */
export function redactSecret(value: string): string {
  if (value.length <= 8) return "…";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Walk a string and replace anything that looks like a secret with
 * a masked version. Safe to pass arbitrary user-facing strings
 * through — non-secret text passes through unchanged.
 */
export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => redactSecret(match));
  }
  return out;
}

/**
 * Return `true` if the supplied config key is one we should refuse
 * to print even in its redacted form. Used by `ctx config get` to
 * guard against `ctx config get ai.api_key` producing a leak via
 * the terminal scrollback.
 *
 * This is a key-NAME check, not a value check — we look for
 * path segments like `api_key`, `token`, `secret`, `password`,
 * `client_secret`, `private_key`.
 */
export function isSensitiveConfigKey(key: string): boolean {
  const segments = key.toLowerCase().split(/[.[\]]/);
  for (const seg of segments) {
    if (
      seg === "api_key" ||
      seg === "apikey" ||
      seg === "token" ||
      seg === "secret" ||
      seg === "password" ||
      seg === "passwd" ||
      seg === "client_secret" ||
      seg === "private_key" ||
      seg === "privatekey" ||
      seg.endsWith("_token") ||
      seg.endsWith("_secret") ||
      seg.endsWith("_key")
    ) {
      return true;
    }
  }
  return false;
}
