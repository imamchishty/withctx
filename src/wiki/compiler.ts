import type { RawDocument } from "../types/source.js";
import type { WikiPage } from "../types/page.js";
import type { PageManager } from "./pages.js";
import type { IndexManager } from "./index-manager.js";
import type { LogManager } from "./log-manager.js";
import { ClaudeClient } from "../claude/client.js";
import {
  COMPILE_SYSTEM_PROMPT,
  formatCompilePrompt,
  formatUpdatePrompt,
  formatRepoOverviewPrompt,
  formatCrossRepoPrompt,
} from "../claude/prompts/compile.js";
import { formatOnboardingPrompt } from "../claude/prompts/onboard.js";
import { processImage } from "../claude/vision.js";
import { runQualityPipeline } from "../quality/index.js";
import { createAttributions, formatAttributionFooter } from "../quality/attribution.js";

/**
 * Stats returned after a compilation run.
 */
export interface CompilationStats {
  pagesCreated: number;
  pagesUpdated: number;
  pagesSkipped: number;
  tokensUsed: number;
  duration: number;
  errors: string[];
}

/**
 * Options for controlling compilation behavior.
 */
export interface CompileOptions {
  /** Only process documents newer than this date */
  since?: Date;
  /** Only process documents from these sources */
  sources?: string[];
  /** Generate cross-repo analysis pages */
  crossRepo?: boolean;
  /** Generate onboarding pages */
  onboarding?: boolean;
  /** Maximum documents to process per Claude call */
  batchSize?: number;
  /** Dry run — compute what would change without writing */
  dryRun?: boolean;
}

/**
 * Parsed page output from Claude's compilation response.
 */
interface ParsedPage {
  path: string;
  content: string;
  isUpdate: boolean;
}

/**
 * Groups documents by a key for batch processing.
 */
interface DocumentGroup {
  key: string;
  type: "repo" | "service" | "general";
  documents: RawDocument[];
}

/**
 * Main wiki compiler. Takes raw documents from connectors,
 * sends them to Claude for compilation, and writes the resulting
 * wiki pages.
 */
export class WikiCompiler {
  private pages: PageManager;
  private index: IndexManager;
  private log: LogManager;
  private claude: ClaudeClient;

  constructor(
    pages: PageManager,
    index: IndexManager,
    log: LogManager,
    claude?: ClaudeClient
  ) {
    this.pages = pages;
    this.index = index;
    this.log = log;
    this.claude = claude ?? new ClaudeClient();
  }

