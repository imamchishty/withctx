import { readFileSync, statSync, existsSync } from "node:fs";
import { basename } from "node:path";
import mammoth from "mammoth";
import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";

/**
 * Connector for Word (.docx) files.
 * Uses mammoth to extract text, tables, and detect embedded images.
 */
export class WordConnector implements SourceConnector {
  readonly type = "word" as const;
  readonly name: string;
  private filePaths: string[];
  private status: SourceStatus;

  constructor(name: string, filePaths: string[]) {
    this.name = name;
    this.filePaths = filePaths;
    this.status = {
      name,
      type: "word",
      status: "disconnected",
    };
  }

  async validate(): Promise<boolean> {
    const missing = this.filePaths.filter((p) => !existsSync(p));
    if (missing.length > 0) {
      this.status.status = "error";
      this.status.error = `Word files not found: ${missing.join(", ")}`;
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

        const buffer = readFileSync(filePath);
        const images: Array<{ name: string; data: Buffer; mimeType: string }> = [];
        let imageIndex = 0;

        // Extract text with inline image detection
        const result = await mammoth.extractRawText({
          buffer,
        });

        // Also convert to HTML to detect images
        const htmlResult = await mammoth.convertToHtml({ buffer }, {
          convertImage: mammoth.images.imgElement((image) => {
            return image.read("base64").then((imageData) => {
              const contentType = image.contentType || "image/png";
              const ext = contentType.split("/")[1] || "png";
              const imageName = `image-${imageIndex++}.${ext}`;
              images.push({
                name: imageName,
                data: Buffer.from(imageData, "base64"),
                mimeType: contentType,
              });
              return { src: `embedded:${imageName}` };
            });
          }),
        });

        const fileName = basename(filePath);

        // Build content: raw text plus any conversion messages
        let content = result.value;
        if (result.messages.length > 0) {
          const warnings = result.messages
            .filter((m) => m.type === "warning")
            .map((m) => m.message);
          if (warnings.length > 0) {
            content += `\n\n[Conversion warnings: ${warnings.join("; ")}]`;
          }
        }

        count++;
        yield {
          id: `word:${this.name}:${fileName}`,
          sourceType: "word",
          sourceName: this.name,
          title: fileName,
          content,
          contentType: "text",
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          metadata: {
            path: filePath,
            hasImages: images.length > 0,
            imageCount: images.length,
            htmlLength: htmlResult.value.length,
          },
          images: images.length > 0 ? images : undefined,
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
