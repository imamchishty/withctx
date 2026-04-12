import { readdirSync, readFileSync, existsSync, lstatSync, type Stats } from "node:fs";
import { join, relative, extname, basename, resolve, sep } from "node:path";
import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";
import { processMarkdown } from "./markdown-processor.js";

/**
 * Maximum directory recursion depth. Prevents a malicious source tree
 * with thousands of nested directories from blowing the stack or
 * wasting IO. 50 levels is well beyond any legitimate project layout.
 */
const MAX_WALK_DEPTH = 50;

/**
 * Hard cap on a single file. Files larger than this are skipped to
 * avoid memory exhaustion — 10 MB is generous for markdown, code and
 * config; anything bigger is almost certainly a binary or a log dump.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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
 * Binary document extensions that the local connector can parse via
 * dynamic imports. When the walker encounters one of these, it routes
 * through the dedicated parser (pdf-parse, mammoth, xlsx, jszip)
 * instead of trying to read the file as UTF-8 text.
 *
 * Dynamic imports so projects without binary docs don't pay the
 * startup cost.
 */
const BINARY_DOC_EXTENSIONS = new Set([
  ".pdf",
  ".docx", ".doc",
  ".xlsx", ".xls", ".csv",
  ".pptx", ".ppt",
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
    // Resolve the base path once so walk-time containment checks don't
    // allocate on every file. This is the canonical "inside" boundary.
    const canonicalBase = resolve(this.basePath);

    try {
      for (const filePath of this.walkFiles(canonicalBase, 0)) {
        // Defence in depth: re-verify that the yielded path still sits
        // inside the source root. walkFiles already filters symlinks,
        // but a TOCTOU swap between readdir and statSync could in
        // principle let a symlink slip through. Drop anything whose
        // real path climbs out of the source directory.
        const realPath = resolve(filePath);
        if (realPath !== canonicalBase && !realPath.startsWith(canonicalBase + sep)) {
          continue;
        }

        // Use lstat here so a symlink swap cannot trick us into
        // reading a file we couldn't see at walk time.
        const stat = lstatSync(filePath);
        if (stat.isSymbolicLink()) continue;
        if (!stat.isFile()) continue;

        // Incremental: skip files not modified since last sync
        if (options?.since && stat.mtime < options.since) {
          continue;
        }

        // Refuse to load absurdly large files — they almost certainly
        // aren't useful wiki sources and will just burn LLM tokens.
        if (stat.size > MAX_FILE_BYTES) {
          continue;
        }

        const ext = extname(filePath).toLowerCase();
        const isBinaryDoc = BINARY_DOC_EXTENSIONS.has(ext);
        if (!TEXT_EXTENSIONS.has(ext) && !isBinaryDoc && ext !== "") continue;

        // Skip files without extension that aren't known names
        const name = basename(filePath);
        if (ext === "" && !["Makefile", "Dockerfile", "Procfile", "Gemfile", "Rakefile"].includes(name)) {
          continue;
        }

        const relativePath = relative(canonicalBase, filePath);

        // ── Binary documents (PDF, Word, Excel, PowerPoint) ─────
        //
        // Route through the dedicated parser via dynamic import so
        // projects without binary docs don't pay the startup cost.
        // If the parser throws (missing dep, corrupt file), we
        // skip the file and keep going — one bad PDF shouldn't
        // kill the whole ingest.
        if (isBinaryDoc) {
          try {
            const doc = await this.parseBinaryDocument(filePath, relativePath, ext, stat);
            if (doc) {
              count++;
              yield doc;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `[withctx] skipping ${relativePath}: ${msg}\n`,
            );
          }
          if (options?.limit && count >= options.limit) break;
          continue;
        }

        const content = readFileSync(filePath, "utf-8");

        // Process markdown files through the smart parser
        if (ext === ".md") {
          const processed = processMarkdown(relativePath, content, canonicalBase);
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

  /**
   * Walk a directory tree yielding file paths.
   *
   * Security notes:
   * - Symlinks are explicitly skipped (both file and directory). This
   *   stops an attacker or careless user from causing withctx to read
   *   arbitrary files on the host (e.g. a `docs/` symlink pointing at
   *   `/etc/passwd`) or fall into a link cycle.
   * - Recursion is bounded by {@link MAX_WALK_DEPTH} so a pathological
   *   tree cannot exhaust the stack.
   * - `readdirSync` with `withFileTypes: true` returns Dirent objects
   *   whose `isFile`/`isDirectory` methods DO NOT follow symlinks, so
   *   the symlink check is redundant-but-explicit defence in depth.
   */
  private *walkFiles(dir: string, depth: number): Generator<string> {
    if (depth > MAX_WALK_DEPTH) return;
    if (!existsSync(dir)) return;

    // Bail if `dir` itself is a symlink. Without this check, the very
    // first invocation could follow a symlink root into anywhere.
    let dirStat;
    try {
      dirStat = lstatSync(dir);
    } catch {
      return;
    }
    if (dirStat.isSymbolicLink()) return;
    if (!dirStat.isDirectory()) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Permission denied, disappeared mid-walk, etc. — skip silently.
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      // Skip symlinks explicitly. Dirent.isFile/isDirectory already
      // report false for symlinks, but we check here so the intent is
      // obvious to future readers.
      if (entry.isSymbolicLink()) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walkFiles(fullPath, depth + 1);
      } else if (entry.isFile()) {
        yield fullPath;
      }
    }
  }

  /**
   * Parse a binary document (PDF, Word, Excel, PowerPoint) via dynamic
   * import. Returns a RawDocument or null if the content is empty.
   *
   * Dynamic imports keep startup fast — projects without binary docs
   * never load mammoth, xlsx, pdf-parse, or jszip.
   */
  private async parseBinaryDocument(
    filePath: string,
    relativePath: string,
    ext: string,
    stat: Stats,
  ): Promise<RawDocument | null> {
    let content: string;

    switch (ext) {
      // ── PDF ──────────────────────────────────────────────────────
      case ".pdf": {
        const pdfParse = (await import("pdf-parse")).default;
        const buffer = readFileSync(filePath);
        const result = await pdfParse(buffer);
        content = result.text;
        break;
      }

      // ── Word (.docx / .doc) ──────────────────────────────────────
      case ".docx":
      case ".doc": {
        const mammoth = await import("mammoth");
        const result = await mammoth.default.extractRawText({ path: filePath });
        content = result.value;
        break;
      }

      // ── Excel (.xlsx / .xls) ─────────────────────────────────────
      case ".xlsx":
      case ".xls": {
        const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
        const workbook = XLSX.readFile(filePath);
        const sheets: string[] = [];

        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const data: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
          if (data.length === 0) continue;

          let table = `### ${sheetName}\n\n`;
          const headers = data[0].map(String);
          table += `| ${headers.join(" | ")} |\n`;
          table += `| ${headers.map(() => "---").join(" | ")} |\n`;

          for (let i = 1; i < data.length && i < 500; i++) {
            const row = data[i].map(String);
            table += `| ${row.join(" | ")} |\n`;
          }

          sheets.push(table);
        }

        content = sheets.join("\n\n");
        break;
      }

      // ── CSV ──────────────────────────────────────────────────────
      case ".csv": {
        content = readFileSync(filePath, "utf-8");
        break;
      }

      // ── PowerPoint (.pptx / .ppt) ───────────────────────────────
      case ".pptx":
      case ".ppt": {
        const JSZip = (await import("jszip")).default;
        const data = readFileSync(filePath);
        const zip = await JSZip.loadAsync(data);
        const slides: string[] = [];

        let slideNum = 1;
        while (true) {
          const slideFile = zip.file(`ppt/slides/slide${slideNum}.xml`);
          if (!slideFile) break;

          const xml = await slideFile.async("text");
          const textMatches = xml.match(/<a:t>([^<]*)<\/a:t>/g) ?? [];
          const texts = textMatches.map((m: string) =>
            m.replace(/<a:t>/, "").replace(/<\/a:t>/, ""),
          );

          if (texts.length > 0) {
            slides.push(`### Slide ${slideNum}\n\n${texts.join("\n")}`);
          }
          slideNum++;
        }

        content = slides.join("\n\n");
        break;
      }

      default:
        return null;
    }

    if (!content || content.trim().length === 0) return null;

    return {
      id: `local:${this.name}:${relativePath}`,
      sourceType: "local",
      sourceName: this.name,
      title: relativePath,
      content,
      contentType: "text",
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      metadata: {
        path: relativePath,
        extension: ext,
        size: stat.size,
        binaryFormat: ext.replace(".", ""),
      },
    };
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
