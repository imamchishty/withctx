import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { ClaudeClient } from "../../claude/client.js";
import { ConnectorRegistry } from "../../connectors/registry.js";
import { LocalFilesConnector } from "../../connectors/local-files.js";
import type { RawDocument } from "../../types/source.js";

interface IngestOptions {
  maxTokens?: string;
  dryRun?: boolean;
}

function buildConnectors(config: ReturnType<typeof loadConfig>, projectRoot: string): ConnectorRegistry {
  const registry = new ConnectorRegistry();

  // Register local sources
  if (config.sources?.local) {
    for (const source of config.sources.local) {
      const resolvedPath = source.path.startsWith(".")
        ? `${projectRoot}/${source.path}`
        : source.path;
      registry.register(new LocalFilesConnector(source.name, resolvedPath));
    }
  }

  // Other connector types (jira, confluence, github, teams) would be
  // registered here once their connector implementations exist.

  return registry;
}

function buildCompilePrompt(documents: RawDocument[], existingPages: string[]): string {
  let prompt = `You are a context wiki compiler. Your job is to analyze source documents and compile them into well-organized wiki pages.

## Instructions
1. Analyze all the source documents provided below.
2. Compile them into a set of wiki pages organized by topic.
3. Each wiki page should have a clear title (# heading), organized content, and source attribution.
4. Create cross-references between pages using markdown links.
5. At the end, produce an updated index.md listing all pages.

## Output Format
For each wiki page, output:

---PAGE: <filename.md>---
<page content in markdown>
---END PAGE---

After all pages, output:

---PAGE: index.md---
<updated index content>
---END PAGE---

`;

  if (existingPages.length > 0) {
    prompt += `## Existing Pages (preserve and update these)\n${existingPages.join(", ")}\n\n`;
  }

  prompt += `## Source Documents\n\n`;

  for (const doc of documents) {
    prompt += `### Source: ${doc.sourceName} / ${doc.title}\n`;
    prompt += `Type: ${doc.contentType} | Updated: ${doc.updatedAt ?? "unknown"}\n\n`;
    // Truncate very large documents
    const content = doc.content.length > 8000 ? doc.content.slice(0, 8000) + "\n...[truncated]" : doc.content;
    prompt += `${content}\n\n`;
  }

  return prompt;
}

