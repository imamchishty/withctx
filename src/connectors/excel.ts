import { readFileSync, statSync, existsSync } from "node:fs";
import { basename, extname } from "node:path";
import XLSX from "xlsx";
import { parse as csvParse } from "csv-parse/sync";
import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";

/**
 * Connector for Excel (.xlsx) and CSV (.csv) files.
 * Uses xlsx library for spreadsheets and csv-parse for CSV files.
 * Formats output as markdown tables.
 */
export class ExcelConnector implements SourceConnector {
  readonly type = "excel" as const;
  readonly name: string;
  private filePaths: string[];
  private status: SourceStatus;

  constructor(name: string, filePaths: string[]) {
    this.name = name;
    this.filePaths = filePaths;
    this.status = {
      name,
      type: "excel",
      status: "disconnected",
    };
  }

  async validate(): Promise<boolean> {
    const missing = this.filePaths.filter((p) => !existsSync(p));
    if (missing.length > 0) {
      this.status.status = "error";
      this.status.error = `Files not found: ${missing.join(", ")}`;
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

        if (options?.since && stat.mtime < options.since) {
          continue;
        }

        const ext = extname(filePath).toLowerCase();
        const fileName = basename(filePath);

        let content: string;
        let sheetCount = 1;
        let totalRows = 0;
        let sheetNames: string[] = [];

        if (ext === ".csv" || ext === ".tsv") {
          const result = this.parseCsv(filePath, ext === ".tsv" ? "\t" : ",");
          content = result.content;
          totalRows = result.rowCount;
        } else {
          const result = this.parseExcel(filePath);
          content = result.content;
          sheetCount = result.sheetCount;
          totalRows = result.totalRows;
          sheetNames = result.sheetNames;
        }

        count++;
        yield {
          id: `excel:${this.name}:${fileName}`,
          sourceType: "excel",
          sourceName: this.name,
          title: fileName,
          content,
          contentType: "text",
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          metadata: {
            path: filePath,
            extension: ext,
            sheetCount,
            totalRows,
            sheetNames: sheetNames.length > 0 ? sheetNames : undefined,
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

  private parseCsv(
    filePath: string,
    delimiter: string
  ): { content: string; rowCount: number } {
    const raw = readFileSync(filePath, "utf-8");
    const records: string[][] = csvParse(raw, {
      delimiter,
      relax_quotes: true,
      skip_empty_lines: true,
    });

    if (records.length === 0) {
      return { content: "(empty file)", rowCount: 0 };
    }

    const content = this.toMarkdownTable(records[0], records.slice(1));
    return { content, rowCount: records.length - 1 };
  }

  private parseExcel(filePath: string): {
    content: string;
    sheetCount: number;
    totalRows: number;
    sheetNames: string[];
  } {
    const buffer = readFileSync(filePath);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const parts: string[] = [];
    let totalRows = 0;

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;

      const data: string[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: "",
        raw: false,
      });

      if (data.length === 0) {
        parts.push(`## ${sheetName}\n\n(empty sheet)`);
        continue;
      }

      // First row as headers
      const headers = data[0].map((h) => String(h));
      const rows = data.slice(1).map((row) => row.map((c) => String(c)));
      totalRows += rows.length;

      parts.push(`## ${sheetName}\n\n${this.toMarkdownTable(headers, rows)}`);
    }

    return {
      content: parts.join("\n\n---\n\n"),
      sheetCount: workbook.SheetNames.length,
      totalRows,
      sheetNames: workbook.SheetNames,
    };
  }

  /**
   * Format rows as a markdown table.
   */
  private toMarkdownTable(headers: string[], rows: string[][]): string {
    if (headers.length === 0) return "(no data)";

    const escape = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
    const headerRow = `| ${headers.map(escape).join(" | ")} |`;
    const separator = `| ${headers.map(() => "---").join(" | ")} |`;
    const dataRows = rows.map(
      (row) =>
        `| ${headers
          .map((_, i) => escape(row[i] ?? ""))
          .join(" | ")} |`
    );

    return [headerRow, separator, ...dataRows].join("\n");
  }
}
