/**
 * Unified UI library for CLI commands.
 *
 * Single import for consistent terminal output — status messages, headings,
 * boxes, tables, lists, key-value pairs, dividers, next-steps, tips and icons.
 *
 * No external dependencies beyond chalk and ora (already in package.json).
 */

import chalk from "chalk";
import ora from "ora";

// ---------------------------------------------------------------------------
// ANSI-aware width helpers
// ---------------------------------------------------------------------------

/**
 * Strip ANSI escape sequences from a string so we can measure its visual
 * width accurately.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Visible width of a string (without ANSI color codes).
 */
export function visualWidth(s: string): number {
  return stripAnsi(s).length;
}

/**
 * Pad the end of a string to a visual width, accounting for ANSI colors.
 */
function padEndVisual(s: string, width: number): string {
  const pad = Math.max(0, width - visualWidth(s));
  return s + " ".repeat(pad);
}

/**
 * Pad the start of a string to a visual width, accounting for ANSI colors.
 */
function padStartVisual(s: string, width: number): string {
  const pad = Math.max(0, width - visualWidth(s));
  return " ".repeat(pad) + s;
}

/**
 * Truncate a string to a maximum visual width, adding an ellipsis if needed.
 * Preserves leading ANSI codes naively by stripping for measurement only.
 */
function truncateVisual(s: string, maxWidth: number): string {
  if (visualWidth(s) <= maxWidth) return s;
  const plain = stripAnsi(s);
  if (maxWidth <= 1) return plain.slice(0, maxWidth);
  return plain.slice(0, Math.max(0, maxWidth - 1)) + "\u2026";
}

// ---------------------------------------------------------------------------
// Box drawing characters
// ---------------------------------------------------------------------------

const BOX_CHARS = {
  topLeft: "\u250C",
  topRight: "\u2510",
  bottomLeft: "\u2514",
  bottomRight: "\u2518",
  horizontal: "\u2500",
  vertical: "\u2502",
  teeLeft: "\u251C",
  teeRight: "\u2524",
};

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

export const icons = {
  pass: chalk.green("\u2713"),
  fail: chalk.red("\u2717"),
  warn: chalk.yellow("\u26A0"),
  info: chalk.cyan("\u2139"),
  arrow: chalk.dim("\u2192"),
  bullet: chalk.dim("\u2022"),
  star: chalk.yellow("\u2605"),
  rocket: "\uD83D\uDE80",
  sparkles: "\u2728",
};

// ---------------------------------------------------------------------------
// Status messages
// ---------------------------------------------------------------------------

export function success(message: string): void {
  console.log(`${icons.pass} ${message}`);
}

export function error(message: string, fix?: string): void {
  console.log(`${icons.fail} ${chalk.red("Error:")} ${message}`);
  if (fix) {
    console.log(`  ${icons.arrow} ${chalk.dim(`Try: ${fix}`)}`);
  }
}

export function warn(message: string): void {
  console.log(`${icons.warn} ${message}`);
}

export function info(message: string): void {
  console.log(`${icons.info} ${message}`);
}

