import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { ClaudeClient } from "../../claude/client.js";
import { ConnectorRegistry } from "../../connectors/registry.js";
import { LocalFilesConnector } from "../../connectors/local-files.js";
import { safeGenerate } from "../../connectors/safe-generator.js";
import { progressBar, formatCost, formatTokens, formatDuration } from "../utils/progress.js";
import type { RawDocument } from "../../types/source.js";
import type { SourceConnector } from "../../connectors/types.js";

interface IngestOptions {
  maxTokens?: string;
  dryRun?: boolean;
  yes?: boolean;
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

/** Prompt user for Y/n confirmation via stderr. Returns true if confirmed. */
async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(!answer || answer.toLowerCase().startsWith("y"));
    });
  });
}

/** Classify a document's freshness based on updatedAt. */
function classifyFreshness(doc: RawDocument): "fresh" | "aging" | "stale" {
  if (!doc.updatedAt) return "stale";
  const age = Date.now() - new Date(doc.updatedAt).getTime();
  const days = age / (1000 * 60 * 60 * 24);
  if (days <= 7) return "fresh";
  if (days <= 30) return "aging";
  return "stale";
}

/** Detect duplicate documents by title+source. Returns the deduped list and removed count. */
function deduplicateDocs(docs: RawDocument[]): { unique: RawDocument[]; duplicateCount: number } {
  const seen = new Set<string>();
  const unique: RawDocument[] = [];
  let duplicateCount = 0;

  for (const doc of docs) {
    const key = `${doc.sourceName}:${doc.title}`;
    if (seen.has(key)) {
      duplicateCount++;
    } else {
      seen.add(key);
      unique.push(doc);
    }
  }

  return { unique, duplicateCount };
}

/** Per-source progress state for rendering. */
interface SourceProgress {
  name: string;
  type: string;
  count: number;
  total: number | null; // null means unknown total
  done: boolean;
  error?: string;
}

/** Clear N lines above current cursor and rewrite source progress. */
function renderSourceProgress(sources: SourceProgress[]): void {
  // Move up and clear previous lines
  if (sources.length > 0) {
    process.stderr.write(`\x1b[${sources.length}A`);
  }

  for (const src of sources) {
    const label = `  ${chalk.cyan(src.name)} (${src.type})`;
    const padded = label.padEnd(32);

    let status: string;
    if (src.error) {
      status = chalk.red("error");
    } else if (src.done) {
      const bar = progressBar(1, 1, 12);
      status = `${chalk.dim("done")}              ${bar.split("  ")[0]}  ${chalk.bold(String(src.count))} docs`;
    } else if (src.total !== null && src.total > 0) {
      const bar = progressBar(src.count, src.total, 12);
      status = `${String(src.count).padStart(4)}/${src.total} docs    ${bar}`;
    } else {
      status = `${chalk.dim("scanning...")}       ${"░".repeat(12)}  ${src.count} docs`;
    }

    // Clear line and write
    process.stderr.write(`\x1b[2K${padded}${status}\n`);
  }
}

