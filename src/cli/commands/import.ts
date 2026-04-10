import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { readFileSync, existsSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { ClaudeClient } from "../../claude/client.js";

interface ImportOptions {
  as?: string;
  maxTokens?: string;
}

function buildImportPrompt(content: string, filename: string, asPage?: string): string {
  if (asPage) {
    return `You are a context wiki compiler. Import the following document as a wiki page named "${asPage}".

## Instructions
1. Read the document below.
2. Clean it up and format it as a well-structured wiki page.
3. Add cross-references if you can infer related topics.
4. Preserve all important information.

## Output Format
---PAGE: ${asPage}---
<page content in markdown>
---END PAGE---

## Source Document: ${filename}

${content}
`;
  }

  return `You are a context wiki compiler. Your job is to analyze the following document and split it into well-organized wiki pages.

## Instructions
1. Read the document below.
2. Split it into logical wiki pages by topic (e.g., overview, architecture, conventions, api, setup, etc.)
3. Each wiki page should have a clear title (# heading), organized content, and source attribution.
4. Create cross-references between pages using markdown links.
5. At the end, produce an updated index.md listing all generated pages.

## Output Format
For each wiki page, output:

---PAGE: <filename.md>---
<page content in markdown>
---END PAGE---

After all pages, output:

---PAGE: index.md---
<updated index content>
---END PAGE---

## Source Document: ${filename}

${content}
`;
}

function parseImportedPages(response: string): Array<{ path: string; content: string }> {
  const pages: Array<{ path: string; content: string }> = [];
  const pagePattern = /---PAGE:\s*(.+?)---\n([\s\S]*?)---END PAGE---/g;
  let match;

  while ((match = pagePattern.exec(response)) !== null) {
    const path = match[1].trim();
    const content = match[2].trim();
    pages.push({ path, content });
  }

  return pages;
}

export function registerImportCommand(program: Command): void {
  program
    .command("import <file>")
    .description("Import a markdown file and split it into wiki pages using Claude")
    .option("--as <name>", "Import as a specific page name (e.g., architecture.md)")
    .option("--max-tokens <n>", "Max tokens for Claude response")
    .action(async (file: string, options: ImportOptions) => {
      const spinner = ora("Reading file...").start();

      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        // Resolve file path
        const filePath = resolve(file);
        if (!existsSync(filePath)) {
          spinner.fail(chalk.red(`File not found: ${filePath}`));
          process.exit(1);
        }

        const ext = extname(filePath).toLowerCase();
        if (ext !== ".md" && ext !== ".txt" && ext !== ".rst" && ext !== ".adoc") {
          spinner.fail(chalk.red(`Unsupported file type: ${ext}. Supported: .md, .txt, .rst, .adoc`));
          process.exit(1);
        }

        const content = readFileSync(filePath, "utf-8");
        const filename = basename(filePath);

        spinner.succeed(`Read ${chalk.cyan(filename)} (${content.length} chars)`);

        // Ensure --as has .md extension
        let asPage = options.as;
        if (asPage && !asPage.endsWith(".md")) {
          asPage = `${asPage}.md`;
        }

        // Check Claude availability
        const claude = new ClaudeClient(config.costs?.model ?? "claude-sonnet-4", { baseURL: config.ai?.base_url });
        const compileSpinner = ora(
          asPage
            ? `Importing as ${chalk.cyan(asPage)} with Claude...`
            : "Splitting into wiki pages with Claude..."
        ).start();

        const available = await claude.isAvailable();
        if (!available) {
          compileSpinner.fail(
            chalk.red("Claude API not available. Check your ANTHROPIC_API_KEY.")
          );
          process.exit(1);
        }

        const prompt = buildImportPrompt(content, filename, asPage);

        const claudeOptions: { maxTokens?: number; systemPrompt: string } = {
          systemPrompt:
            "You are a technical documentation compiler. Import and organize documents into a well-structured wiki. Output pages in the exact format requested.",
        };
        if (options.maxTokens) {
          claudeOptions.maxTokens = parseInt(options.maxTokens, 10);
        }

        const response = await claude.prompt(prompt, claudeOptions);

        // Parse pages
        const pages = parseImportedPages(response.content);
        const pageManager = new PageManager(ctxDir);

        if (pages.length === 0) {
          // Fall back to saving the whole response as a single page
          const fallbackName = asPage ?? `imported-${basename(filePath, ext)}.md`;
          pageManager.write(fallbackName, response.content);
          compileSpinner.succeed(`Imported as ${chalk.cyan(fallbackName)}`);
        } else {
          // Write each page
          for (const page of pages) {
            pageManager.write(page.path, page.content);
          }
          compileSpinner.succeed(
            `Created ${chalk.bold(String(pages.length))} wiki page(s) from ${chalk.cyan(filename)}`
          );
        }

        // Update log
        const logContent = ctxDir.readPage("log.md") ?? "";
        const pageNames = pages.length > 0
          ? pages.map((p) => p.path).join(", ")
          : asPage ?? `imported-${basename(filePath, ext)}.md`;
        const logEntry = `| ${new Date().toISOString()} | import | Imported ${filename} into ${pages.length || 1} page(s): ${pageNames} |`;
        ctxDir.writePage("log.md", logContent + "\n" + logEntry);

        // Summary
        console.log();
        console.log(chalk.bold("  Import complete:"));
        console.log(`    Source file: ${chalk.cyan(filename)}`);
        console.log(`    Pages created: ${chalk.cyan(String(pages.length || 1))}`);
        if (pages.length > 0) {
          for (const page of pages) {
            console.log(`      ${chalk.dim(page.path)}`);
          }
        }
        if (response.tokensUsed) {
          const total = response.tokensUsed.input + response.tokensUsed.output;
          console.log(`    Tokens used: ${chalk.dim(total.toLocaleString())}`);
        }
        console.log();
      } catch (error) {
        spinner.fail(chalk.red("Import failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