export function dim(message: string): void {
  console.log(chalk.dim(message));
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

export function heading(text: string): void {
  console.log();
  console.log(chalk.bold.underline(text));
}

export function subheading(text: string): void {
  console.log(chalk.bold(text));
}

// ---------------------------------------------------------------------------
// Box drawing
// ---------------------------------------------------------------------------

export interface BoxOptions {
  title?: string;
  width?: number;
  padding?: number;
  borderColor?: (s: string) => string;
}

/**
 * Build a box around a set of lines.
 *
 * - `width` refers to the overall outer width of the box.
 * - Contents are padded to fit and truncated if they are wider than the
 *   available inner area.
 */
export function box(lines: string[], options: BoxOptions = {}): string {
  const outerWidth = options.width ?? 60;
  const padding = options.padding ?? 1;
  const borderColor = options.borderColor ?? chalk.gray;

  // inner width = outer width - 2 (borders) - 2*padding (interior padding)
  const innerWidth = Math.max(1, outerWidth - 2 - padding * 2);

  const horizontal = BOX_CHARS.horizontal.repeat(outerWidth - 2);

  // Top border — optionally with title inline
  let top: string;
  if (options.title) {
    const titleText = ` ${options.title} `;
    const titleVisual = visualWidth(titleText);
    const remaining = Math.max(0, outerWidth - 2 - titleVisual);
    const leftDash = BOX_CHARS.horizontal.repeat(Math.min(2, remaining));
    const rightDash = BOX_CHARS.horizontal.repeat(
      Math.max(0, remaining - leftDash.length)
    );
    top =
      borderColor(BOX_CHARS.topLeft + leftDash) +
      chalk.bold(titleText) +
      borderColor(rightDash + BOX_CHARS.topRight);
  } else {
    top = borderColor(BOX_CHARS.topLeft + horizontal + BOX_CHARS.topRight);
  }

  const bottom = borderColor(
    BOX_CHARS.bottomLeft + horizontal + BOX_CHARS.bottomRight
  );

  const pad = " ".repeat(padding);
  const vbar = borderColor(BOX_CHARS.vertical);

  const body: string[] = lines.map((line) => {
    const truncated = truncateVisual(line, innerWidth);
    const padded = padEndVisual(truncated, innerWidth);
    return `${vbar}${pad}${padded}${pad}${vbar}`;
  });

  return [top, ...body, bottom].join("\n");
}

export function printBox(lines: string[], options?: BoxOptions): void {
  console.log(box(lines, options));
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface TableOptions {
  headers: string[];
  rows: string[][];
  alignment?: ("left" | "right")[];
}

/**
 * Render a table as a string. Columns auto-size to content; extremely wide
 * columns are truncated to keep the overall table within ~120 columns.
 */
export function table(options: TableOptions): string {
  const { headers, rows, alignment } = options;
  const colCount = headers.length;
  const MAX_TOTAL_WIDTH = 120;
  const SEPARATOR = "  ";

  // Measure raw (un-truncated) column widths.
  const widths: number[] = headers.map((h) => visualWidth(h));
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? "";
      widths[c] = Math.max(widths[c], visualWidth(cell));
    }
  }

  // If the total width exceeds MAX_TOTAL_WIDTH, shrink the widest column
  // progressively until we're under the limit.
  const overhead = SEPARATOR.length * (colCount - 1);
  const totalWidth = () => widths.reduce((a, b) => a + b, 0) + overhead;
  while (totalWidth() > MAX_TOTAL_WIDTH) {
    let idx = 0;
    for (let i = 1; i < widths.length; i++) {
      if (widths[i] > widths[idx]) idx = i;
    }
    if (widths[idx] <= 4) break;
    widths[idx]--;
  }

  const align = (text: string, width: number, col: number): string => {
    const truncated = truncateVisual(text, width);
    const a = alignment?.[col] ?? "left";
    return a === "right"
      ? padStartVisual(truncated, width)
      : padEndVisual(truncated, width);
  };

  const headerLine = headers
    .map((h, i) => align(chalk.bold(h), widths[i], i))
    .join(SEPARATOR);

  const rule = chalk.dim(
    "\u2500".repeat(widths.reduce((a, b) => a + b, 0) + overhead)
  );

  const bodyLines = rows.map((row) =>
    row
      .slice(0, colCount)
      .map((cell, i) => align(cell ?? "", widths[i], i))
      .join(SEPARATOR)
  );

  return [headerLine, rule, ...bodyLines].join("\n");
}

export function printTable(options: TableOptions): void {
  console.log(table(options));
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export function bullet(items: string[], indent: number = 2): string {
  const pad = " ".repeat(indent);
  return items.map((item) => `${pad}${icons.bullet} ${item}`).join("\n");
}

export function numbered(items: string[], indent: number = 2): string {
  const pad = " ".repeat(indent);
  return items
    .map((item, i) => `${pad}${chalk.dim(`${i + 1}.`)} ${item}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Key-value pairs
// ---------------------------------------------------------------------------

export function keyValue(
  pairs: Array<[string, string]>,
  indent: number = 2
): string {
  const pad = " ".repeat(indent);
  const keyWidth = Math.max(0, ...pairs.map(([k]) => visualWidth(k)));
  return pairs
    .map(([k, v]) => `${pad}${padEndVisual(chalk.bold(k), keyWidth)}  ${v}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Separators
// ---------------------------------------------------------------------------

export function divider(char: string = "\u2500", width: number = 60): string {
  return chalk.dim(char.repeat(width));
}

// ---------------------------------------------------------------------------
// Next steps / tip / callout
// ---------------------------------------------------------------------------

export function nextSteps(steps: string[]): void {
  console.log();
  console.log(chalk.bold("Next steps:"));
  for (const step of steps) {
    console.log(`  ${icons.arrow} ${step}`);
  }
}

export function tip(message: string): void {
  console.log(`\uD83D\uDCA1 ${chalk.dim("Tip:")} ${message}`);
}

export function callout(title: string, body: string[]): void {
  const lines = [chalk.bold(title), ...body];
  printBox(lines, { borderColor: chalk.cyan });
}

// ---------------------------------------------------------------------------
// Spinner convenience re-export
// ---------------------------------------------------------------------------

export { ora as spinner };