export function registerIngestCommand(program: Command): void {
  program
    .command("ingest")
    .description("Fetch all sources and compile into wiki pages using Claude")
    .option("--max-tokens <n>", "Max tokens for Claude response")
    .option("--dry-run", "Show what would be ingested without calling Claude")
    .option("-y, --yes", "Skip cost confirmation")
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
        const validConnectors: SourceConnector[] = [];
        for (const connector of connectors) {
          const valid = await connector.validate();
          if (!valid) {
            const status = connector.getStatus();
            const helpMsg = getConnectorErrorHelp(connector.type, status.error ?? "Unknown error");
            spinner.warn(chalk.yellow(`Source '${connector.name}' failed validation`));
            console.error(chalk.yellow(helpMsg));
          } else {
            validConnectors.push(connector);
          }
        }

        if (validConnectors.length === 0) {
          spinner.fail(chalk.red("All sources failed validation."));
          process.exit(1);
        }

        // Fetch all documents with per-source progress
        spinner.succeed("Sources validated");
        console.error();

        const allDocuments: RawDocument[] = [];
        const sourceProgressList: SourceProgress[] = validConnectors.map((c) => ({
          name: c.name,
          type: c.type,
          count: 0,
          total: null,
          done: false,
        }));

        // Print initial blank lines for progress rendering
        for (const _src of sourceProgressList) {
          process.stderr.write("\n");
        }

        for (let i = 0; i < validConnectors.length; i++) {
          const connector = validConnectors[i];
          const progress = sourceProgressList[i];

          // Check if connector exposes a total count via status
          const status = connector.getStatus();
          if (status.itemCount && status.itemCount > 0) {
            progress.total = status.itemCount;
          }

          try {
            for await (const doc of safeGenerate(connector.fetch(), {
              sourceName: connector.name,
            })) {
              allDocuments.push(doc);
              progress.count++;
              renderSourceProgress(sourceProgressList);
            }
            progress.done = true;
            renderSourceProgress(sourceProgressList);
          } catch (error) {
            progress.error = error instanceof Error ? error.message : String(error);
            renderSourceProgress(sourceProgressList);
            console.error(
              chalk.yellow(
                `\n  Warning: Error fetching from ${connector.name}: ${progress.error}`
              )
            );
          }
        }

        console.error(); // blank line after progress

        if (allDocuments.length === 0) {
          console.error(chalk.red("No documents found across any sources."));
          process.exit(1);
        }

        // Deduplicate
        const { unique: uniqueDocs, duplicateCount } = deduplicateDocs(allDocuments);

        console.error(
          chalk.green(`  Fetched ${chalk.bold(String(allDocuments.length))} documents from ${validConnectors.length} source(s)`) +
          (duplicateCount > 0 ? chalk.dim(` (${duplicateCount} duplicates removed)`) : "")
        );
        console.error();

        // Compute stats shared between dry-run and live run
        const model = config.costs?.model ?? "claude-sonnet-4";
        const tokens = estimateTokens(uniqueDocs.map((d) => d.content).join(""));
        const cost = estimateCost(tokens, model);

        // Freshness breakdown
        const freshCount = uniqueDocs.filter((d) => classifyFreshness(d) === "fresh").length;
        const agingCount = uniqueDocs.filter((d) => classifyFreshness(d) === "aging").length;
        const staleCount = uniqueDocs.filter((d) => classifyFreshness(d) === "stale").length;

        // Get existing pages
        const pageManager = new PageManager(ctxDir);
        const existingPages = pageManager.list().filter(
          (p) => p !== "index.md" && p !== "log.md"
        );

        if (options.dryRun) {
          // --- Enhanced dry run preview ---
          console.error(chalk.bold("  Dry Run Preview"));
          console.error(chalk.dim("  " + "\u2500".repeat(25)));
          console.error(`  Sources scanned:    ${chalk.cyan(String(validConnectors.length))}`);
          console.error(`  Documents found:    ${chalk.cyan(String(uniqueDocs.length))}`);
          console.error(`  Estimated tokens:   ${chalk.cyan(formatTokens(tokens))}`);
          console.error(`  Estimated cost:     ${chalk.green(formatCost(cost.total))} ${chalk.dim(`(${model})`)}`);
          console.error();
          console.error(chalk.bold("  Quality:"));
          console.error(`    Fresh (<7d):      ${chalk.green(String(freshCount))} docs`);
          console.error(`    Aging (7-30d):    ${chalk.yellow(String(agingCount))} docs`);
          console.error(`    Stale (>30d):     ${chalk.red(String(staleCount))} docs`);
          if (duplicateCount > 0) {
            console.error(`    Duplicates:       ${chalk.dim(String(duplicateCount))} removed`);
          }
          console.error();

          if (existingPages.length > 0) {
            console.error(chalk.bold("  Existing pages that may be updated:"));
            for (const page of existingPages) {
              console.error(`    ${chalk.dim(page)}`);
            }
            console.error();
          }

          // Per-document detail
          console.error(chalk.bold("  Documents to ingest:"));
          for (const doc of uniqueDocs) {
            const docTokens = estimateTokens(doc.content);
            console.error(
              `    ${chalk.cyan(doc.sourceName)} / ${doc.title}  ${chalk.dim(`(${doc.contentType}, ~${docTokens.toLocaleString()} tokens)`)}`
            );
          }
          console.error();
          console.error(chalk.dim("  Run without --dry-run to compile."));
          return;
        }

        // --- Cost confirmation (non-dry-run) ---
        if (!options.yes) {
          const proceed = await confirm(
            `  This will use ${formatTokens(tokens)} tokens (${formatCost(cost.total)}). Continue? [Y/n] `
          );
          if (!proceed) {
            console.error(chalk.dim("  Aborted."));
            return;
          }
        }

        // Check Claude availability
        const claude = new ClaudeClient(config.costs?.model ?? "claude-sonnet-4");
        const available = await claude.isAvailable();
        if (!available) {
          console.error(
            chalk.red("Claude CLI not found. Install it: https://docs.anthropic.com/claude-code")
          );
          process.exit(1);
        }

        // Compile with Claude
        const compileSpinner = ora("Compiling wiki pages with Claude...").start();
        const startTime = Date.now();
        const prompt = buildCompilePrompt(uniqueDocs, existingPages);

        const claudeOptions: { maxTokens?: number; systemPrompt: string } = {
          systemPrompt:
            "You are a technical documentation compiler. Compile source documents into a well-structured wiki. Output pages in the exact format requested.",
        };
        if (options.maxTokens) {
          claudeOptions.maxTokens = parseInt(options.maxTokens, 10);
        }

        const response = await claude.prompt(prompt, claudeOptions);
        const elapsed = Date.now() - startTime;

        // Parse the compiled pages
        const compiledPages = parseCompiledPages(response.content);

        if (compiledPages.length === 0) {
          // If Claude didn't use the page format, save the whole response as a single page
          pageManager.write("compiled-context.md", response.content);
          compileSpinner.succeed("Compiled context saved as compiled-context.md");
        } else {
          // Write each compiled page and track created vs updated
          const created: string[] = [];
          const updated: string[] = [];
          const existingSet = new Set(existingPages);

          for (const page of compiledPages) {
            const existed = existingSet.has(page.path);
            pageManager.write(page.path, page.content);
            if (existed) {
              updated.push(page.path);
            } else {
              created.push(page.path);
            }
          }

          const unchanged = existingPages.filter(
            (p) => !updated.includes(p) && !created.includes(p)
          );

          compileSpinner.succeed(
            `Compiled ${chalk.bold(String(compiledPages.length))} wiki pages`
          );

          // --- Post-ingest diff ---
          console.error();
          console.error(chalk.bold("  Ingest complete"));
          console.error(chalk.dim("  " + "\u2500".repeat(25)));

          if (created.length > 0) {
            console.error(
              `  Pages created:   ${chalk.green(String(created.length))}   ${chalk.dim(created.join(", "))}`
            );
          }
          if (updated.length > 0) {
            console.error(
              `  Pages updated:   ${chalk.yellow(String(updated.length))}   ${chalk.dim(updated.join(", "))}`
            );
          }
          if (unchanged.length > 0) {
            console.error(
              `  Pages unchanged: ${chalk.dim(String(unchanged.length))}`
            );
          }

          console.error();

          if (response.tokensUsed) {
            const totalTokens = response.tokensUsed.input + response.tokensUsed.output;
            const actualCost = estimateCost(response.tokensUsed.input, model);
            const outputPricing = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4"];
            const actualOutputCost = (response.tokensUsed.output / 1_000_000) * outputPricing.output;
            const actualTotalCost = actualCost.input + actualOutputCost;
            console.error(
              `  Tokens used:     ${chalk.cyan(totalTokens.toLocaleString())} (${formatCost(actualTotalCost)})`
            );
          }
          console.error(`  Duration:        ${chalk.cyan(formatDuration(elapsed))}`);
          console.error();
        }

        // Update log
        const logContent = ctxDir.readPage("log.md") ?? "";
        const logEntry = `| ${new Date().toISOString()} | ingest | Ingested ${uniqueDocs.length} docs, compiled ${compiledPages.length} pages |`;
        ctxDir.writePage(
          "log.md",
          logContent + "\n" + logEntry
        );

        // Track costs
        if (response.tokensUsed) {
          const total = response.tokensUsed.input + response.tokensUsed.output;
          trackCostEntry(ctxDir, "ingest", total);
        }
      } catch (error) {
        // Ensure spinner is stopped on error
        console.error(chalk.red("Ingest failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
