import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";
import { processMarkdown } from "./markdown-processor.js";

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".rst", ".adoc",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".scala",
  ".c", ".cpp", ".h", ".hpp", ".cs",
  ".sh", ".bash", ".zsh", ".fish",
  ".yaml", ".yml", ".json", ".toml", ".ini", ".cfg",
  ".xml", ".html", ".css", ".scss", ".less",
  ".sql", ".graphql", ".gql",
  ".tf", ".hcl",
  ".dockerfile", ".env.example",
  ".gitignore", ".editorconfig",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next",
  "__pycache__", ".venv", "venv", "target",
  ".ctx", ".turbo", "coverage",
]);

/**
 * Connector for local files (markdown, code, text).
 */
export class LocalFilesConnector implements SourceConnector {
  readonly type = "local" as const;
  readonly name: string;
  private basePath: string;
  private status: SourceStatus;

  constructor(name: string, basePath: string) {
    this.name = name;
    this.basePath = basePath;
    this.status = {
      name,
      type: "local",
      status: "disconnected",
    };
  }

  async validate(): Promise<boolean> {
    if (existsSync(this.basePath)) {
      this.status.status = "connected";
      return true;
    }
    this.status.status = "error";
    this.status.error = `Path does not exist: ${this.basePath}`;
    return false;
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";
    let count = 0;

    try {
      for (const filePath of this.walkFiles(this.basePath)) {
        const stat = statSync(filePath);

        // Incremental: skip files not modified since last sync
        if (options?.since && stat.mtime < options.since) {
          continue;
        }

        const ext = extname(filePath).toLowerCase();
        if (!TEXT_EXTENSIONS.has(ext) && ext !== "") continue;

        // Skip files without extension that aren't known names
        const name = basename(filePath);
        if (ext === "" && !["Makefile", "Dockerfile", "Procfile", "Gemfile", "Rakefile"].includes(name)) {
          continue;
        }

        const content = readFileSync(filePath, "utf-8");
        const relativePath = relative(this.basePath, filePath);

        // Process markdown files through the smart parser
        if (ext === ".md") {
          const processed = processMarkdown(relativePath, content, this.basePath);
          count++;
          yield {
            id: `local:${this.name}:${relativePath}`,
            sourceType: "local",
            sourceName: this.name,
            title: processed.metadata.title,
            content,
            contentType: "text",
            author: processed.metadata.author,
            createdAt: stat.birthtime.toISOString(),
            updatedAt: stat.mtime.toISOString(),
            metadata: {
              path: relativePath,
              extension: ext,
              size: stat.size,
              docType: processed.metadata.docType,
              tags: processed.metadata.tags,
              sectionsCount: processed.sections.length,
              crossReferences: processed.crossReferences.map((ref) => ref.targetPath),
              frontmatter: processed.metadata.custom,
            },
          };
        } else {
          count++;
          yield {
            id: `local:${this.name}:${relativePath}`,
            sourceType: "local",
            sourceName: this.name,
            title: relativePath,
            content,
            contentType: this.isCode(ext) ? "code" : "text",
            createdAt: stat.birthtime.toISOString(),
            updatedAt: stat.mtime.toISOString(),
            metadata: {
              path: relativePath,
              extension: ext,
              size: stat.size,
            },
          };
        }

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

  private *walkFiles(dir: string): Generator<string> {
    if (!existsSync(dir)) return;

    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walkFiles(fullPath);
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  }

  private isCode(ext: string): boolean {
    const codeExts = new Set([
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
      ".py", ".rb", ".go", ".rs", ".java", ".kt", ".scala",
      ".c", ".cpp", ".h", ".hpp", ".cs",
      ".sh", ".bash", ".sql", ".graphql",
    ]);
    return codeExts.has(ext);
  }
}