  /**
   * Compile raw documents into wiki pages.
   * This is the main entry point for the compilation pipeline.
   */
  async compile(
    documents: RawDocument[],
    options: CompileOptions = {}
  ): Promise<CompilationStats> {
    const start = Date.now();
    const stats: CompilationStats = {
      pagesCreated: 0,
      pagesUpdated: 0,
      pagesSkipped: 0,
      tokensUsed: 0,
      duration: 0,
      errors: [],
    };

    if (documents.length === 0) {
      stats.duration = Date.now() - start;
      return stats;
    }

    // Filter by date if incremental
    let docs = options.since
      ? documents.filter((d) => {
          if (!d.updatedAt) return true;
          return new Date(d.updatedAt) > options.since!;
        })
      : documents;

    // Filter by source if specified
    if (options.sources && options.sources.length > 0) {
      const sourceSet = new Set(options.sources);
      docs = docs.filter((d) => sourceSet.has(d.sourceName));
    }

    if (docs.length === 0) {
      stats.duration = Date.now() - start;
      return stats;
    }

    // Run quality pipeline — validate, deduplicate, score freshness
    const { documents: cleanDocs, stats: qualityStats } = runQualityPipeline(docs);

    if (qualityStats.warnings.length > 0) {
      for (const warning of qualityStats.warnings) {
        stats.errors.push(`[quality] ${warning}`);
      }
    }

    if (cleanDocs.length === 0) {
      stats.duration = Date.now() - start;
      return stats;
    }

    docs = cleanDocs;

    // Process images first — convert to text descriptions
    docs = await this.processDocumentImages(docs, stats);

    // Group documents for batch processing
    const groups = this.groupDocuments(docs);

    // Get existing pages for cross-referencing
    const existingPages = this.pages.list();

    // Process each group
    for (const group of groups) {
      try {
        await this.processGroup(group, existingPages, options, stats);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        stats.errors.push(`Error processing group "${group.key}": ${message}`);
      }
    }

    // Generate cross-repo pages if requested and we have multiple repos
    if (options.crossRepo !== false) {
      const repoGroups = groups.filter((g) => g.type === "repo");
      if (repoGroups.length > 1) {
        try {
          await this.generateCrossRepoPages(
            repoGroups.map((g) => g.key),
            options,
            stats
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          stats.errors.push(`Error generating cross-repo pages: ${message}`);
        }
      }
    }

    // Generate onboarding pages if requested
    if (options.onboarding) {
      try {
        await this.generateOnboardingPages(options, stats);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        stats.errors.push(`Error generating onboarding pages: ${message}`);
      }
    }

    // Update index and log
    if (!options.dryRun) {
      this.index.rebuild();
      this.log.append({
        action: "compile",
        detail: `Compiled ${docs.length} documents: ${stats.pagesCreated} created, ${stats.pagesUpdated} updated`,
        pagesAffected: this.pages.list().slice(0, 20),
      });
    }

    stats.duration = Date.now() - start;
    return stats;
  }

  /**
   * Process images in documents, converting them to text descriptions
   * that can be included in compilation prompts.
   */
  private async processDocumentImages(
    docs: RawDocument[],
    stats: CompilationStats
  ): Promise<RawDocument[]> {
    const processed: RawDocument[] = [];

    for (const doc of docs) {
      if (!doc.images || doc.images.length === 0) {
        processed.push(doc);
        continue;
      }

      let augmentedContent = doc.content;

      for (const image of doc.images) {
        try {
          // Write image to a temp location for vision processing
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { join } = await import("node:path");
          const { tmpdir } = await import("node:os");

          const tempDir = join(tmpdir(), "withctx-images");
          mkdirSync(tempDir, { recursive: true });
          const tempPath = join(tempDir, image.name);
          writeFileSync(tempPath, image.data);

          const description = await processImage(
            tempPath,
            `Image from document: ${doc.title}`
          );

          augmentedContent += `\n\n### Image: ${image.name}\n\n${description}`;
        } catch {
          augmentedContent += `\n\n### Image: ${image.name}\n\n_Image could not be processed._`;
        }
      }

      processed.push({
        ...doc,
        content: augmentedContent,
      });
    }

    return processed;
  }

  /**
   * Group documents by type and source for efficient batch processing.
   */
  private groupDocuments(docs: RawDocument[]): DocumentGroup[] {
    const groups = new Map<string, DocumentGroup>();

    for (const doc of docs) {
      let key: string;
      let type: DocumentGroup["type"];

      if (doc.sourceType === "github" || doc.sourceType === "local") {
        // Group by repo name (extracted from sourceName)
        key = doc.sourceName;
        type = "repo";
      } else if (
        doc.metadata?.serviceId ||
        doc.metadata?.serviceName
      ) {
        key = String(doc.metadata.serviceId ?? doc.metadata.serviceName);
        type = "service";
      } else {
        // General documents grouped by source type
        key = doc.sourceType;
        type = "general";
      }

      if (!groups.has(key)) {
        groups.set(key, { key, type, documents: [] });
      }
      groups.get(key)!.documents.push(doc);
    }

    return Array.from(groups.values());
  }

  /**
   * Process a single document group through Claude compilation.
   */
  private async processGroup(
    group: DocumentGroup,
    existingPages: string[],
    options: CompileOptions,
    stats: CompilationStats
  ): Promise<void> {
    const batchSize = options.batchSize ?? 10;
    const batches = this.createBatches(group.documents, batchSize);

    for (const batch of batches) {
      const parsedPages = await this.compileBatch(
        batch,
        group,
        existingPages,
        stats
      );

      if (options.dryRun) {
        stats.pagesSkipped += parsedPages.length;
        continue;
      }

      for (const parsed of parsedPages) {
        this.writeParsedPage(parsed, existingPages, stats);

        // Append attribution footer
        const attribution = createAttributions(parsed.path, batch);
        const footer = formatAttributionFooter(attribution);
        const existing = this.pages.read(parsed.path);
        if (existing) {
          this.pages.write(parsed.path, existing.content + footer);
        }
      }
    }
  }

  /**
   * Send a batch of documents to Claude for compilation.
   */
  private async compileBatch(
    batch: RawDocument[],
    group: DocumentGroup,
    existingPages: string[],
    stats: CompilationStats
  ): Promise<ParsedPage[]> {
    let prompt: string;

    if (group.type === "repo") {
      prompt = formatRepoOverviewPrompt(group.key, batch);
    } else {
      prompt = formatCompilePrompt(batch, existingPages);
    }

    const response = await this.claude.prompt(prompt, {
      systemPrompt: COMPILE_SYSTEM_PROMPT,
      maxTokens: 8192,
      cacheSystemPrompt: true,
    });

    stats.tokensUsed += response.tokensUsed ? (response.tokensUsed.input + response.tokensUsed.output) : 0;

    return this.parseCompilationResponse(response.content);
  }

  /**
   * Parse Claude's response into individual page outputs.
   * Handles the === PAGE: path === and === UPDATE: path === markers.
   */
  private parseCompilationResponse(response: string): ParsedPage[] {
    const pages: ParsedPage[] = [];
    const pagePattern = /^===\s*(PAGE|UPDATE):\s*(.+?)\s*===\s*$/gm;
    const matches: Array<{ type: string; path: string; index: number }> = [];

    let match: RegExpExecArray | null;
    while ((match = pagePattern.exec(response)) !== null) {
      matches.push({
        type: match[1],
        path: match[2],
        index: match.index + match[0].length,
      });
    }

    // If no markers found, treat entire response as a single page
    if (matches.length === 0) {
      const titleMatch = response.match(/^#\s+(.+)$/m);
      if (titleMatch) {
        const slug = titleMatch[1]
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "");
        pages.push({
          path: `${slug}.md`,
          content: response.trim(),
          isUpdate: false,
        });
      }
      return pages;
    }

    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const nextIndex =
        i + 1 < matches.length
          ? response.lastIndexOf("===", matches[i + 1].index - 10)
          : response.length;

      const content = response.slice(current.index, nextIndex).trim();

      if (content) {
        pages.push({
          path: normalizePath(current.path),
          content,
          isUpdate: current.type === "UPDATE",
        });
      }
    }

    return pages;
  }

