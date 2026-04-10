import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

/**
 * A single TODO-style comment discovered in the codebase.
 */
export interface TodoItem {
  /** Path relative to the scanned root. Forward-slash separated. */
  file: string;
  /** 1-indexed line number. */
  line: number;
  /** The marker that matched (TODO, FIXME, HACK, XXX, BUG, OPTIMIZE). */
  marker: string;
  /** Trimmed text after the marker (may be empty). */
  text: string;
}

export interface ScanOptions {
  /** Which markers to look for. Defaults to the full set. */
  markers?: string[];
  /** Directory names to skip entirely. Merged with defaults. */
  ignoreDirs?: Iterable<string>;
  /** File extensions to scan. Defaults to the code/text set below. */
  extensions?: Iterable<string>;
  /** Hard cap on number of items returned. */
  limit?: number;
}

const DEFAULT_MARKERS = ["TODO", "FIXME", "HACK", "XXX", "BUG", "OPTIMIZE"];

const DEFAULT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".scala",
  ".c", ".cpp", ".h", ".hpp", ".cs",
  ".sh", ".bash", ".zsh",
  ".sql", ".graphql", ".gql",
  ".yaml", ".yml", ".json", ".toml",
  ".md", ".txt",
  ".html", ".css", ".scss",
  ".tf", ".hcl",
]);

const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out",
  "__pycache__", ".venv", "venv", "target",
  ".ctx", ".turbo", "coverage", ".cache", ".idea", ".vscode",
]);

/**
 * Scan a directory tree for TODO/FIXME-style markers in comments.
 *
 * Pure function: no IO beyond reading files. No network, no globals.
 * Designed to be called from both the CLI and future tests without
 * mocking.
 *
 * Skips files larger than 1 MB (binary assets, generated bundles).
 */
export function scanForTodos(rootDir: string, opts: ScanOptions = {}): TodoItem[] {
  if (!existsSync(rootDir)) return [];

  const markers = opts.markers?.length ? opts.markers : DEFAULT_MARKERS;
  const ignoreDirs = new Set(DEFAULT_IGNORE_DIRS);
  if (opts.ignoreDirs) {
    for (const d of opts.ignoreDirs) ignoreDirs.add(d);
  }
  const extensions = opts.extensions
    ? new Set(opts.extensions)
    : DEFAULT_EXTENSIONS;
  const limit = opts.limit ?? Infinity;

  // Word-boundary match, optional colon, capture the rest of the line.
  // Also requires the marker to be preceded by a non-word char or start
  // of line so we don't match "mastodon" or "VOODOO".
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9_])(${markers.join("|")})\\b:?\\s*(.*)`
  );

  const results: TodoItem[] = [];

  for (const filePath of walkFiles(rootDir, ignoreDirs)) {
    if (results.length >= limit) break;

    const ext = extname(filePath).toLowerCase();
    if (!extensions.has(ext)) continue;

    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (stat.size > 1_000_000) continue;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    const rel = relative(rootDir, filePath).split(/[\\/]/).join("/");

    for (let i = 0; i < lines.length; i++) {
      const match = pattern.exec(lines[i]);
      if (!match) continue;

      results.push({
        file: rel,
        line: i + 1,
        marker: match[1],
        text: match[2].trim(),
      });

      if (results.length >= limit) break;
    }
  }

  return results;
}

/**
 * Group TODO items by marker, returning counts in a stable key order.
 */
export function summariseTodos(items: TodoItem[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const item of items) {
    summary[item.marker] = (summary[item.marker] ?? 0) + 1;
  }
  return summary;
}

/**
 * Render TODO items as a markdown report suitable for writing to
 * .ctx/context/todos.md.
 */
export function renderTodosMarkdown(
  items: TodoItem[],
  opts: { generatedAt?: Date; rootLabel?: string } = {}
): string {
  const when = (opts.generatedAt ?? new Date()).toISOString();
  const root = opts.rootLabel ?? ".";
  const summary = summariseTodos(items);

  const lines: string[] = [];
  lines.push("# TODOs");
  lines.push("");
  lines.push(`_Scanned \`${root}\` at ${when}_`);
  lines.push("");

  if (items.length === 0) {
    lines.push("No TODOs found. 🎉");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## Summary");
  lines.push("");
  lines.push("| Marker | Count |");
  lines.push("|--------|------:|");
  for (const marker of Object.keys(summary).sort()) {
    lines.push(`| ${marker} | ${summary[marker]} |`);
  }
  lines.push(`| **Total** | **${items.length}** |`);
  lines.push("");

  // Group by file for readability.
  const byFile = new Map<string, TodoItem[]>();
  for (const item of items) {
    const list = byFile.get(item.file) ?? [];
    list.push(item);
    byFile.set(item.file, list);
  }

  lines.push("## By file");
  lines.push("");
  for (const file of [...byFile.keys()].sort()) {
    lines.push(`### \`${file}\``);
    lines.push("");
    for (const item of byFile.get(file)!) {
      const text = item.text || "_(no description)_";
      lines.push(`- **${item.marker}** (L${item.line}): ${text}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function* walkFiles(
  dir: string,
  ignoreDirs: Set<string>
): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip hidden dirs/files except a few useful ones.
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    if (ignoreDirs.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, ignoreDirs);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}
