import { CtxDirectory } from "../storage/ctx-dir.js";
import type { LogEntry } from "../types/page.js";

/**
 * Maintains the log.md chronological record.
 */
export class LogManager {
  private ctx: CtxDirectory;

  constructor(ctx: CtxDirectory) {
    this.ctx = ctx;
  }

  /**
   * Append a log entry.
   */
  append(entry: Omit<LogEntry, "timestamp">): void {
    const existing = this.ctx.readPage("log.md") ?? "";
    const timestamp = new Date().toISOString();
    const pages = entry.pagesAffected?.join(", ") ?? "";
    const line = `| ${timestamp} | ${entry.action} | ${entry.detail}${pages ? ` (${pages})` : ""} |`;

    // Append to the table
    const updated = existing.trimEnd() + "\n" + line + "\n";
    this.ctx.writePage("log.md", updated);
  }

  /**
   * Read the last N log entries.
   */
  getRecent(count: number = 20): LogEntry[] {
    const content = this.ctx.readPage("log.md");
    if (!content) return [];

    const lines = content.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| Timestamp") && !l.startsWith("|---"));

    return lines.slice(-count).map((line) => {
      const parts = line.split("|").map((p) => p.trim()).filter(Boolean);
      return {
        timestamp: parts[0] ?? "",
        action: (parts[1] ?? "unknown") as LogEntry["action"],
        detail: parts[2] ?? "",
      };
    });
  }
}
