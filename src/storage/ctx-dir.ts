import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const CTX_DIR = ".ctx";
const CONTEXT_DIR = "context";
const SOURCES_DIR = "sources";
const EXPORTS_DIR = "exports";

/**
 * Manages the .ctx/ directory structure.
 */
export class CtxDirectory {
  private root: string;

  constructor(projectRoot: string) {
    this.root = join(projectRoot, CTX_DIR);
  }

  get path(): string {
    return this.root;
  }

  get contextPath(): string {
    return join(this.root, CONTEXT_DIR);
  }

  get sourcesPath(): string {
    return join(this.root, SOURCES_DIR);
  }

  get exportsPath(): string {
    return join(this.root, EXPORTS_DIR);
  }

  /**
   * Check if .ctx/ directory exists.
   */
  exists(): boolean {
    return existsSync(this.root);
  }

  /**
   * Initialize the .ctx/ directory structure.
   */
  initialize(): void {
    const dirs = [
      this.root,
      this.contextPath,
      join(this.contextPath, "repos"),
      join(this.contextPath, "cross-repo"),
      join(this.contextPath, "services"),
      join(this.contextPath, "people"),
      join(this.contextPath, "onboarding"),
      join(this.contextPath, "onboarding", "by-repo"),
      join(this.contextPath, "manual"),
      this.sourcesPath,
      this.exportsPath,
      join(this.exportsPath, "snapshots"),
    ];

    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }

    // Create index.md if it doesn't exist
    const indexPath = join(this.contextPath, "index.md");
    if (!existsSync(indexPath)) {
      writeFileSync(
        indexPath,
        "# Wiki Index\n\n_No pages compiled yet. Run `ctx ingest` to get started._\n"
      );
    }

    // Create log.md if it doesn't exist
    const logPath = join(this.contextPath, "log.md");
    if (!existsSync(logPath)) {
      writeFileSync(
        logPath,
        `# Context Log\n\n| Timestamp | Action | Detail |\n|-----------|--------|--------|\n| ${new Date().toISOString()} | init | Project initialized |\n`
      );
    }
  }

  /**
   * Read a wiki page by its relative path (e.g., "architecture.md").
   */
  readPage(relativePath: string): string | null {
    const fullPath = join(this.contextPath, relativePath);
    if (!existsSync(fullPath)) return null;
    return readFileSync(fullPath, "utf-8");
  }

  /**
   * Write a wiki page.
   */
  writePage(relativePath: string, content: string): void {
    const fullPath = join(this.contextPath, relativePath);
    const dir = join(fullPath, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }

  /**
   * List all wiki pages (relative paths).
   */
  listPages(subdir?: string): string[] {
    const searchDir = subdir
      ? join(this.contextPath, subdir)
      : this.contextPath;

    if (!existsSync(searchDir)) return [];

    const pages: string[] = [];
    const walk = (dir: string) => {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (entry.endsWith(".md")) {
          pages.push(relative(this.contextPath, fullPath));
        }
      }
    };

    walk(searchDir);
    return pages.sort();
  }

  /**
   * Read the costs.json file.
   */
  readCosts(): Record<string, unknown> | null {
    const costsPath = join(this.root, "costs.json");
    if (!existsSync(costsPath)) return null;
    return JSON.parse(readFileSync(costsPath, "utf-8"));
  }

  /**
   * Write to costs.json.
   */
  writeCosts(data: Record<string, unknown>): void {
    const costsPath = join(this.root, "costs.json");
    writeFileSync(costsPath, JSON.stringify(data, null, 2));
  }
}