  /**
   * Write a parsed page to the wiki, tracking stats.
   */
  private writeParsedPage(
    parsed: ParsedPage,
    existingPages: string[],
    stats: CompilationStats
  ): void {
    const exists = existingPages.includes(parsed.path);

    if (parsed.isUpdate && !exists) {
      // Marked as update but page doesn't exist — create it
      this.pages.write(parsed.path, parsed.content);
      stats.pagesCreated++;
    } else if (exists) {
      this.pages.write(parsed.path, parsed.content);
      stats.pagesUpdated++;
    } else {
      this.pages.write(parsed.path, parsed.content);
      stats.pagesCreated++;
    }

    // Track new page in existing list for subsequent cross-references
    if (!existingPages.includes(parsed.path)) {
      existingPages.push(parsed.path);
    }
  }

  /**
   * Generate cross-repo analysis pages.
   */
  private async generateCrossRepoPages(
    repoNames: string[],
    options: CompileOptions,
    stats: CompilationStats
  ): Promise<void> {
    // Gather all repo pages
    const repoPages: WikiPage[] = [];
    for (const repoName of repoNames) {
      const repoPaths = this.pages.list(`repos/${repoName}`);
      for (const pagePath of repoPaths) {
        const page = this.pages.read(pagePath);
        if (page) repoPages.push(page);
      }
    }

    if (repoPages.length === 0) return;

    const prompt = formatCrossRepoPrompt(repoNames, repoPages);
    const response = await this.claude.prompt(prompt, {
      systemPrompt: COMPILE_SYSTEM_PROMPT,
      maxTokens: 8192,
      cacheSystemPrompt: true,
    });

    stats.tokensUsed += response.tokensUsed ? (response.tokensUsed.input + response.tokensUsed.output) : 0;

    const parsed = this.parseCompilationResponse(response.content);

    if (!options.dryRun) {
      const existingPages = this.pages.list();
      for (const page of parsed) {
        this.writeParsedPage(page, existingPages, stats);
      }
    } else {
      stats.pagesSkipped += parsed.length;
    }
  }

