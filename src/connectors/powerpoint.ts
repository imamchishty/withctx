import { readFileSync, statSync, existsSync } from "node:fs";
import { basename } from "node:path";
import JSZip from "jszip";
import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";

/**
 * Connector for PowerPoint (.pptx) files.
 * Parses .pptx (ZIP of XML) to extract slide text, speaker notes, and images.
 */
export class PowerPointConnector implements SourceConnector {
  readonly type = "powerpoint" as const;
  readonly name: string;
  private filePaths: string[];
  private status: SourceStatus;

  constructor(name: string, filePaths: string[]) {
    this.name = name;
    this.filePaths = filePaths;
    this.status = {
      name,
      type: "powerpoint",
      status: "disconnected",
    };
  }

  async validate(): Promise<boolean> {
    const missing = this.filePaths.filter((p) => !existsSync(p));
    if (missing.length > 0) {
      this.status.status = "error";
      this.status.error = `PowerPoint files not found: ${missing.join(", ")}`;
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
        const zip = await JSZip.loadAsync(buffer);

        const slides: Array<{ slideNumber: number; text: string; notes: string }> = [];
        const images: Array<{ name: string; data: Buffer; mimeType: string }> = [];

        // Find all slide XML files (ppt/slides/slide1.xml, etc.)
        const slideFiles = Object.keys(zip.files)
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort((a, b) => {
            const numA = parseInt(a.match(/slide(\d+)/)?.[1] || "0", 10);
            const numB = parseInt(b.match(/slide(\d+)/)?.[1] || "0", 10);
            return numA - numB;
          });

        for (const slideFile of slideFiles) {
          const slideNum = parseInt(slideFile.match(/slide(\d+)/)?.[1] || "0", 10);
          const xmlContent = await zip.files[slideFile].async("text");
          const slideText = this.extractTextFromXml(xmlContent);

          // Look for corresponding notes file
          const notesFile = `ppt/notesSlides/notesSlide${slideNum}.xml`;
          let notesText = "";
          if (zip.files[notesFile]) {
            const notesXml = await zip.files[notesFile].async("text");
            notesText = this.extractTextFromXml(notesXml);
          }

          slides.push({
            slideNumber: slideNum,
            text: slideText,
            notes: notesText,
          });
        }

        // Extract embedded images from ppt/media/
        const mediaFiles = Object.keys(zip.files).filter((name) =>
          /^ppt\/media\//.test(name)
        );

        for (const mediaFile of mediaFiles) {
          const fileName = mediaFile.split("/").pop() || mediaFile;
          const ext = fileName.split(".").pop()?.toLowerCase() || "";
          const mimeMap: Record<string, string> = {
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            svg: "image/svg+xml",
            emf: "image/emf",
            wmf: "image/wmf",
            tiff: "image/tiff",
            tif: "image/tiff",
          };

          const mimeType = mimeMap[ext];
          if (mimeType) {
            const data = await zip.files[mediaFile].async("nodebuffer");
            images.push({ name: fileName, data, mimeType });
          }
        }

        // Format content as structured text
        const contentParts: string[] = [];
        for (const slide of slides) {
          contentParts.push(`## Slide ${slide.slideNumber}\n\n${slide.text}`);
          if (slide.notes.trim()) {
            contentParts.push(`**Speaker Notes:**\n${slide.notes}`);
          }
        }

        const fileName = basename(filePath);

        count++;
        yield {
          id: `powerpoint:${this.name}:${fileName}`,
          sourceType: "powerpoint",
          sourceName: this.name,
          title: fileName,
          content: contentParts.join("\n\n---\n\n"),
          contentType: "text",
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          metadata: {
            path: filePath,
            slideCount: slides.length,
            hasImages: images.length > 0,
            imageCount: images.length,
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

  /**
   * Extract all text content from an Office Open XML string.
   * Looks for <a:t> tags which contain the actual text runs.
   */
  private extractTextFromXml(xml: string): string {
    // Split on paragraph boundaries (<a:p>) and extract text runs (<a:t>) within each
    const paragraphs: string[] = [];
    const parts = xml.split(/<a:p[\s>]/);

    for (const part of parts) {
      const partTexts: string[] = [];
      const partTextRegex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
      let partMatch: RegExpExecArray | null;
      while ((partMatch = partTextRegex.exec(part)) !== null) {
        partTexts.push(partMatch[1]);
      }
      if (partTexts.length > 0) {
        paragraphs.push(partTexts.join(""));
      }
    }

    return paragraphs.join("\n").trim();
  }
}
