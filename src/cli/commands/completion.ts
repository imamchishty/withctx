import { Command } from "commander";

/**
 * Shell completion scripts for `ctx`.
 *
 * Why hand-written, not auto-generated from Commander's metadata?
 *
 *   1. Commander's introspection API is awkward (hidden subcommands,
 *      dynamic options, aliases) and generators miss half the cases.
 *   2. We WANT control over which commands appear in completions —
 *      the same "core 12" philosophy that drives `ctx help` — so that
 *      tab-completing `ctx ` doesn't dump 40 commands at the user.
 *   3. Shells each have their own quirks (bash's `COMPREPLY`, zsh's
 *      `_describe`, fish's `complete -c`) and hand-written scripts
 *      let us emit idiomatic completions per shell.
 *
 * Users install by piping the script into their rc file, e.g.:
 *
 *   ctx completion zsh >> ~/.zshrc
 *   ctx completion bash >> ~/.bashrc
 *   ctx completion fish > ~/.config/fish/completions/ctx.fish
 *
 * The scripts are static strings — they DO NOT shell out back to
 * `ctx` at completion time (which would be slow and could cause
 * infinite recursion on broken configs). Any new command added after
 * this file was written won't tab-complete until someone edits the
 * `COMMANDS` / `SUBCOMMANDS` lists below. That's a deliberate trade:
 * static + fast > dynamic + fragile.
 */

// Keep this list in rough alignment with CORE_HELP in cli/index.ts —
// these are the commands tab completion should surface first. Extras
// that are still valid but power-user-only are listed in the overflow
// block and come after.
const CORE_COMMANDS: Array<{ name: string; desc: string }> = [
  { name: "setup", desc: "Detect sources, write ctx.yaml, compile the wiki" },
  { name: "add", desc: "Add a source (github, jira, confluence, slack, notion, local)" },
  { name: "doctor", desc: "Diagnose setup, credentials and dependencies" },
  { name: "chat", desc: "Interactive Q&A with the wiki" },
  { name: "query", desc: "One-shot question — cites sources" },
  { name: "search", desc: "Search across all wiki pages" },
  { name: "sync", desc: "Refresh from sources (incremental)" },
  { name: "status", desc: "Wiki health dashboard" },
  { name: "pack", desc: "Pack wiki into CLAUDE.md / system prompt" },
  { name: "mcp", desc: "Run as an MCP server (Cursor / Claude Code)" },
  { name: "config", desc: "Print resolved configuration" },
  { name: "help", desc: "Show the core commands (--all for full list)" },
];

const POWER_COMMANDS: Array<{ name: string; desc: string }> = [
  { name: "ingest", desc: "Compile the wiki from configured sources" },
  { name: "costs", desc: "Token usage and spend report" },
  { name: "lint", desc: "Wiki health checks — contradictions, staleness, orphans" },
  { name: "export", desc: "Write CLAUDE.md and other exports to disk" },
  { name: "diff", desc: "Show wiki changes since last sync" },
  { name: "history", desc: "Refresh journal — who refreshed what, when" },
  { name: "repos", desc: "Register and manage multi-repo workspaces" },
  { name: "sources", desc: "Manage source connectors" },
  { name: "onboard", desc: "Print onboarding guide for the current wiki" },
  { name: "reset", desc: "Reset wiki state (with confirmation)" },
  { name: "serve", desc: "Run the REST API server" },
  { name: "watch", desc: "Watch local sources and sync on change" },
  { name: "import", desc: "Import pages from another wiki/markdown tree" },
  { name: "review", desc: "Review mode — audit wiki health" },
  { name: "impact", desc: "Blast-radius analysis for a wiki page" },
  { name: "explain", desc: "Explain a wiki claim with source trace" },
  { name: "changelog", desc: "Generate a changelog from the refresh journal" },
  { name: "timeline", desc: "Project timeline from the wiki" },
  { name: "metrics", desc: "Wiki metrics dashboard" },
  { name: "faq", desc: "Generate FAQs from the wiki" },
  { name: "glossary", desc: "Generate glossary from the wiki" },
  { name: "who", desc: "Page owners and review assignments" },
  { name: "todos", desc: "Outstanding TODOs across the repo" },
  { name: "graph", desc: "Wiki cross-reference graph" },
  { name: "publish", desc: "Scaffold a CI-refreshed context repo" },
  { name: "embed", desc: "Manage vector embeddings" },
  { name: "completion", desc: "Print shell completion scripts" },
];

const ALL_COMMANDS = [...CORE_COMMANDS, ...POWER_COMMANDS];

// Global flags every command accepts — surfaced at the top level so
// `ctx --<TAB>` and `ctx <cmd> --<TAB>` both complete them.
const GLOBAL_FLAGS = [
  { flag: "--help", desc: "Show command help" },
  { flag: "--version", desc: "Print withctx version" },
  { flag: "--verbose", desc: "Verbose output" },
  { flag: "--quiet", desc: "Quiet output (errors only)" },
  { flag: "--json", desc: "JSON output (read commands only)" },
];

// ── Script emitters ───────────────────────────────────────────────────