  /**
   * Generate onboarding pages from existing wiki content.
   */
  private async generateOnboardingPages(
    options: CompileOptions,
    stats: CompilationStats
  ): Promise<void> {
    const allPages: WikiPage[] = [];
    for (const pagePath of this.pages.list()) {
      const page = this.pages.read(pagePath);
      if (page) allPages.push(page);
    }

    if (allPages.length === 0) return;

    // Generate project-level onboarding
    const prompt = formatOnboardingPrompt(allPages);
    const response = await this.claude.prompt(prompt, {
      systemPrompt: COMPILE_SYSTEM_PROMPT,
      maxTokens: 8192,
      cacheSystemPrompt: true,
    });

    stats.tokensUsed += response.tokensUsed ? (response.tokensUsed.input + response.tokensUsed.output) : 0;

    const parsed = this.parseCompilationResponse(response.content);

    if (!options.dryRun) {
      const existingPages = this.pages.list();
      for (const page of parsed) {
        this.writeParsedPage(page, existingPages, stats);
      }
    } else {
      stats.pagesSkipped += parsed.length;
    }

    // Generate per-repo onboarding if repos exist
    const repoDirs = new Set<string>();
    for (const p of this.pages.list("repos")) {
      const parts = p.split("/");
      if (parts.length >= 2) {
        repoDirs.add(parts[1]);
      }
    }

    for (const repoName of repoDirs) {
      const repoPages: WikiPage[] = [];
      for (const pagePath of this.pages.list(`repos/${repoName}`)) {
        const page = this.pages.read(pagePath);
        if (page) repoPages.push(page);
      }

      if (repoPages.length === 0) continue;

      try {
        const repoPrompt = formatOnboardingPrompt(repoPages, repoName);
        const repoResponse = await this.claude.prompt(repoPrompt, {
          systemPrompt: COMPILE_SYSTEM_PROMPT,
          maxTokens: 4096,
          cacheSystemPrompt: true,
        });

        stats.tokensUsed += repoResponse.tokensUsed ? (repoResponse.tokensUsed.input + repoResponse.tokensUsed.output) : 0;

        const repoParsed = this.parseCompilationResponse(
          repoResponse.content
        );

        if (!options.dryRun) {
          const existingPages = this.pages.list();
          for (const page of repoParsed) {
            this.writeParsedPage(page, existingPages, stats);
          }
        } else {
          stats.pagesSkipped += repoParsed.length;
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        stats.errors.push(
          `Error generating onboarding for ${repoName}: ${message}`
        );
      }
    }
  }

  /**
   * Split documents into batches of the given size.
   */
  private createBatches(
    docs: RawDocument[],
    batchSize: number
  ): RawDocument[][] {
    const batches: RawDocument[][] = [];
    for (let i = 0; i < docs.length; i += batchSize) {
      batches.push(docs.slice(i, i + batchSize));
    }
    return batches;
  }
}

/**
 * Normalize a page path to ensure consistency.
 */
function normalizePath(path: string): string {
  let normalized = path.trim();

  // Remove leading slashes
  normalized = normalized.replace(/^\/+/, "");

  // Ensure .md extension
  if (!normalized.endsWith(".md")) {
    normalized += ".md";
  }

  // Replace spaces with hyphens and lowercase
  normalized = normalized
    .split("/")
    .map((segment) =>
      segment === segment.toUpperCase() && segment.includes(".")
        ? segment // preserve filenames like README.md
        : segment
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9._-]/g, "")
    )
    .join("/");

  return normalized;
}
