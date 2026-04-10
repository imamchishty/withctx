import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { exportJsonChunks, exportLangChainDocuments, exportLlamaIndexNodes } from "../../export/rag.js";

interface ExportOptions {
  format?: "claude-md" | "system-prompt" | "markdown" | "json" | "langchain" | "llamaindex" | "rag-json";
  scope?: string;
  budget?: string;
  snapshot?: boolean;
  chunkSize?: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function registerExportCommand(program: Command): void {
  program
    .command("export")
    .description("Export wiki to .ctx/exports/ in various formats")
    .option("--format <fmt>", "Output format: claude-md, system-prompt, markdown, json, langchain, llamaindex, rag-json", "claude-md")
    .option("--scope <dir>", "Limit to a specific wiki subdirectory")
    .option("--budget <tokens>", "Token budget limit")
    .option("--snapshot", "Create a timestamped snapshot archive")
    .option("--chunk-size <words>", "Chunk size in words for RAG formats (default: 512)")
    .action(async (options: ExportOptions) => {
      const spinner = ora("Exporting wiki...").start();

      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx setup' first."));
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);
        const allPagePaths = pageManager.list(options.scope);

        if (allPagePaths.length === 0) {
          spinner.fail(chalk.red("No wiki pages found."));
          process.exit(1);
        }

        // Load pages
        const pages: Array<{ path: string; title: string; content: string; updatedAt: string }> = [];
        for (const pagePath of allPagePaths) {
          if (pagePath === "log.md") continue;
          const page = pageManager.read(pagePath);
          if (page) {
            pages.push({
              path: pagePath,
              title: page.title,
              content: page.content,
              updatedAt: page.updatedAt,
            });
          }
        }

        // Apply budget
        const budget = options.budget ? parseInt(options.budget, 10) : undefined;
        let includedPages = pages;
        if (budget) {
          const budgeted: typeof pages = [];
          let tokens = 0;
          for (const page of pages) {
            const pt = estimateTokens(page.content);
            if (tokens + pt > budget) break;
            budgeted.push(page);
            tokens += pt;
          }
          includedPages = budgeted;
        }

        // Generate content based on format
        const format = options.format ?? "claude-md";
        let content: string;
        let extension: string;

        const chunkSize = options.chunkSize ? parseInt(options.chunkSize, 10) : undefined;
        const wikiPages = includedPages.map((p) => ({
          path: p.path,
          title: p.title,
          content: p.content,
          updatedAt: p.updatedAt,
          createdAt: p.updatedAt,
          sources: [] as string[],
          references: [] as string[],
        }));

        switch (format) {
          case "rag-json": {
            content = exportJsonChunks(wikiPages, config.project, chunkSize);
            extension = "json";
            break;
          }
          case "langchain": {
            content = exportLangChainDocuments(wikiPages, config.project, chunkSize);
            extension = "json";
            break;
          }
          case "llamaindex": {
            content = exportLlamaIndexNodes(wikiPages, config.project, chunkSize);
            extension = "json";
            break;
          }
          case "json": {
            content = JSON.stringify(
              {
                project: config.project,
                exportedAt: new Date().toISOString(),
                pageCount: includedPages.length,
                pages: includedPages.map((p) => ({
                  path: p.path,
                  title: p.title,
                  content: p.content,
                  updatedAt: p.updatedAt,
                })),
              },
              null,
              2
            );
            extension = "json";
            break;
          }
          case "system-prompt": {
            content = `You have access to the following project context for "${config.project}":\n\n`;
            for (const page of includedPages) {
              content += `<context file="${page.path}">\n${page.content}\n</context>\n\n`;
            }
            content += `Use this context to answer questions accurately.\n`;
            extension = "txt";
            break;
          }
          case "markdown": {
            content = `# ${config.project} — Context Export\n\n`;
            content += `_Exported: ${new Date().toISOString()} | ${includedPages.length} pages_\n\n---\n\n`;
            for (const page of includedPages) {
              content += `${page.content}\n\n---\n\n`;
            }
            extension = "md";
            break;
          }
          case "claude-md":
          default: {
            content = `# CLAUDE.md — ${config.project}\n\n`;
            content += `_Auto-generated by withctx. ${includedPages.length} pages compiled._\n\n---\n\n`;
            for (const page of includedPages) {
              content += `${page.content}\n\n---\n\n`;
            }
            extension = "md";
            break;
          }
        }

        // Determine output path
        let outputPath: string;
        if (options.snapshot) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const snapshotDir = join(ctxDir.exportsPath, "snapshots");
          mkdirSync(snapshotDir, { recursive: true });
          outputPath = join(snapshotDir, `export-${timestamp}.${extension}`);
        } else {
          outputPath = join(ctxDir.exportsPath, `context.${extension}`);
        }

        writeFileSync(outputPath, content);

        const tokenCount = estimateTokens(content);

        spinner.succeed(chalk.green("Export complete"));

        console.log();
        console.log(chalk.bold("  Export details:"));
        console.log(`    Format:    ${chalk.cyan(format)}`);
        console.log(`    Pages:     ${chalk.cyan(String(includedPages.length))}`);
        console.log(`    Tokens:    ${chalk.cyan(`~${tokenCount}`)}`);
        console.log(`    Output:    ${chalk.dim(outputPath)}`);
        if (options.snapshot) {
          console.log(`    Snapshot:  ${chalk.green("yes")}`);
        }
        console.log();
      } catch (error) {
        spinner.fail(chalk.red("Export failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
