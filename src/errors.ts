/**
 * Typed, actionable errors for the withctx CLI.
 *
 * Every user-visible failure SHOULD go through this module. The
 * golden rule: an error is actionable only if it tells the user
 * exactly what to do next. A stack trace is not actionable. "Failed
 * to load config" is not actionable. "Failed to load config —
 * ctx.yaml not found. Run `ctx setup` to create one" IS actionable.
 *
 * Error shape:
 *
 *   - `code`: short stable id like `NO_CONFIG`, used for docs links
 *     and JSON output ({"error": {"code": "NO_CONFIG", ...}}).
 *   - `message`: the one-line human summary (what went wrong).
 *   - `detail`: optional extra context (why it's a problem).
 *   - `next`: the concrete next command the user should run. This is
 *     the thing that differentiates us from a normal Error — if you
 *     can't fill in `next`, you probably shouldn't be throwing a
 *     `CtxError` here; throw a plain Error and let the caller wrap.
 *
 * The CLI entry point's `formatCtxError()` renders these with a
 * consistent visual language:
 *
 *     Error (NO_CONFIG): No ctx.yaml found in this directory or any parent.
 *       To fix: run `ctx setup` to create one.
 *       Docs:   https://withctx.dev/errors/NO_CONFIG
 *
 * Exit codes follow sysexits.h conventions where useful:
 *   - 64  EX_USAGE       (bad CLI args)
 *   - 66  EX_NOINPUT     (missing input file — config, wiki page)
 *   - 69  EX_UNAVAILABLE (LLM provider down, network failure)
 *   - 73  EX_CANTCREAT   (can't write output file)
 *   - 78  EX_CONFIG      (config problem — budget, policy, schema)
 *   - 1   generic (anything we haven't classified yet)
 */

export type CtxErrorCode =
  | "NO_CONFIG"
  | "CONFIG_INVALID"
  | "NO_CTX_DIR"
  | "NO_WIKI_PAGES"
  | "NO_SOURCES"
  | "SOURCE_UNREACHABLE"
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "LLM_UNAVAILABLE"
  | "BUDGET_EXCEEDED"
  | "REFRESH_POLICY_BLOCKED"
  | "PAGE_NOT_FOUND"
  | "WRITE_FAILED"
  | "INVALID_ARGUMENT"
  | "CANCELLED";

export interface CtxErrorOptions {
  /** Short stable error code. */
  code: CtxErrorCode;
  /** One-line human summary of what went wrong. */
  message: string;
  /** Optional extra context describing WHY it's wrong. */
  detail?: string;
  /**
   * Concrete next command / action the user should take. REQUIRED —
   * if you can't fill this in meaningfully, throw a plain Error
   * instead of pretending this is an actionable CtxError.
   */
  next: string;
  /** Optional cause (preserves the original error for debugging). */
  cause?: unknown;
}

export class CtxError extends Error {
  public readonly code: CtxErrorCode;
  public readonly detail?: string;
  public readonly next: string;
  public override readonly cause?: unknown;

  constructor(opts: CtxErrorOptions) {
    super(opts.message);
    this.name = "CtxError";
    this.code = opts.code;
    this.detail = opts.detail;
    this.next = opts.next;
    this.cause = opts.cause;
  }
}

/**
 * Map from error code to exit code. Keeps the CLI entry point
 * consistent — any `CtxError` thrown from any command exits with the
 * sysexits-style code appropriate for its category.
 */
export const EXIT_CODES: Record<CtxErrorCode, number> = {
  NO_CONFIG: 66,
  CONFIG_INVALID: 78,
  NO_CTX_DIR: 66,
  NO_WIKI_PAGES: 66,
  NO_SOURCES: 78,
  SOURCE_UNREACHABLE: 69,
  AUTH_MISSING: 78,
  AUTH_INVALID: 69,
  LLM_UNAVAILABLE: 69,
  BUDGET_EXCEEDED: 78,
  REFRESH_POLICY_BLOCKED: 78,
  PAGE_NOT_FOUND: 66,
  WRITE_FAILED: 73,
  INVALID_ARGUMENT: 64,
  CANCELLED: 1,
};

/**
 * Render a CtxError for a terminal. Uses a consistent visual shape
 * across every command so users recognise "oh, this is the
 * withctx-standard error block — the `next:` line is where I look".
 *
 * Kept in plain ANSI — no chalk dependency — so this file stays
 * import-safe from any part of the codebase, including modules that
 * can't pull in chalk (e.g. the MCP server's stdio transport, which
 * must not emit colour codes on stdout).
 */
