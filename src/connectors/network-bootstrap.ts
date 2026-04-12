/**
 * Network bootstrap — initialises TLS and proxy behaviour for every HTTP
 * request withctx makes. Call {@link initNetwork} once, as early as
 * possible in the CLI entry point, before any connector constructs a fetch.
 *
 * Why this module exists
 * ----------------------
 * Node's built-in fetch (undici) does NOT automatically honour HTTPS_PROXY /
 * HTTP_PROXY / NO_PROXY environment variables. On-prem Atlassian
 * installations almost always live behind a corporate proxy, so we have to
 * wire an EnvHttpProxyAgent explicitly.
 *
 * Node DOES natively honour NODE_EXTRA_CA_CERTS for TLS chain validation,
 * but only when it is set at process startup. We re-read it here purely so
 * we can report whether it is active to the user in `ctx doctor`, and so
 * we can surface a clear error if the file is missing or unreadable.
 *
 * Finally, NODE_TLS_REJECT_UNAUTHORIZED=0 is an escape hatch for users
 * whose corp CA we can't persuade Node to trust. We surface a LOUD warning
 * when it is set so nobody accidentally ships it to production.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface NetworkDiagnostics {
  /** The CA bundle path Node is honouring, if any. */
  caBundle: string | null;
  /** Reason the CA bundle was rejected, if any. */
  caBundleError: string | null;
  /** Proxy URL in effect for https://, if any. */
  httpsProxy: string | null;
  /** Proxy URL in effect for http://, if any. */
  httpProxy: string | null;
  /** Comma-separated NO_PROXY list, if any. */
  noProxy: string | null;
  /** True if TLS verification has been globally disabled via env. */
  tlsVerificationDisabled: boolean;
  /** True if a ProxyAgent was actually installed. */
  proxyAgentInstalled: boolean;
}

let cachedDiagnostics: NetworkDiagnostics | null = null;
let bootstrapped = false;

function readEnv(name: string): string | null {
  const v = process.env[name] ?? process.env[name.toLowerCase()];
  if (!v || v.trim() === "") return null;
  return v.trim();
}

function validateCaBundle(pathValue: string): { ok: true } | { ok: false; reason: string } {
  const resolved = isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue);
  if (!existsSync(resolved)) {
    return { ok: false, reason: `file not found: ${resolved}` };
  }
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) {
      return { ok: false, reason: `not a regular file: ${resolved}` };
    }
    // Peek at the first line so we can warn about obviously-wrong files
    // (e.g. a binary blob or an empty file) before the first TLS handshake
    // fails with a cryptic error.
    const head = readFileSync(resolved, "utf-8").slice(0, 256);
    if (!head.includes("BEGIN CERTIFICATE")) {
      return {
        ok: false,
        reason: `file at ${resolved} is not a PEM-encoded certificate bundle (no "BEGIN CERTIFICATE" header)`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Initialise the global fetch dispatcher for proxy + TLS. Idempotent —
 * safe to call multiple times; only the first call has effect.
 *
 * Call this BEFORE importing or constructing any connector. The CLI
 * entry point does it immediately after the shebang line.
 */
export async function initNetwork(): Promise<NetworkDiagnostics> {
  if (bootstrapped && cachedDiagnostics) return cachedDiagnostics;

  const caBundle = readEnv("NODE_EXTRA_CA_CERTS");
  const httpsProxy = readEnv("HTTPS_PROXY") ?? readEnv("https_proxy");
  const httpProxy = readEnv("HTTP_PROXY") ?? readEnv("http_proxy");
  const noProxy = readEnv("NO_PROXY") ?? readEnv("no_proxy");
  const tlsVerificationDisabled =
    readEnv("NODE_TLS_REJECT_UNAUTHORIZED") === "0";

  let caBundleError: string | null = null;
  if (caBundle) {
    const check = validateCaBundle(caBundle);
    if (!check.ok) {
      caBundleError = check.reason;
    }
  }

  let proxyAgentInstalled = false;
  if (httpsProxy || httpProxy) {
    try {
      // Dynamic import so withctx still works on setups where undici
      // is unavailable (extremely unusual — it ships with Node 18+ —
      // but we degrade gracefully rather than crash at startup).
      const undici = await import("undici");
      const dispatcher = new undici.EnvHttpProxyAgent();
      undici.setGlobalDispatcher(dispatcher);
      proxyAgentInstalled = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[withctx] WARNING: HTTPS_PROXY is set but could not install the proxy dispatcher: ${reason}\n` +
          `[withctx]   connector calls will bypass the proxy. Install 'undici' or unset HTTPS_PROXY.\n`,
      );
    }
  }

  if (tlsVerificationDisabled) {
    process.stderr.write(
      `\n\x1b[33m[withctx] WARNING: NODE_TLS_REJECT_UNAUTHORIZED=0 is set.\x1b[0m\n` +
        `[withctx]   TLS certificate verification is DISABLED for every HTTP request.\n` +
        `[withctx]   This is a debug-only escape hatch. NEVER use it in production,\n` +
        `[withctx]   on shared machines, or against secrets you care about.\n` +
        `[withctx]   The correct fix is NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem\n\n`,
    );
  }

  cachedDiagnostics = {
    caBundle: caBundle ?? null,
    caBundleError,
    httpsProxy: httpsProxy ?? null,
    httpProxy: httpProxy ?? null,
    noProxy: noProxy ?? null,
    tlsVerificationDisabled,
    proxyAgentInstalled,
  };
  bootstrapped = true;
  return cachedDiagnostics;
}

/**
 * Return the diagnostics snapshot from the most recent {@link initNetwork}
 * call, or null if the network has not been initialised yet.
 */
export function getNetworkDiagnostics(): NetworkDiagnostics | null {
  return cachedDiagnostics;
}

/**
 * Reset the cached state. ONLY for tests — production code must treat
 * network initialisation as one-shot.
 */
export function __resetNetworkForTest(): void {
  bootstrapped = false;
  cachedDiagnostics = null;
}
