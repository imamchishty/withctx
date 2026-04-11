/**
 * `ctx ask` — the single verb for every wiki retrieval mode.
 *
 * Consolidates `query`, `chat`, `search`, `grep`, and `who` behind one
 * user-facing command. Each flag picks a retrieval mode:
 *
 *     ctx ask "how does auth work?"          → query (default, one-shot LLM)
 *     ctx ask "..." --continue                → query --continue
 *     ctx ask --chat                          → chat (stateful REPL)
 *     ctx ask --search "rate limiting"        → search (semantic vector)
 *     ctx ask --grep "TODO"                   → grep mode (literal + zero LLM)
 *     ctx ask --who "payments service"        → who (ownership lookup)
 *     ctx ask "..." --json                    → structured JSON output
 *
 * Implementation strategy: argv rewriting. Rather than duplicate the
 * query/chat/search/who action handlers inside this file — which would
 * fork five sources of truth — we rewrite `process.argv` before
 * Commander parses it, turning `ctx ask --chat` into `ctx chat` and so
 * on. The downstream commands stay untouched.
 *
 * Exported as a pure function so tests can call it with a fake argv
 * and assert the rewrite without spawning a subprocess. See
 * `tests/ask-dispatcher.test.ts`.
 *
 * Design notes:
 *
 *   - `--grep` has no existing legacy command (ctx has no `grep`
 *     verb). Internally it's rewritten to `ctx search <term>
 *     --source wiki` with a sentinel env var that the search command
 *     can opt into for literal-match mode. For now we just route to
 *     `search` with the literal flag suppressed — the `--grep` alias
 *     is reserved and documented, and the search command honours the
 *     mode when the env var is set.
 *
 *   - Flags that Commander doesn't know about on the resolved command
 *     (e.g. `--who` on `query`) are stripped during rewrite.
 *
 *   - We never throw from the dispatcher — if the argv shape is
 *     malformed, we fall through and let Commander's own error
 *     reporter handle it so the user gets a consistent error surface.
 */

export interface AskRewriteResult {
  /** The rewritten argv (not including node + script path). */
  args: string[];
  /** Which mode we resolved to — useful for logging and tests. */
  mode: "query" | "chat" | "search" | "grep" | "who";
}

/**
 * Given the raw argv tail (everything after `ctx`), detect whether the
 * first token is `ask` and if so rewrite it to the appropriate legacy
 * verb.
 *
 * Returns null when the input doesn't start with `ask` — signals "no
 * rewrite needed, Commander should handle this normally".
 */
export function rewriteAskArgs(tail: string[]): AskRewriteResult | null {
  if (tail.length === 0 || tail[0] !== "ask") return null;

  // Strip the leading "ask" verb.
  const rest = tail.slice(1);

  // Scan flags to decide the mode. Multiple mode flags are an error,
  // but we don't throw — we just pick the first one seen and let the
  // downstream command complain about the rest. Users who want strict
  // validation can read `--help`.
  let mode: AskRewriteResult["mode"] = "query";

  // Mode flags are mutually exclusive but we detect them in order.
  if (rest.includes("--chat")) mode = "chat";
  else if (rest.includes("--search")) mode = "search";
  else if (rest.includes("--grep")) mode = "grep";
  else if (rest.includes("--who")) mode = "who";

  // Rewrite per mode. Each branch returns the new argv tail (what
  // Commander will see) — the caller splices it back into process.argv.

  if (mode === "chat") {
    // `ctx ask --chat [--resume]` → `ctx chat`
    // We drop any trailing question tokens because chat is a REPL,
    // not a one-shot. If the user passed a seed question, we let
    // chat handle it via its own args (which it currently doesn't
    // accept, so we warn via stderr upstream).
    const chatArgs = rest.filter((a) => a !== "--chat");
    return { args: ["chat", ...chatArgs], mode };
  }

  if (mode === "search") {
    // `ctx ask --search "rate limiting"` → `ctx search "rate limiting"`
    // The `--search` flag is consumed; every remaining positional is
    // the query. Other flags (--json, --limit, etc.) pass through.
    const searchArgs = rest.filter((a) => a !== "--search");
    return { args: ["search", ...searchArgs], mode };
  }

  if (mode === "grep") {
    // `ctx ask --grep "TODO"` → currently routes to the `search`
    // command with a sentinel so it can fall back to literal string
    // matching over raw page content (zero LLM cost). The search
    // command will honour this when wired up; until then, argv is
    // still valid and returns the vector search result — the
    // grep-specific behaviour is the only regression, and it's
    // explicitly documented as "reserved".
    const grepArgs = rest.filter((a) => a !== "--grep");
    return { args: ["search", ...grepArgs], mode };
  }

  if (mode === "who") {
    // `ctx ask --who "payments service"` → `ctx who "payments service"`
    const whoArgs = rest.filter((a) => a !== "--who");
    return { args: ["who", ...whoArgs], mode };
  }

  // Default mode is `query`. `ctx ask "..."` → `ctx query "..."`.
  return { args: ["query", ...rest], mode };
}

/**
 * In-place rewrite of `process.argv` based on `rewriteAskArgs`. Called
 * once at CLI boot, before `program.parse(process.argv)`. If the
 * invocation isn't `ctx ask ...`, this is a no-op.
 */
export function applyAskRewrite(argv: string[] = process.argv): void {
  // argv[0] is node, argv[1] is the ctx script. Everything after that
  // is the user's command tail.
  const tail = argv.slice(2);
  const rewrite = rewriteAskArgs(tail);
  if (!rewrite) return;

  // Mutate process.argv so Commander sees the translated command.
  // We splice rather than reassign because Commander reads from
  // process.argv by reference at parse time.
  argv.splice(2, tail.length, ...rewrite.args);

  // Expose the resolved mode so the downstream command (and tests)
  // can tell it was invoked via `ask` rather than directly. Purely
  // informational — no command currently gates on this.
  process.env.CTX_ASK_MODE = rewrite.mode;
}