function bashScript(): string {
  const core = CORE_COMMANDS.map((c) => c.name).join(" ");
  const power = POWER_COMMANDS.map((c) => c.name).join(" ");
  const flags = GLOBAL_FLAGS.map((f) => f.flag).join(" ");
  return `# withctx (ctx) — bash completion
# Install: add to ~/.bashrc with:
#   source <(ctx completion bash)
# Or: ctx completion bash > /etc/bash_completion.d/ctx
_ctx_complete() {
  local cur prev cmds flags
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmds="${core} ${power}"
  flags="${flags}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    if [[ "\${cur}" == --* ]]; then
      COMPREPLY=( $(compgen -W "\${flags}" -- "\${cur}") )
    else
      COMPREPLY=( $(compgen -W "\${cmds}" -- "\${cur}") )
    fi
    return 0
  fi

  if [[ "\${cur}" == --* ]]; then
    COMPREPLY=( $(compgen -W "\${flags}" -- "\${cur}") )
    return 0
  fi
}
complete -F _ctx_complete ctx
`;
}

function zshScript(): string {
  // zsh's `_describe` wants entries in the form `name:description`.
  const coreEntries = CORE_COMMANDS.map(
    (c) => `    '${c.name}:${escapeZsh(c.desc)}'`
  ).join("\n");
  const powerEntries = POWER_COMMANDS.map(
    (c) => `    '${c.name}:${escapeZsh(c.desc)}'`
  ).join("\n");
  const flagEntries = GLOBAL_FLAGS.map(
    (f) => `    '${f.flag}[${escapeZsh(f.desc)}]'`
  ).join("\n");

  return `#compdef ctx
# withctx (ctx) — zsh completion
# Install: add to ~/.zshrc with:
#   source <(ctx completion zsh)
# Or drop into a directory in $fpath, e.g. ~/.zfunc/_ctx, then:
#   autoload -Uz compinit && compinit

_ctx() {
  local -a core_commands power_commands all_commands
  core_commands=(
${coreEntries}
  )
  power_commands=(
${powerEntries}
  )
  all_commands=(\${core_commands} \${power_commands})

  local -a global_flags
  global_flags=(
${flagEntries}
  )

  _arguments -C \\
    '1: :->cmd' \\
    '*: :->args' \\
    \${global_flags}

  case \${state} in
    cmd)
      _describe -t core-commands 'core commands' core_commands
      _describe -t power-commands 'more commands' power_commands
      ;;
    args)
      _arguments \${global_flags}
      ;;
  esac
}

compdef _ctx ctx
`;
}

function fishScript(): string {
  const lines: string[] = [
    "# withctx (ctx) — fish completion",
    "# Install:",
    "#   ctx completion fish > ~/.config/fish/completions/ctx.fish",
    "",
    "# Disable file completion at the top level — `ctx` takes commands, not paths.",
    "complete -c ctx -f",
    "",
    "# Core commands",
  ];
  for (const cmd of CORE_COMMANDS) {
    lines.push(
      `complete -c ctx -n "__fish_use_subcommand" -a "${cmd.name}" -d "${escapeFish(cmd.desc)}"`
    );
  }
  lines.push("", "# More commands");
  for (const cmd of POWER_COMMANDS) {
    lines.push(
      `complete -c ctx -n "__fish_use_subcommand" -a "${cmd.name}" -d "${escapeFish(cmd.desc)}"`
    );
  }
  lines.push("", "# Global flags");
  for (const flag of GLOBAL_FLAGS) {
    const long = flag.flag.replace(/^--/, "");
    lines.push(
      `complete -c ctx -l ${long} -d "${escapeFish(flag.desc)}"`
    );
  }
  return `${lines.join("\n")}\n`;
}

function escapeZsh(s: string): string {
  return s.replace(/'/g, "\\'").replace(/:/g, "\\:");
}

function escapeFish(s: string): string {
  return s.replace(/"/g, '\\"');
}

// ── Command registration ──────────────────────────────────────────────

export function registerCompletionCommand(program: Command): void {
  program
    .command("completion")
    .description("Print shell completion scripts (bash, zsh, fish)")
    .argument("<shell>", "Shell to emit completion for: bash | zsh | fish")
    .addHelpText(
      "after",
      `
Install examples:

  # zsh
  source <(ctx completion zsh)                 # one-shot, add to ~/.zshrc

  # bash
  source <(ctx completion bash)                # one-shot, add to ~/.bashrc

  # fish
  ctx completion fish > ~/.config/fish/completions/ctx.fish
`
    )
    .action((shell: string) => {
      const normalized = shell.toLowerCase();
      switch (normalized) {
        case "bash":
          process.stdout.write(bashScript());
          break;
        case "zsh":
          process.stdout.write(zshScript());
          break;
        case "fish":
          process.stdout.write(fishScript());
          break;
        default:
          process.stderr.write(
            `Unknown shell: ${shell}\n` +
              `Supported shells: bash, zsh, fish\n` +
              `Run: ctx completion --help\n`
          );
          process.exit(1);
      }
    });
}

// Exported for tests so we can assert the script contents don't
// silently rot.
export const __internals = {
  bashScript,
  zshScript,
  fishScript,
  CORE_COMMANDS,
  POWER_COMMANDS,
  ALL_COMMANDS,
};
