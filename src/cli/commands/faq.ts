import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { createLLMFromCtxConfig } from "../../llm/index.js";
import { CostTracker } from "../../costs/tracker.js";
import { recordCall } from "../../usage/recorder.js";

const FAQ_PAGE = "faq.md";

interface FaqOptions {
  regenerate?: boolean;
  count?: string;
  scope?: string;
  output?: string;
  for?: string;
}

const AUDIENCE_PROFILES: Record<string, string> = {
  "new-engineer": `Target audience: a new engineer joining the team.
Focus on basics: setup, first PR, who to ask, common pitfalls, and getting productive fast.
Use approachable language and include step-by-step guidance where possible.`,
  senior: `Target audience: a senior engineer evaluating the architecture.
Focus on architecture decisions, trade-offs, scalability patterns, tech debt, and system boundaries.
Assume deep technical knowledge — skip basic setup unless it's unusual.`,
  agent: `Target audience: an AI coding agent (e.g. Claude, Copilot) working in this codebase.
Focus on code patterns, conventions, file structure, naming rules, testing expectations, and how services communicate.
Be precise and machine-parseable. Include exact file paths, command examples, and config locations where available.`,
};

const FAQ_SYSTEM_PROMPT = `You are an expert technical writer creating a FAQ document for engineers joining a project.

Your task:
1. Read all the wiki pages provided as context.
2. Generate the top N questions that engineers would ask about this project.
3. Answer each question using ONLY information from the wiki pages. Do not invent or assume information.
4. Cite which wiki page(s) the answer comes from.
5. Organize questions into these categories (skip categories with no relevant questions):
   - General (project purpose, scope, business context)
   - Getting Started (setup, local dev, first PR)
   - Architecture (how things connect, tech stack, patterns)
   - Development (conventions, testing, PR process, code patterns)
   - Services & APIs (endpoints, data flow, data models, dependencies)
   - Authentication & Authorization (auth flows, permissions, tokens)
   - Operations (deploy, monitoring, debugging, incidents)
   - People & Process (ownership, teams, decisions, contributing)
6. Format as clean markdown with:
   - ## Category headings
   - ### Q: Question here? for each question
   - Answer paragraph with _Source: page.md_ citations at the end of each answer
7. Cover these topics where the wiki has relevant information:
   - Project purpose and scope
   - Architecture and tech stack
   - How to set up locally
   - Code patterns and conventions
   - Deploy process
   - Testing strategy
   - How services communicate
   - Common gotchas and pitfalls
   - Who to ask about what
   - Recent decisions and their rationale
   - API endpoints and usage
   - Data models and storage
   - Authentication and authorization
   - Monitoring and debugging
   - How to contribute

Output ONLY the markdown content. Start with a top-level heading "# Frequently Asked Questions".`;

/**
 * Build the user prompt for FAQ generation.
 */
function buildFaqPrompt(count: number, scope?: string, audience?: string): string {
  const scopeNote = scope
    ? `\nFocus specifically on the "${scope}" area of the project.`
    : "";

  const audienceNote = audience && AUDIENCE_PROFILES[audience]
    ? `\n\n${AUDIENCE_PROFILES[audience]}`
    : audience
      ? `\nTarget audience: ${audience}. Tailor the questions and depth of answers accordingly.`
      : "";

  return `Generate exactly ${count} frequently asked questions and answers about this project.${scopeNote}${audienceNote}

Rules:
- Every answer must be grounded in the wiki content provided. Do not guess.
- Cite sources as _Source: filename.md_ at the end of each answer.
- Distribute questions across the categories as evenly as the content allows.
- Prioritize the most practical, day-to-day questions an engineer would ask.
- If the wiki content is thin on a category, include fewer questions for it rather than inventing answers.`;
}

/**
 * Display FAQ content in the terminal with colored formatting.
 */
function displayFaq(content: string): void {
  const lines = content.split("\n");

  for (const line of lines) {
    if (line.startsWith("# ")) {
      console.log(chalk.bold.white(line));
    } else if (line.startsWith("## ")) {
      console.log(chalk.bold.yellow(line));
    } else if (line.startsWith("### Q:")) {
      console.log(chalk.bold.cyan(line));
    } else if (line.trim().startsWith("_Source:")) {
      console.log(chalk.dim(line));
    } else {
      console.log(line);
    }
  }
}

/**
 * Append an entry to the wiki log.
 */
function appendLog(pageManager: PageManager, detail: string): void {
  const logContent = pageManager.read("log.md");
  if (logContent) {
    const timestamp = new Date().toISOString();
    const newLine = `| ${timestamp} | faq | ${detail} |`;
    const updated = logContent.content + "\n" + newLine;
    pageManager.write("log.md", updated);
  }
}

/**
 * Update index.md to include a link to faq.md if not already present.
 */
function updateIndex(pageManager: PageManager): void {
  const indexPage = pageManager.read("index.md");
  if (!indexPage) return;

  if (indexPage.content.includes("faq.md")) return;

  // Add FAQ link to the index
  const faqLink = "\n- [Frequently Asked Questions](faq.md)\n";
  const content = indexPage.content;

  // Try to insert after the first heading block
  const headingEnd = content.indexOf("\n\n");
  if (headingEnd !== -1) {
    const updated =
      content.slice(0, headingEnd) + "\n" + faqLink + content.slice(headingEnd);
    pageManager.write("index.md", updated);
  } else {
    pageManager.write("index.md", content + faqLink);
  }
}

