import { readFileSync, statSync, existsSync } from "node:fs";
import { basename } from "node:path";
import pdfParse from "pdf-parse";
import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";

/**
 * Connector for PDF files.
 * Uses pdf-parse to extract text content from single and multi-page PDFs.
 */
export class PdfConnector implements SourceConnector {
  readonly type = "pdf" as const;
  readonly name: string;
  private filePaths: string[];
  private status: SourceStatus;

  constructor(name: string, filePaths: string[]) {
    this.name = name;
    this.filePaths = filePaths;
    this.status = {
      name,
      type: "pdf",
      status: "disconnected",
    };
  }

  async validate(): Promise<boolean> {
    const missing = this.filePaths.filter((p) => !existsSync(p));
    if (missing.length > 0) {
      this.status.status = "error";
      this.status.error = `PDF files not found: ${missing.join(", ")}`;
      return false;
    }
    this.status.status = "connected";
    return true;
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";
    let count = 0;

    try {
      for (const filePath of this.filePaths) {
        if (!existsSync(filePath)) {
          continue;
        }

        const stat = statSync(filePath);

        // Incremental: skip files not modified since last sync
        if (options?.since && stat.mtime < options.since) {
          continue;
        }

        const buffer = readFileSync(filePath);
        const parsed = await pdfParse(buffer);

        const fileName = basename(filePath);
        const pageCount = parsed.numpages;

        // Yield the full document with page metadata
        count++;
        yield {
          id: `pdf:${this.name}:${fileName}`,
          sourceType: "pdf",
          sourceName: this.name,
          title: fileName,
          content: parsed.text,
          contentType: "text",
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          metadata: {
            path: filePath,
            pageCount,
            pdfVersion: parsed.version,
            pdfInfo: parsed.info,
          },
        };

        if (options?.limit && count >= options.limit) break;
      }

      this.status.status = "connected";
      this.status.lastSyncAt = new Date().toISOString();
      this.status.itemCount = count;
    } catch (error) {
      this.status.status = "error";
      this.status.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  getStatus(): SourceStatus {
    return { ...this.status };
  }
}