export function formatCtxError(err: CtxError, options: { colour?: boolean } = {}): string {
  const colour = options.colour ?? true;
  const red = colour ? "\u001b[31m" : "";
  const yellow = colour ? "\u001b[33m" : "";
  const dim = colour ? "\u001b[2m" : "";
  const reset = colour ? "\u001b[0m" : "";
  const bold = colour ? "\u001b[1m" : "";

  const lines: string[] = [];
  lines.push(`${red}${bold}Error (${err.code}):${reset} ${err.message}`);
  if (err.detail) {
    lines.push(`  ${dim}${err.detail}${reset}`);
  }
  lines.push(`  ${yellow}To fix:${reset} ${err.next}`);
  lines.push(`  ${dim}Docs:   https://withctx.dev/errors/${err.code}${reset}`);
  return lines.join("\n");
}

/**
 * Convert a CtxError into a JSON-serializable payload for `--json`
 * output. Callers of read commands use this so scripts consuming
 * stdout get a structured error object instead of a chalk-painted
 * string.
 */
export function ctxErrorToJson(err: CtxError): {
  error: {
    code: CtxErrorCode;
    message: string;
    detail?: string;
    next: string;
  };
} {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.detail ? { detail: err.detail } : {}),
      next: err.next,
    },
  };
}

// ── Factory helpers ───────────────────────────────────────────────────
//
// Common error shapes — call-site sugar so the conversion layer stays
// thin. Every helper's `next:` field is the single most valuable thing
// in this whole file: it's what turns "generic failure" into "here's
// the exact command to run next".

export function noConfigError(): CtxError {
  return new CtxError({
    code: "NO_CONFIG",
    message: "No ctx.yaml found in this directory or any parent.",
    detail:
      "withctx looks for ctx.yaml by walking up from the current working directory. You're either outside a withctx project, or the file hasn't been created yet.",
    next: "Run `ctx setup` in your project root to create one, or `ctx setup --demo` to scaffold a zero-cost demo.",
  });
}

export function noCtxDirError(): CtxError {
  return new CtxError({
    code: "NO_CTX_DIR",
    message: "No .ctx/ directory found.",
    detail:
      "The config exists but the wiki directory doesn't — looks like setup was never completed or the directory was deleted.",
    next: "Run `ctx setup` to initialise the .ctx/ directory and compile the wiki.",
  });
}

export function noWikiPagesError(): CtxError {
  return new CtxError({
    code: "NO_WIKI_PAGES",
    message: "No wiki pages found in .ctx/context/.",
    detail:
      "The wiki is empty. The most common cause is an ingest that was cancelled or had no source documents.",
    next: "Run `ctx ingest` to compile the wiki from your configured sources.",
  });
}

export function authMissingError(provider: string, envVar: string): CtxError {
  return new CtxError({
    code: "AUTH_MISSING",
    message: `${provider} credentials not configured.`,
    detail: `withctx couldn't find the ${envVar} environment variable or an equivalent setting in ctx.yaml.`,
    next: `Export ${envVar} in your shell (e.g. \`export ${envVar}=...\`) and retry, or add it to ctx.yaml under the relevant section.`,
  });
}

export function llmUnavailableError(provider: string, cause?: unknown): CtxError {
  return new CtxError({
    code: "LLM_UNAVAILABLE",
    message: `${provider} LLM provider is not reachable.`,
    detail:
      "withctx tried to contact the provider but got no response. Usually this is a network problem, an expired API key, or the provider being temporarily down.",
    next: `Run \`ctx doctor\` to diagnose connectivity and credentials, then retry.`,
    cause,
  });
}

export function pageNotFoundError(path: string): CtxError {
  return new CtxError({
    code: "PAGE_NOT_FOUND",
    message: `Wiki page not found: ${path}`,
    next: `Run \`ctx status\` to list available pages, or \`ctx search <term>\` to find one by keyword.`,
  });
}

export function invalidArgumentError(arg: string, hint: string): CtxError {
  return new CtxError({
    code: "INVALID_ARGUMENT",
    message: `Invalid argument: ${arg}`,
    next: hint,
  });
}

export function refreshPolicyBlockedError(reason: string): CtxError {
  return new CtxError({
    code: "REFRESH_POLICY_BLOCKED",
    message: `Refresh blocked by ctx.yaml refresh policy.`,
    detail: reason,
    next:
      "This wiki is marked `refreshed_by: ci` in ctx.yaml. Either let the scheduled GitHub Action refresh it, or pass `--allow-local-refresh` to override for this one run.",
  });
}

/**
 * Type guard — identifies a CtxError among generic thrown values.
 * The CLI entry point uses this to decide whether to render the
 * structured error format or fall back to `err.message`.
 */
export function isCtxError(value: unknown): value is CtxError {
  return value instanceof CtxError;
}