export function registerFaqCommand(program: Command): void {
  program
    .command("faq")
    .description(
      "Auto-generate a FAQ page from wiki content — answers the top questions engineers ask"
    )
    .option("--regenerate", "Force regenerate even if faq.md already exists")
    .option("--count <n>", "Number of Q&As to generate (default: 20)")
    .option("--scope <dir>", "Generate FAQ for a specific wiki subdirectory")
    .option("--output <path>", "Write FAQ to an additional file path")
    .option("--for <audience>", "Tailor FAQ for audience (new-engineer, senior, agent)")
    .action(async (options: FaqOptions) => {
      const spinner = ora("Loading wiki context...").start();

      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(
            chalk.red("No .ctx/ directory found. Run 'ctx init' first.")
          );
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);

        // Check for existing FAQ (unless --regenerate)
        if (!options.regenerate) {
          const existing = pageManager.read(FAQ_PAGE);
          if (existing) {
            spinner.stop();
            console.log();
            displayFaq(existing.content);
            console.log();
            console.log(
              chalk.dim(
                "Showing cached FAQ. Use --regenerate to rebuild from current wiki."
              )
            );
            return;
          }
        }

        // Load all wiki pages
        const pages = pageManager.list(options.scope);

        if (pages.length === 0) {
          spinner.fail(
            chalk.red(
              "No wiki pages found. Run 'ctx ingest' to compile your context first."
            )
          );
          process.exit(1);
        }

        spinner.text = `Loading ${pages.length} wiki pages...`;
        const contextFiles: Array<{ path: string; content: string }> = [];

        for (const pagePath of pages) {
          // Skip log.md and existing faq.md from context
          if (pagePath === "log.md" || pagePath === FAQ_PAGE) continue;

          const page = pageManager.read(pagePath);
          if (page) {
            contextFiles.push({ path: pagePath, content: page.content });
          }
        }

        if (contextFiles.length === 0) {
          spinner.fail(
            chalk.red("No usable wiki pages found after filtering.")
          );
          process.exit(1);
        }

        // Generate FAQ via Claude
        const count = options.count ? parseInt(options.count, 10) : 20;
        spinner.text = `Generating ${count} Q&As from ${contextFiles.length} wiki pages...`;

        const claude = createLLMFromCtxConfig(config, "faq");
        const costTracker = new CostTracker(ctxDir, {
          budget: config.costs?.budget,
          alertAt: config.costs?.alert_at,
        });

        const userPrompt = buildFaqPrompt(count, options.scope, options.for);

        const response = await claude.promptWithFiles(userPrompt, contextFiles, {
          systemPrompt: FAQ_SYSTEM_PROMPT,
          maxTokens: 8192,
          cacheSystemPrompt: true,
        });

        // Add metadata header after the first heading line
        const rawContent = response.content;
        const audienceLabel = options.for ? ` | Audience: ${options.for}` : "";
        const scopeLabel2 = options.scope ? ` | Scope: ${options.scope}` : "";
        const metaLine = `\n_Auto-generated from project wiki. Last updated: ${new Date().toISOString().slice(0, 10)}${audienceLabel}${scopeLabel2}_\n`;

        // Insert metadata after the first heading
        const firstNewline = rawContent.indexOf("\n");
        const faqContent =
          firstNewline !== -1
            ? rawContent.slice(0, firstNewline) + "\n" + metaLine + rawContent.slice(firstNewline + 1)
            : rawContent + "\n" + metaLine;

        // Save to wiki
        spinner.text = "Saving FAQ to wiki...";
        pageManager.write(FAQ_PAGE, faqContent);

        // Update index.md
        updateIndex(pageManager);

        // Log the generation
        const scopeLabel = options.scope ? ` (scope: ${options.scope})` : "";
        appendLog(
          pageManager,
          `Generated ${count} Q&As from ${contextFiles.length} pages${scopeLabel}`
        );

        // Track costs
        if (response.tokensUsed) {
          const faqModel = response.model ?? config.costs?.model ?? "claude-sonnet-4";
          costTracker.record(
            "faq",
            {
              inputTokens: response.tokensUsed.input,
              outputTokens: response.tokensUsed.output,
            },
            faqModel
          );
          recordCall(ctxDir, "faq", faqModel, {
            input: response.tokensUsed.input,
            output: response.tokensUsed.output,
            cacheRead: response.tokensUsed.cacheRead ?? 0,
            cacheWrite: response.tokensUsed.cacheCreation ?? 0,
          });
        }

        // Write to additional output file if requested
        if (options.output) {
          const outputPath = resolve(process.cwd(), options.output);
          writeFileSync(outputPath, faqContent, "utf-8");
        }

        spinner.stop();

        // Display the FAQ
        console.log();
        displayFaq(faqContent);
        console.log();

        // Summary
        console.log(chalk.green(`FAQ saved to .ctx/context/${FAQ_PAGE}`));
        if (options.output) {
          console.log(
            chalk.green(`Also written to ${resolve(process.cwd(), options.output)}`)
          );
        }

        if (response.tokensUsed) {
          const total = response.tokensUsed.input + response.tokensUsed.output;
          console.log(
            chalk.dim(
              `Tokens: ${total.toLocaleString()} (${response.tokensUsed.input.toLocaleString()} in / ${response.tokensUsed.output.toLocaleString()} out)`
            )
          );
        }

        console.log(
          chalk.dim(`Generated from ${contextFiles.length} wiki page(s)`)
        );
      } catch (error) {
        spinner.fail(chalk.red("FAQ generation failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
