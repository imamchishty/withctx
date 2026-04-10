import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { writeFileSync } from "node:fs";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { totalTokens } from "../../claude/client.js";
import { createLLMFromCtxConfig } from "../../llm/index.js";
import { recordCall } from "../../usage/recorder.js";

type OutputFormat = "terminal" | "markdown" | "json";

interface ImpactOptions {
  scope?: string;
  output?: string;
  save?: string;
  format?: OutputFormat;
  maxTokens?: string;
}

const SYSTEM_PROMPT = `You are a senior software architect performing impact analysis. You have access to an entire project wiki that documents the system's architecture, services, dependencies, deployment, teams, and decisions.

When analyzing a proposed change, you MUST respond with EXACTLY the following sections in this order. Use markdown formatting. For each risk item, prefix with a risk level tag: [HIGH], [MEDIUM], or [LOW].

## Affected Services/Repos
List which repositories and services would need changes. Explain what changes each would need.

## Affected Wiki Pages
List which wiki pages describe things that would change or become outdated.

## Dependencies
Describe upstream and downstream impacts. What depends on the things being changed? What do the changed things depend on?

## Key Risks
What could go wrong? What is hardest to change? Tag each risk with [HIGH], [MEDIUM], or [LOW].

## Deployment Impact
Does the deployment order change? Are there migration steps? Is there downtime?

## People/Teams
Who needs to be involved? Who owns the affected systems?

## Estimated Effort
Provide a T-shirt size estimate (Small / Medium / Large / XL) with a brief explanation of what drives the estimate.

## Recommended Approach
Suggest concrete steps to implement the change safely. Number them in order.

## Related Decisions
Reference any existing ADRs or architectural decisions that relate to this change.

Be thorough but practical. If the wiki doesn't contain information about a section, say "Not enough information in the wiki to assess this." rather than making things up.`;

function buildPrompt(change: string, scope?: string): string {
  let prompt = `## Proposed Change
${change}

## Instructions
Analyze the impact of this proposed change across the entire system using the wiki context provided. Be specific — reference actual service names, repo names, wiki pages, and team names from the wiki.
`;

  if (scope) {
    prompt += `\n## Scope Constraint\nFocus the analysis primarily on: ${scope}\n`;
  }

  return prompt;
}

/**
 * Colorize risk tags in terminal output.
 */
function colorizeRisks(text: string): string {
  return text
    .replace(/\[HIGH\]/g, chalk.red.bold("[HIGH]"))
    .replace(/\[MEDIUM\]/g, chalk.yellow.bold("[MEDIUM]"))
    .replace(/\[LOW\]/g, chalk.green.bold("[LOW]"));
}

/**
 * Colorize section headers for terminal display.
 */
function colorizeHeaders(text: string): string {
  return text.replace(/^## (.+)$/gm, (_match, title: string) => {
    return chalk.bold.cyan(`## ${title}`);
  });
}

/**
 * Format the analysis for terminal output with colors.
 */
function formatForTerminal(content: string): string {
  let output = content;
  output = colorizeHeaders(output);
  output = colorizeRisks(output);
  return output;
}

/**
 * Build a markdown document from the analysis.
 */
function buildMarkdown(change: string, content: string, pagesConsulted: number): string {
  const timestamp = new Date().toISOString();
  return `# Impact Analysis: ${change}

_Generated: ${timestamp}_
_Wiki pages consulted: ${pagesConsulted}_

${content}
`;
}

/**
 * Build a JSON structure from the analysis.
 */
function buildJson(
  change: string,
  content: string,
  pagesConsulted: number,
  tokensUsed: { input: number; output: number; cacheRead?: number; cacheCreation?: number } | undefined,
  model: string | undefined
): string {
  return JSON.stringify(
    {
      change,
      timestamp: new Date().toISOString(),
      pagesConsulted,
      model: model ?? "unknown",
      tokensUsed: tokensUsed ?? null,
      analysis: content,
    },
    null,
    2
  );
}

/**
 * Format token usage for display.
 */
function formatTokenUsage(
  tokensUsed: { input: number; output: number; cacheRead?: number; cacheCreation?: number }
): string {
  const parts = [
    `Input: ${tokensUsed.input.toLocaleString()}`,
    `Output: ${tokensUsed.output.toLocaleString()}`,
  ];
  if (tokensUsed.cacheRead) {
    parts.push(`Cache read: ${tokensUsed.cacheRead.toLocaleString()}`);
  }
  if (tokensUsed.cacheCreation) {
    parts.push(`Cache write: ${tokensUsed.cacheCreation.toLocaleString()}`);
  }
  parts.push(`Total: ${(tokensUsed.input + tokensUsed.output).toLocaleString()}`);
  return parts.join(" | ");
}

