import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { CtxDirectory } from "./ctx-dir.js";
import type { ExportResult } from "../types/page.js";

/**
 * Manages the .ctx/exports/ directory.
 * Writes export files and creates timestamped snapshots.
 */
export class ExportManager {
  private ctx: CtxDirectory;

  constructor(ctx: CtxDirectory) {
    this.ctx = ctx;
  }

  /**
   * Ensure the exports directory and snapshots subdirectory exist.
   */
  initialize(): void {
    mkdirSync(this.ctx.exportsPath, { recursive: true });
    mkdirSync(join(this.ctx.exportsPath, "snapshots"), { recursive: true });
  }

  /**
   * Write an export result to a file in the exports directory.
   * Returns the path of the written file.
   */
  writeExport(result: ExportResult, filename?: string): string {
    const name = filename ?? defaultFilename(result.format);
    const fullPath = join(this.ctx.exportsPath, name);

    writeFileSync(fullPath, result.content, "utf-8");
    return fullPath;
  }

  /**
   * Write an export and also save a timestamped snapshot.
   * Returns { exportPath, snapshotPath }.
   */
  writeWithSnapshot(
    result: ExportResult,
    filename?: string
  ): { exportPath: string; snapshotPath: string } {
    const exportPath = this.writeExport(result, filename);

    // Create timestamped snapshot
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const ext = getExtension(result.format);
    const snapshotName = `${result.format}_${timestamp}${ext}`;
    const snapshotPath = join(
      this.ctx.exportsPath,
      "snapshots",
      snapshotName
    );

    writeFileSync(snapshotPath, result.content, "utf-8");

    return { exportPath, snapshotPath };
  }

  /**
   * Read an export file by name.
   */
  readExport(filename: string): string | null {
    const fullPath = join(this.ctx.exportsPath, filename);
    if (!existsSync(fullPath)) return null;
    return readFileSync(fullPath, "utf-8");
  }

  /**
   * List all export files (excluding snapshots directory).
   */
  listExports(): string[] {
    if (!existsSync(this.ctx.exportsPath)) return [];
    return readdirSync(this.ctx.exportsPath).filter(
      (f) => f !== "snapshots" && !f.startsWith(".")
    );
  }

  /**
   * List all snapshot files.
   */
  listSnapshots(): string[] {
    const snapshotsDir = join(this.ctx.exportsPath, "snapshots");
    if (!existsSync(snapshotsDir)) return [];
    return readdirSync(snapshotsDir).sort().reverse(); // newest first
  }
}

function defaultFilename(format: string): string {
  switch (format) {
    case "claude-md":
      return "CLAUDE.md";
    case "system-prompt":
      return "system-prompt.txt";
    case "markdown":
      return "wiki-export.md";
    default:
      return `export-${format}.md`;
  }
}

function getExtension(format: string): string {
  switch (format) {
    case "system-prompt":
      return ".txt";
    default:
      return ".md";
  }
}
