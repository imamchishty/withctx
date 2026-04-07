import { readFile, stat, readdir } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import type { SourceConnector } from "./types.js";
import type { RawDocument, FetchOptions, SourceStatus } from "../types/source.js";
import type { CoverageSource } from "../types/config.js";

interface FileCoverage {
  file: string;
  lines: { covered: number; total: number };
  branches: { covered: number; total: number };
  functions: { covered: number; total: number };
}

interface DirectoryCoverage {
  directory: string;
  files: FileCoverage[];
  lines: { covered: number; total: number };
  branches: { covered: number; total: number };
  functions: { covered: number; total: number };
}

/**
 * Connector for test coverage reports.
 * Reads coverage data from lcov, istanbul JSON, cobertura, or clover formats
 * and produces structured documents for the wiki.
 */
export class CoverageConnector implements SourceConnector {
  readonly type = "coverage" as const;
  readonly name: string;
  private path: string;
  private format: string;
  private status: SourceStatus;

  constructor(config: CoverageSource) {
    this.name = config.name;
    this.path = config.path;
    this.format = config.format || "lcov";
    this.status = {
      name: config.name,
      type: "coverage",
      status: "disconnected",
    };
  }

  async validate(): Promise<boolean> {
    try {
      const fileStat = await stat(this.path);
      if (!fileStat.isFile() && !fileStat.isDirectory()) {
        this.status.status = "error";
        this.status.error = `Path "${this.path}" is neither a file nor directory.`;
        return false;
      }
      this.status.status = "connected";
      return true;
    } catch (error) {
      this.status.status = "error";
      this.status.error = `Cannot access coverage path "${this.path}": ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  async *fetch(options?: FetchOptions): AsyncGenerator<RawDocument> {
    this.status.status = "syncing";
    let count = 0;

    try {
      // Check incremental: skip if file hasn't changed
      if (options?.since) {
        try {
          const fileStat = await stat(this.path);
          if (fileStat.mtime < options.since) {
            this.status.status = "connected";
            return;
          }
        } catch {
          // If we can't stat, proceed anyway
        }
      }

      const coverageFiles = await this.parseCoverage();
      if (coverageFiles.length === 0) {
        this.status.status = "connected";
        this.status.itemCount = 0;
        return;
      }

      // Group by directory
      const directories = this.groupByDirectory(coverageFiles);

      // Yield summary document
      const summary = this.buildSummaryDocument(coverageFiles, directories);
      count++;
      yield summary;
      if (options?.limit && count >= options.limit) {
        this.status.status = "connected";
        this.status.lastSyncAt = new Date().toISOString();
        this.status.itemCount = count;
        return;
      }

      // Yield per-directory documents
      for (const dir of directories) {
        const doc = this.buildDirectoryDocument(dir);
        count++;
        yield doc;
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

  private async parseCoverage(): Promise<FileCoverage[]> {
    switch (this.format) {
      case "lcov":
        return this.parseLcov();
      case "istanbul-json":
        return this.parseIstanbulJson();
      case "cobertura":
        return this.parseCobertura();
      default:
        throw new Error(`Unsupported coverage format: "${this.format}"`);
    }
  }

  private async parseLcov(): Promise<FileCoverage[]> {
    const content = await this.readCoverageFile();
    const files: FileCoverage[] = [];
    let current: FileCoverage | null = null;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();

      if (trimmed.startsWith("SF:")) {
        current = {
          file: trimmed.substring(3),
          lines: { covered: 0, total: 0 },
          branches: { covered: 0, total: 0 },
          functions: { covered: 0, total: 0 },
        };
      } else if (trimmed === "end_of_record" && current) {
        files.push(current);
        current = null;
      } else if (current) {
        if (trimmed.startsWith("LF:")) {
          current.lines.total = parseInt(trimmed.substring(3), 10);
        } else if (trimmed.startsWith("LH:")) {
          current.lines.covered = parseInt(trimmed.substring(3), 10);
        } else if (trimmed.startsWith("BRF:")) {
          current.branches.total = parseInt(trimmed.substring(4), 10);
        } else if (trimmed.startsWith("BRH:")) {
          current.branches.covered = parseInt(trimmed.substring(4), 10);
        } else if (trimmed.startsWith("FNF:")) {
          current.functions.total = parseInt(trimmed.substring(4), 10);
        } else if (trimmed.startsWith("FNH:")) {
          current.functions.covered = parseInt(trimmed.substring(4), 10);
        }
      }
    }

    return files;
  }

  private async parseIstanbulJson(): Promise<FileCoverage[]> {
    const content = await this.readCoverageFile();
    const data = JSON.parse(content) as Record<
      string,
      {
        total?: {
          lines?: { total: number; covered: number };
          branches?: { total: number; covered: number };
          functions?: { total: number; covered: number };
        };
        lines?: { total: number; covered: number };
        branches?: { total: number; covered: number };
        functions?: { total: number; covered: number };
      }
    >;

    const files: FileCoverage[] = [];

    for (const [filePath, metrics] of Object.entries(data)) {
      // Skip the "total" key in coverage-summary.json
      if (filePath === "total") continue;

      // Istanbul JSON can be either coverage-summary.json or coverage-final.json format
      const fileMetrics = metrics.total || metrics;
      files.push({
        file: filePath,
        lines: {
          covered: fileMetrics.lines?.covered ?? 0,
          total: fileMetrics.lines?.total ?? 0,
        },
        branches: {
          covered: fileMetrics.branches?.covered ?? 0,
          total: fileMetrics.branches?.total ?? 0,
        },
        functions: {
          covered: fileMetrics.functions?.covered ?? 0,
          total: fileMetrics.functions?.total ?? 0,
        },
      });
    }

    return files;
  }

  private async parseCobertura(): Promise<FileCoverage[]> {
    const content = await this.readCoverageFile();
    const files: FileCoverage[] = [];

    // Simple XML parsing for Cobertura format — extract <class> elements
    const classRegex = /<class\s[^>]*?filename="([^"]*)"[^>]*?line-rate="([^"]*)"[^>]*?branch-rate="([^"]*)"[^>]*?>/g;
    let match: RegExpExecArray | null;

    while ((match = classRegex.exec(content)) !== null) {
      const [, filename, lineRateStr, branchRateStr] = match;
      if (!filename) continue;

      const lineRate = parseFloat(lineRateStr || "0");
      const branchRate = parseFloat(branchRateStr || "0");

      // Extract line details for this class
      const classEnd = content.indexOf("</class>", match.index);
      const classContent = content.substring(match.index, classEnd > -1 ? classEnd : undefined);

      // Count lines
      const lineMatches = classContent.match(/<line\s/g);
      const lineTotal = lineMatches?.length ?? 0;
      const lineCovered = Math.round(lineTotal * lineRate);

      // Count branches from conditions
      const conditionMatches = classContent.match(/condition-coverage="[^"]*"/g);
      let branchTotal = 0;
      let branchCovered = 0;
      if (conditionMatches) {
        for (const cond of conditionMatches) {
          const condMatch = cond.match(/\((\d+)\/(\d+)\)/);
          if (condMatch) {
            branchCovered += parseInt(condMatch[1]!, 10);
            branchTotal += parseInt(condMatch[2]!, 10);
          }
        }
      } else {
        // Estimate from branch-rate
        branchTotal = lineTotal > 0 ? lineTotal : 0;
        branchCovered = Math.round(branchTotal * branchRate);
      }

      // Count methods
      const methodMatches = classContent.match(/<method\s/g);
      const funcTotal = methodMatches?.length ?? 0;
      // Estimate covered functions from line rate
      const funcCovered = Math.round(funcTotal * lineRate);

      files.push({
        file: filename,
        lines: { covered: lineCovered, total: lineTotal },
        branches: { covered: branchCovered, total: branchTotal },
        functions: { covered: funcCovered, total: funcTotal },
      });
    }

    return files;
  }

  private async readCoverageFile(): Promise<string> {
    try {
      const fileStat = await stat(this.path);
      if (fileStat.isDirectory()) {
        // Try common coverage file names
        const candidates = [
          "lcov.info",
          "coverage-summary.json",
          "coverage-final.json",
          "coverage.xml",
          "cobertura-coverage.xml",
          "clover.xml",
        ];
        for (const candidate of candidates) {
          try {
            return await readFile(join(this.path, candidate), "utf-8");
          } catch {
            continue;
          }
        }
        // Try to find any matching file in the directory
        const dirFiles = await readdir(this.path);
        for (const f of dirFiles) {
          if (
            f.endsWith(".info") ||
            f.endsWith(".json") ||
            f.endsWith(".xml")
          ) {
            return await readFile(join(this.path, f), "utf-8");
          }
        }
        throw new Error(`No coverage file found in directory "${this.path}".`);
      }
      return await readFile(this.path, "utf-8");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("No coverage file")) {
        throw error;
      }
      throw new Error(`Failed to read coverage file at "${this.path}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private groupByDirectory(files: FileCoverage[]): DirectoryCoverage[] {
    const dirMap = new Map<string, FileCoverage[]>();

    for (const file of files) {
      const dir = dirname(file.file);
      const existing = dirMap.get(dir) || [];
      existing.push(file);
      dirMap.set(dir, existing);
    }

    return [...dirMap.entries()].map(([directory, dirFiles]) => ({
      directory,
      files: dirFiles,
      lines: this.aggregateMetric(dirFiles, "lines"),
      branches: this.aggregateMetric(dirFiles, "branches"),
      functions: this.aggregateMetric(dirFiles, "functions"),
    }));
  }

  private aggregateMetric(
    files: FileCoverage[],
    metric: "lines" | "branches" | "functions"
  ): { covered: number; total: number } {
    let covered = 0;
    let total = 0;
    for (const file of files) {
      covered += file[metric].covered;
      total += file[metric].total;
    }
    return { covered, total };
  }

  private pct(covered: number, total: number): string {
    if (total === 0) return "N/A";
    return ((covered / total) * 100).toFixed(1) + "%";
  }

  private buildSummaryDocument(
    files: FileCoverage[],
    directories: DirectoryCoverage[]
  ): RawDocument {
    const totalLines = this.aggregateMetric(files, "lines");
    const totalBranches = this.aggregateMetric(files, "branches");
    const totalFunctions = this.aggregateMetric(files, "functions");

    let content = `# Test Coverage Report\n\n`;
    content += `**Format:** ${this.format}\n`;
    content += `**Files analyzed:** ${files.length}\n`;
    content += `**Generated:** ${new Date().toISOString()}\n\n`;

    content += `## Overall Coverage\n\n`;
    content += `| Metric | Covered | Total | Percentage |\n|--------|---------|-------|------------|\n`;
    content += `| Lines | ${totalLines.covered} | ${totalLines.total} | ${this.pct(totalLines.covered, totalLines.total)} |\n`;
    content += `| Branches | ${totalBranches.covered} | ${totalBranches.total} | ${this.pct(totalBranches.covered, totalBranches.total)} |\n`;
    content += `| Functions | ${totalFunctions.covered} | ${totalFunctions.total} | ${this.pct(totalFunctions.covered, totalFunctions.total)} |\n\n`;

    content += `## Per-Directory Breakdown\n\n`;
    content += `| Directory | Lines | Branches | Functions |\n|-----------|-------|----------|-----------|\n`;
    const sortedDirs = [...directories].sort(
      (a, b) =>
        (a.lines.total > 0 ? a.lines.covered / a.lines.total : 0) -
        (b.lines.total > 0 ? b.lines.covered / b.lines.total : 0)
    );
    for (const dir of sortedDirs) {
      content += `| ${dir.directory} | ${this.pct(dir.lines.covered, dir.lines.total)} | ${this.pct(dir.branches.covered, dir.branches.total)} | ${this.pct(dir.functions.covered, dir.functions.total)} |\n`;
    }
    content += "\n";

    // Bottom 10 files by line coverage
    const sortedFiles = [...files].sort((a, b) => {
      const aPct = a.lines.total > 0 ? a.lines.covered / a.lines.total : 0;
      const bPct = b.lines.total > 0 ? b.lines.covered / b.lines.total : 0;
      return aPct - bPct;
    });

    content += `## Lowest Coverage (Bottom 10)\n\n`;
    content += `| File | Lines | Branches | Functions |\n|------|-------|----------|-----------|\n`;
    for (const file of sortedFiles.slice(0, 10)) {
      content += `| ${file.file} | ${this.pct(file.lines.covered, file.lines.total)} | ${this.pct(file.branches.covered, file.branches.total)} | ${this.pct(file.functions.covered, file.functions.total)} |\n`;
    }
    content += "\n";

    content += `## Highest Coverage (Top 10)\n\n`;
    content += `| File | Lines | Branches | Functions |\n|------|-------|----------|-----------|\n`;
    const topFiles = [...sortedFiles].reverse().slice(0, 10);
    for (const file of topFiles) {
      content += `| ${file.file} | ${this.pct(file.lines.covered, file.lines.total)} | ${this.pct(file.branches.covered, file.branches.total)} | ${this.pct(file.functions.covered, file.functions.total)} |\n`;
    }
    content += "\n";

    const overallLineCoverage = totalLines.total > 0
      ? (totalLines.covered / totalLines.total) * 100
      : 0;
    const overallBranchCoverage = totalBranches.total > 0
      ? (totalBranches.covered / totalBranches.total) * 100
      : 0;

    return {
      id: `coverage:${this.name}:summary`,
      sourceType: "coverage",
      sourceName: this.name,
      title: "Test Coverage Report",
      content,
      contentType: "text",
      metadata: {
        format: this.format,
        overallLineCoverage: parseFloat(overallLineCoverage.toFixed(1)),
        overallBranchCoverage: parseFloat(overallBranchCoverage.toFixed(1)),
        timestamp: new Date().toISOString(),
        totalFiles: files.length,
      },
    };
  }

  private buildDirectoryDocument(dir: DirectoryCoverage): RawDocument {
    let content = `# Coverage: ${dir.directory}\n\n`;
    content += `## Summary\n\n`;
    content += `| Metric | Covered | Total | Percentage |\n|--------|---------|-------|------------|\n`;
    content += `| Lines | ${dir.lines.covered} | ${dir.lines.total} | ${this.pct(dir.lines.covered, dir.lines.total)} |\n`;
    content += `| Branches | ${dir.branches.covered} | ${dir.branches.total} | ${this.pct(dir.branches.covered, dir.branches.total)} |\n`;
    content += `| Functions | ${dir.functions.covered} | ${dir.functions.total} | ${this.pct(dir.functions.covered, dir.functions.total)} |\n\n`;

    content += `## Files\n\n`;
    content += `| File | Lines | Branches | Functions |\n|------|-------|----------|-----------|\n`;
    const sortedFiles = [...dir.files].sort((a, b) => {
      const aPct = a.lines.total > 0 ? a.lines.covered / a.lines.total : 0;
      const bPct = b.lines.total > 0 ? b.lines.covered / b.lines.total : 0;
      return aPct - bPct;
    });
    for (const file of sortedFiles) {
      const fileName = file.file.split(sep).pop() || file.file;
      content += `| ${fileName} | ${this.pct(file.lines.covered, file.lines.total)} | ${this.pct(file.branches.covered, file.branches.total)} | ${this.pct(file.functions.covered, file.functions.total)} |\n`;
    }
    content += "\n";

    return {
      id: `coverage:${this.name}:dir:${dir.directory}`,
      sourceType: "coverage",
      sourceName: this.name,
      title: `Coverage: ${dir.directory}`,
      content,
      contentType: "text",
      metadata: {
        format: this.format,
        directory: dir.directory,
        lineCoverage: dir.lines.total > 0
          ? parseFloat(((dir.lines.covered / dir.lines.total) * 100).toFixed(1))
          : 0,
        fileCount: dir.files.length,
      },
    };
  }
}