export function registerImpactCommand(program: Command): void {
  program
    .command("impact")
    .description("Analyze the impact of a proposed change across the system")
    .argument("<change...>", "Description of the proposed change")
    .option("--scope <repos>", "Limit analysis to specific repos/services (comma-separated)")
    .option("--output <file>", "Write analysis to a file")
    .option("--save <path>", "Save as a wiki page (e.g., manual/impact-mongo-migration.md)")
    .option("--format <fmt>", "Output format: terminal, markdown, json", "terminal")
    .action(async (changeParts: string[], options: ImpactOptions) => {
      const change = changeParts.join(" ");
      const format = (options.format ?? "terminal") as OutputFormat;
      const spinner = ora("Loading wiki context...").start();

      try {
        // Load config and context
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx setup' first."));
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);

        // Load ALL wiki pages — impact analysis needs full context
        const allPages = pageManager.list();

        if (allPages.length === 0) {
          spinner.fail(
            chalk.red("No wiki pages found. Run 'ctx ingest' to compile your context.")
          );
          process.exit(1);
        }

        spinner.text = `Loading ${allPages.length} wiki pages for full-context analysis...`;
        const contextFiles: Array<{ path: string; content: string }> = [];

        for (const pagePath of allPages) {
          const page = pageManager.read(pagePath);
          if (page) {
            contextFiles.push({ path: pagePath, content: page.content });
          }
        }

        // Build the prompt
        const prompt = buildPrompt(change, options.scope);

        // Send to Claude
        spinner.text = `Analyzing impact of: "${change.slice(0, 60)}${change.length > 60 ? "..." : ""}"`;

        const claude = createLLMFromCtxConfig(config, "impact");
        const maxTokens = options.maxTokens ? parseInt(options.maxTokens, 10) : 8192;

        const response = await claude.promptWithFiles(prompt, contextFiles, {
          systemPrompt: SYSTEM_PROMPT,
          maxTokens,
          cacheSystemPrompt: true,
        });

        spinner.stop();

        // Display based on format
        const pagesConsulted = contextFiles.length;

        switch (format) {
          case "json": {
            const jsonOutput = buildJson(
              change,
              response.content,
              pagesConsulted,
              response.tokensUsed,
              response.model
            );
            if (options.output) {
              writeFileSync(options.output, jsonOutput);
              console.log(chalk.green(`Analysis written to ${chalk.bold(options.output)}`));
            } else {
              console.log(jsonOutput);
            }
            break;
          }
          case "markdown": {
            const mdOutput = buildMarkdown(change, response.content, pagesConsulted);
            if (options.output) {
              writeFileSync(options.output, mdOutput);
              console.log(chalk.green(`Analysis written to ${chalk.bold(options.output)}`));
            } else {
              console.log(mdOutput);
            }
            break;
          }
          case "terminal":
          default: {
            console.log();
            console.log(chalk.bold.white("Impact Analysis"));
            console.log(chalk.dim("─".repeat(60)));
            console.log(chalk.bold("Proposed change:"), chalk.white(change));
            if (options.scope) {
              console.log(chalk.bold("Scope:"), chalk.cyan(options.scope));
            }
            console.log(chalk.dim("─".repeat(60)));
            console.log();
            console.log(formatForTerminal(response.content));
            console.log();

            // Write to file if --output specified
            if (options.output) {
              const mdOutput = buildMarkdown(change, response.content, pagesConsulted);
              writeFileSync(options.output, mdOutput);
              console.log(chalk.green(`Analysis also written to ${chalk.bold(options.output)}`));
            }
            break;
          }
        }

        // Save as wiki page if requested
        if (options.save) {
          const savePath = options.save.endsWith(".md") ? options.save : `${options.save}.md`;
          const saveContent = buildMarkdown(change, response.content, pagesConsulted);
          pageManager.write(savePath, saveContent);
          console.log(chalk.green(`Saved as wiki page: ${chalk.bold(savePath)}`));
        }

        // Display token usage
        console.log();
        console.log(chalk.dim("─".repeat(60)));
        console.log(chalk.dim(`Wiki pages consulted: ${pagesConsulted}`));
        if (response.model) {
          console.log(chalk.dim(`Model: ${response.model}`));
        }
        if (response.tokensUsed) {
          console.log(chalk.dim(`Tokens: ${formatTokenUsage(response.tokensUsed)}`));

          // Estimate cost (Claude Sonnet pricing: $3/MTok input, $15/MTok output)
          const inputCost = (response.tokensUsed.input / 1_000_000) * 3;
          const outputCost = (response.tokensUsed.output / 1_000_000) * 15;
          const cacheReadCost = ((response.tokensUsed.cacheRead ?? 0) / 1_000_000) * 0.3;
          const cacheWriteCost = ((response.tokensUsed.cacheCreation ?? 0) / 1_000_000) * 3.75;
          const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;
          console.log(chalk.dim(`Estimated cost: $${totalCost.toFixed(4)}`));

          recordCall(ctxDir, "impact", response.model ?? config.costs?.model ?? "claude-sonnet-4", {
            input: response.tokensUsed.input,
            output: response.tokensUsed.output,
            cacheRead: response.tokensUsed.cacheRead ?? 0,
            cacheWrite: response.tokensUsed.cacheCreation ?? 0,
          });
        }
      } catch (error) {
        spinner.fail(chalk.red("Impact analysis failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
