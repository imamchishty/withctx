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

/** Model pricing per million tokens (input/output) */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-haiku-3.5": { input: 0.8, output: 4 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateCost(tokens: number, model: string): { input: number; output: number; total: number } {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4"];
  const inputCost = (tokens / 1_000_000) * pricing.input;
  // Estimate output at ~30% of input tokens
  const estimatedOutputTokens = Math.ceil(tokens * 0.3);
  const outputCost = (estimatedOutputTokens / 1_000_000) * pricing.output;
  return { input: inputCost, output: outputCost, total: inputCost + outputCost };
}

function getConnectorErrorHelp(connectorType: string, error: string): string {
  switch (connectorType) {
    case "jira":
      return [
        `  Jira connection failed: ${error}`,
        "",
        "  Required environment variables:",
        "    JIRA_BASE_URL  — Your Jira instance URL (e.g., https://mycompany.atlassian.net)",
        "    JIRA_EMAIL     — Your Atlassian account email",
        "    JIRA_TOKEN     — API token (NOT your password)",
        "",
        "  To create an API token:",
        "    1. Go to https://id.atlassian.com/manage-profile/security/api-tokens",
        "    2. Click 'Create API token'",
        "    3. Set JIRA_TOKEN in your .env file",
      ].join("\n");
    case "confluence":
      return [
        `  Confluence connection failed: ${error}`,
        "",
        "  Required environment variables:",
        "    CONFLUENCE_BASE_URL — Your Confluence instance URL",
        "    CONFLUENCE_EMAIL    — Your Atlassian account email",
        "    CONFLUENCE_TOKEN    — API token",
        "    CONFLUENCE_SPACE    — Space key (optional, filters results)",
        "",
        "  To create an API token:",
        "    1. Go to https://id.atlassian.com/manage-profile/security/api-tokens",
        "    2. Click 'Create API token'",
        "    3. Set CONFLUENCE_TOKEN in your .env file",
      ].join("\n");
    case "github":
      return [
        `  GitHub connection failed: ${error}`,
        "",
        "  Required environment variables:",
        "    GITHUB_TOKEN — Personal access token (classic) or fine-grained token",
        "    GITHUB_OWNER — Repository owner (org or username)",
        "",
        "  To create a token:",
        "    1. Go to https://github.com/settings/tokens",
        "    2. Click 'Generate new token (classic)'",
        "    3. Select scopes: repo, read:org",
        "    4. Set GITHUB_TOKEN in your .env file",
      ].join("\n");
    case "teams":
      return [
        `  Microsoft Teams connection failed: ${error}`,
        "",
        "  Required environment variables:",
        "    TEAMS_TENANT_ID     — Azure AD tenant ID",
        "    TEAMS_CLIENT_ID     — App registration client ID",
        "    TEAMS_CLIENT_SECRET — App registration client secret",
        "",
        "  To set up Teams access:",
        "    1. Go to https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps",
        "    2. Register a new application",
        "    3. Add API permissions: ChannelMessage.Read.All, Team.ReadBasic.All",
        "    4. Create a client secret under 'Certificates & secrets'",
        "    5. Set all three env vars in your .env file",
      ].join("\n");
    default:
      return `  Source validation failed: ${error}`;
  }
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

        // Validate connectors with helpful error messages
        spinner.text = "Validating source connections...";
        for (const connector of connectors) {
          const valid = await connector.validate();
          if (!valid) {
            const status = connector.getStatus();
            const helpMsg = getConnectorErrorHelp(connector.type, status.error ?? "Unknown error");
            spinner.warn(chalk.yellow(`Source '${connector.name}' failed validation`));
            console.error(chalk.yellow(helpMsg));
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
          const model = config.costs?.model ?? "claude-sonnet-4";
          const totalChars = allDocuments.reduce((sum, doc) => sum + doc.content.length, 0);
          const tokens = estimateTokens(allDocuments.map(d => d.content).join(""));
          const cost = estimateCost(tokens, model);

          // Get existing pages for predicted output
          const pageManager = new PageManager(ctxDir);
          const existingPages = pageManager.list().filter(
            (p) => p !== "index.md" && p !== "log.md"
          );

          console.log();
          console.log(chalk.bold("=== Dry Run Report ==="));
          console.log();
          console.log(chalk.bold("Documents to ingest:"));
          for (const doc of allDocuments) {
            const docTokens = estimateTokens(doc.content);
            console.log(
              `  ${chalk.cyan(doc.sourceName)} / ${doc.title}  ${chalk.dim(`(${doc.contentType}, ${doc.content.length} chars, ~${docTokens.toLocaleString()} tokens)`)}`
            );
          }
          console.log();
          console.log(chalk.bold("Summary:"));
          console.log(`  Documents:          ${chalk.cyan(String(allDocuments.length))}`);
          console.log(`  Total characters:   ${chalk.cyan(totalChars.toLocaleString())}`);
          console.log(`  Estimated tokens:   ${chalk.cyan(tokens.toLocaleString())}`);
          console.log(`  Model:              ${chalk.cyan(model)}`);
          console.log(`  Est. input cost:    ${chalk.green(`$${cost.input.toFixed(4)}`)}`);
          console.log(`  Est. output cost:   ${chalk.green(`$${cost.output.toFixed(4)}`)}`);
          console.log(`  Est. total cost:    ${chalk.bold.green(`$${cost.total.toFixed(4)}`)}`);
          console.log();
          if (existingPages.length > 0) {
            console.log(chalk.bold("Existing pages that may be updated:"));
            for (const page of existingPages) {
              console.log(`  ${chalk.dim(page)}`);
            }
          } else {
            console.log(chalk.dim("  No existing pages — all pages will be newly created."));
          }
          console.log();
          console.log(chalk.dim("Run without --dry-run to execute."));
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
