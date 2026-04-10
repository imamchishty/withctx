import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, relative, basename, extname, dirname } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { createLLMFromCtxConfig } from "../../llm/index.js";
import { CostTracker } from "../../costs/tracker.js";
import { recordCall } from "../../usage/recorder.js";

type Depth = "brief" | "normal" | "deep";
type Audience = "new-engineer" | "senior" | "agent";

interface ExplainOptions {
  depth?: Depth;
  for?: Audience;
  save?: boolean;
  maxTokens?: string;
}

/**
 * Resolve a file path (relative or absolute) and read its content.
 */
function resolveFile(input: string): { content: string; absolutePath: string; relativePath: string } {
  const absolutePath = resolve(input);

  if (!existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const content = readFileSync(absolutePath, "utf-8");
  const relativePath = relative(process.cwd(), absolutePath);

  return { content, absolutePath, relativePath };
}

/**
 * Load relevant wiki pages based on the file being explained.
 * Matches the file to repo overview, patterns, decisions, architecture, gotchas.
 */
function loadRelevantWikiPages(
  pageManager: PageManager,
  filePath: string
): Array<{ path: string; content: string }> {
  const allPages = pageManager.list();
  const relevant: Array<{ path: string; content: string }> = [];
  const added = new Set<string>();

  // Always include high-value context pages
  const alwaysInclude = [
    "architecture.md",
    "conventions.md",
    "decisions.md",
    "gotchas.md",
    "patterns.md",
    "cross-repo/dependencies.md",
    "overview.md",
    "index.md",
    "testing.md",
  ];

  for (const pagePath of alwaysInclude) {
    if (allPages.includes(pagePath) && !added.has(pagePath)) {
      const page = pageManager.read(pagePath);
      if (page) {
        relevant.push({ path: pagePath, content: page.content });
        added.add(pagePath);
      }
    }
  }

  // Match file path parts to wiki pages
  const pathParts = filePath.split("/").filter((p) => p.length > 2);
  const fileBaseName = basename(filePath, extname(filePath)).toLowerCase();
  const dirName = basename(dirname(filePath)).toLowerCase();

  for (const pagePath of allPages) {
    if (added.has(pagePath)) continue;
    const pagePathLower = pagePath.toLowerCase();
    const pageBaseName = basename(pagePath, ".md").toLowerCase();

    // Direct name match (e.g., file is "auth.ts" and wiki has "auth.md")
    if (pageBaseName === fileBaseName || pageBaseName === dirName) {
      const page = pageManager.read(pagePath);
      if (page) {
        relevant.push({ path: pagePath, content: page.content });
        added.add(pagePath);
        continue;
      }
    }

    // Directory path overlap
    for (const part of pathParts) {
      if (pagePathLower.includes(part.toLowerCase())) {
        const page = pageManager.read(pagePath);
        if (page) {
          relevant.push({ path: pagePath, content: page.content });
          added.add(pagePath);
        }
        break;
      }
    }
  }

  return relevant;
}

/**
 * Build depth instruction for the explanation prompt.
 */
function depthInstruction(depth: Depth): string {
  switch (depth) {
    case "brief":
      return `Provide a BRIEF explanation. 3-5 sentences per section maximum. Focus on the essentials only.`;
    case "deep":
      return `Provide a DEEP explanation. Be thorough and detailed. Include implementation specifics, edge cases, and historical context from the wiki. Explain data flows and all connections.`;
    case "normal":
    default:
      return `Provide a balanced explanation. Cover all sections with enough detail to be useful, but don't over-elaborate.`;
  }
}

/**
 * Build audience instruction for the explanation prompt.
 */
function audienceInstruction(audience: Audience): string {
  switch (audience) {
    case "new-engineer":
      return `Target audience: NEW ENGINEER. Assume no prior knowledge of this codebase. Explain all domain terms, patterns, and conventions. Link concepts to general programming knowledge. Be welcoming and thorough.`;
    case "senior":
      return `Target audience: SENIOR ENGINEER. Be direct and technical. Skip basics. Focus on architecture decisions, trade-offs, gotchas, and non-obvious patterns. Highlight what's unique or unusual about this code.`;
    case "agent":
      return `Target audience: AI AGENT. Optimize for machine consumption. Be precise and structured. Include exact file paths, function signatures, and dependency chains. Use consistent terminology matching the wiki. Avoid narrative — use bullet points and structured data.`;
    default:
      return `Target audience: general developer. Balance accessibility with technical depth.`;
  }
}

export function registerExplainCommand(program: Command): void {
  program
    .command("explain")
    .description("Deep explanation of any file using wiki context")
    .argument("<file>", "File path to explain (relative or absolute)")
    .option("--depth <level>", "Explanation depth: brief, normal, deep", "normal")
    .option(
      "--for <audience>",
      "Target audience: new-engineer, senior, agent",
      "senior"
    )
    .option("--save", "Save explanation as a wiki page")
    .option("--max-tokens <n>", "Max tokens for response")
    .action(async (file: string, options: ExplainOptions) => {
      const spinner = ora("Reading file...").start();

      try {
        // 1. Read the target file
        const { content: fileContent, relativePath, absolutePath } = resolveFile(file);

        if (!fileContent.trim()) {
          spinner.fail(chalk.red(`File is empty: ${relativePath}`));
          process.exit(1);
        }

        spinner.text = "Loading wiki context...";

        // 2. Load config and wiki
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);
        const wikiPages = loadRelevantWikiPages(pageManager, relativePath);

        spinner.text = `Loaded ${wikiPages.length} wiki page(s). Asking Claude to explain...`;

        // 3. Build prompt
        const depth = (options.depth ?? "normal") as Depth;
        const audience = (options.for ?? "senior") as Audience;

        const systemPrompt = `You are a codebase expert with access to the project's compiled wiki. You explain files by connecting code to business context, architectural decisions, and project conventions.

${depthInstruction(depth)}
${audienceInstruction(audience)}

Your explanation MUST use this exact format with these section headers:

## What It Does
Explain the file's functionality — what this code does at a technical level.

## Why It Exists
Business context and purpose. Why was this file created? What problem does it solve? Reference wiki pages for context.

## Key Patterns
Patterns and conventions used in this file. Reference conventions.md and patterns.md if applicable.

## Connections
How this file connects to other parts of the codebase. Imports, exports, dependencies, consumers. Reference architecture.md and cross-repo/dependencies.md if applicable.

## Gotchas
Known issues, edge cases, or surprises. Reference gotchas.md if applicable. If no gotchas are known, note what a developer should watch out for based on the code.

## Recent Context
Any relevant architectural decisions or recent changes from decisions.md. If nothing directly applies, write "No specific decision context found."`;

        const userPrompt = `Explain the following file using the wiki context provided.

## File
**Path:** ${relativePath}
**Language:** ${extname(relativePath).slice(1) || "unknown"}
**Lines:** ${fileContent.split("\n").length}

\`\`\`${extname(relativePath).slice(1) || ""}
${fileContent}
\`\`\``;

        // 4. Call Claude
        const claude = createLLMFromCtxConfig(config, "explain");
        const response = await claude.promptWithFiles(userPrompt, wikiPages, {
          systemPrompt,
          maxTokens: options.maxTokens ? parseInt(options.maxTokens, 10) : 8192,
          cacheSystemPrompt: true,
        });

        spinner.stop();

        // 5. Format and display
        const explanation = response.content;
        const coloredExplanation = colorizeExplanation(explanation);

        console.log();
        console.log(chalk.bold.underline(`Explanation: ${relativePath}`));
        console.log(chalk.dim(`Depth: ${depth} | Audience: ${audience}`));
        console.log();
        console.log(coloredExplanation);
        console.log();

        // 6. Token/cost tracking
        if (response.tokensUsed) {
          const explainModel = response.model ?? config.costs?.model ?? "claude-sonnet-4";
          const costTracker = new CostTracker(ctxDir, {
            budget: config.costs?.budget,
          });
          costTracker.record(
            "explain",
            {
              inputTokens: response.tokensUsed.input,
              outputTokens: response.tokensUsed.output,
            },
            explainModel
          );
          recordCall(ctxDir, "explain", explainModel, {
            input: response.tokensUsed.input,
            output: response.tokensUsed.output,
            cacheRead: response.tokensUsed.cacheRead ?? 0,
            cacheWrite: response.tokensUsed.cacheCreation ?? 0,
          });

          console.log(
            chalk.dim(
              `Tokens: ${response.tokensUsed.input.toLocaleString()} in / ${response.tokensUsed.output.toLocaleString()} out` +
                (response.tokensUsed.cacheRead
                  ? ` (${response.tokensUsed.cacheRead.toLocaleString()} cache read)`
                  : "")
            )
          );
        }

        console.log(chalk.dim(`Wiki pages consulted: ${wikiPages.length}`));

        // 7. Save as wiki page if requested
        if (options.save) {
          const slug = relativePath
            .replace(/[/\\]/g, "-")
            .replace(/\.[^.]+$/, "")
            .replace(/[^a-zA-Z0-9-]/g, "-")
            .toLowerCase();
          const savePath = `manual/explain-${slug}.md`;

          const saveContent = `# Explanation: ${relativePath}

_Generated: ${new Date().toISOString()}_
_Depth: ${depth} | Audience: ${audience}_
_Wiki pages consulted: ${wikiPages.map((p) => p.path).join(", ")}_

${explanation}
`;
          pageManager.write(savePath, saveContent);
          console.log();
          console.log(chalk.green(`Explanation saved to ${chalk.bold(savePath)}`));
        }
      } catch (error) {
        spinner.fail(chalk.red("Explanation failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}

/**
 * Apply chalk colors to explanation sections for terminal output.
 */
function colorizeExplanation(explanation: string): string {
  const lines = explanation.split("\n");
  const colored: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## What It Does")) {
      colored.push(chalk.bold.cyan(line));
    } else if (line.startsWith("## Why It Exists")) {
      colored.push(chalk.bold.magenta(line));
    } else if (line.startsWith("## Key Patterns")) {
      colored.push(chalk.bold.blue(line));
    } else if (line.startsWith("## Connections")) {
      colored.push(chalk.bold.yellow(line));
    } else if (line.startsWith("## Gotchas")) {
      colored.push(chalk.bold.red(line));
    } else if (line.startsWith("## Recent Context")) {
      colored.push(chalk.bold.green(line));
    } else {
      colored.push(line);
    }
  }

  return colored.join("\n");
}