function parseCompiledPages(response: string): Array<{ path: string; content: string }> {
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

function trackCostEntry(
  ctxDir: CtxDirectory,
  operation: string,
  tokensUsed: number
): void {
  const costs = ctxDir.readCosts() ?? {
    totalTokens: 0,
    totalCostUsd: 0,
    operations: [],
  };

  const estimatedCost = (tokensUsed / 1_000_000) * 3; // rough estimate
  (costs as Record<string, unknown>)["totalTokens"] =
    ((costs as Record<string, unknown>)["totalTokens"] as number ?? 0) + tokensUsed;
  (costs as Record<string, unknown>)["totalCostUsd"] =
    ((costs as Record<string, unknown>)["totalCostUsd"] as number ?? 0) + estimatedCost;

  const operations = ((costs as Record<string, unknown>)["operations"] as Array<Record<string, unknown>>) ?? [];
  operations.push({
    operation,
    timestamp: new Date().toISOString(),
    tokensUsed,
    costUsd: estimatedCost,
  });
  (costs as Record<string, unknown>)["operations"] = operations;

  ctxDir.writeCosts(costs);
}

export function registerIngestCommand(program: Command): void {
  program
    .command("ingest")
    .description("Fetch all sources and compile into wiki pages using Claude")
    .option("--max-tokens <n>", "Max tokens for Claude response")
    .option("--dry-run", "Show what would be ingested without calling Claude")
    .action(async (options: IngestOptions) => {
      const spinner = ora("Loading configuration...").start();

      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        // Build connectors from config
        const registry = buildConnectors(config, projectRoot);
        const connectors = registry.getAll();

        if (connectors.length === 0) {
          spinner.fail(chalk.red("No sources configured. Add sources to ctx.yaml."));
          process.exit(1);
        }

        // Validate connectors
        spinner.text = "Validating source connections...";
        for (const connector of connectors) {
          const valid = await connector.validate();
          if (!valid) {
            const status = connector.getStatus();
            spinner.warn(
              chalk.yellow(`Source '${connector.name}' failed validation: ${status.error}`)
            );
          }
        }

        // Fetch all documents
        spinner.text = "Fetching documents from all sources...";
        const allDocuments: RawDocument[] = [];

        for (const connector of connectors) {
          const status = connector.getStatus();
          if (status.status === "error") continue;

          spinner.text = `Fetching from ${chalk.cyan(connector.name)}...`;
          try {
            for await (const doc of connector.fetch()) {
              allDocuments.push(doc);
              spinner.text = `Fetching from ${chalk.cyan(connector.name)}... (${allDocuments.length} docs)`;
            }
          } catch (error) {
            spinner.warn(
              chalk.yellow(
                `Error fetching from ${connector.name}: ${error instanceof Error ? error.message : String(error)}`
              )
            );
          }
        }

        if (allDocuments.length === 0) {
          spinner.fail(chalk.red("No documents found across any sources."));
          process.exit(1);
        }

        spinner.succeed(`Fetched ${chalk.bold(String(allDocuments.length))} documents from ${connectors.length} source(s)`);

        if (options.dryRun) {
          console.log();
          console.log(chalk.bold("Dry run — documents that would be ingested:"));
          for (const doc of allDocuments) {
            console.log(
              `  ${chalk.cyan(doc.sourceName)} / ${doc.title} (${doc.contentType}, ${doc.content.length} chars)`
            );
          }
          return;
        }

        // Check Claude availability
        const claude = new ClaudeClient(config.costs?.model ?? "claude-sonnet-4");
        const available = await claude.isAvailable();
        if (!available) {
          spinner.fail(
            chalk.red("Claude CLI not found. Install it: https://docs.anthropic.com/claude-code")
          );
          process.exit(1);
        }

        // Get existing pages for context
        const pageManager = new PageManager(ctxDir);
        const existingPages = pageManager.list().filter(
          (p) => p !== "index.md" && p !== "log.md"
        );

        // Compile with Claude
        const compileSpinner = ora("Compiling wiki pages with Claude...").start();
        const prompt = buildCompilePrompt(allDocuments, existingPages);

        const claudeOptions: { maxTokens?: number; systemPrompt: string } = {
          systemPrompt:
            "You are a technical documentation compiler. Compile source documents into a well-structured wiki. Output pages in the exact format requested.",
        };
        if (options.maxTokens) {
          claudeOptions.maxTokens = parseInt(options.maxTokens, 10);
        }

        const response = await claude.prompt(prompt, claudeOptions);

        // Parse the compiled pages
        const compiledPages = parseCompiledPages(response.content);

        if (compiledPages.length === 0) {
          // If Claude didn't use the page format, save the whole response as a single page
          pageManager.write("compiled-context.md", response.content);
          compileSpinner.succeed("Compiled context saved as compiled-context.md");
        } else {
          // Write each compiled page
          for (const page of compiledPages) {
            pageManager.write(page.path, page.content);
          }
          compileSpinner.succeed(
            `Compiled ${chalk.bold(String(compiledPages.length))} wiki pages`
          );
        }

        // Update log
        const logContent = ctxDir.readPage("log.md") ?? "";
        const logEntry = `| ${new Date().toISOString()} | ingest | Ingested ${allDocuments.length} docs, compiled ${compiledPages.length} pages |`;
        ctxDir.writePage(
          "log.md",
          logContent + "\n" + logEntry
        );

        // Track costs
        if (response.tokensUsed) {
          const total = response.tokensUsed.input + response.tokensUsed.output;
          trackCostEntry(ctxDir, "ingest", total);
        }

        // Summary
        console.log();
        console.log(chalk.bold("  Ingest complete:"));
        console.log(`    Sources processed: ${chalk.cyan(String(connectors.length))}`);
        console.log(`    Documents fetched: ${chalk.cyan(String(allDocuments.length))}`);
        console.log(`    Wiki pages created: ${chalk.cyan(String(compiledPages.length))}`);
        if (response.tokensUsed) {
          const total = response.tokensUsed.input + response.tokensUsed.output;
          console.log(`    Tokens used: ${chalk.dim(total.toLocaleString())}`);
        }
        console.log();
      } catch (error) {
        spinner.fail(chalk.red("Ingest failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
