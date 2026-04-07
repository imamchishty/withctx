import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { ClaudeClient } from "../../claude/client.js";

interface QueryOptions {
  save?: boolean;
  scope?: string;
  maxTokens?: string;
}

export function registerQueryCommand(program: Command): void {
  program
    .command("query")
    .description("Ask a question against the compiled wiki")
    .argument("<question...>", "Your question")
    .option("--save", "Save the answer as a wiki page")
    .option("--scope <dir>", "Limit to a specific wiki subdirectory")
    .option("--max-tokens <n>", "Max tokens for response")
    .action(async (questionParts: string[], options: QueryOptions) => {
      const question = questionParts.join(" ");
      const spinner = ora("Loading wiki context...").start();

      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);
        const pages = pageManager.list(options.scope);

        if (pages.length === 0) {
          spinner.fail(
            chalk.red("No wiki pages found. Run 'ctx ingest' to compile your context.")
          );
          process.exit(1);
        }

        // Load all relevant pages as context
        spinner.text = `Loading ${pages.length} wiki pages...`;
        const contextFiles: Array<{ path: string; content: string }> = [];

        for (const pagePath of pages) {
          const page = pageManager.read(pagePath);
          if (page) {
            contextFiles.push({ path: pagePath, content: page.content });
          }
        }

        // Query Claude
        spinner.text = "Asking Claude...";
        const claude = new ClaudeClient(config.costs?.model ?? "claude-sonnet-4");
        const available = await claude.isAvailable();
        if (!available) {
          spinner.fail(chalk.red("Claude CLI not found."));
          process.exit(1);
        }

        const prompt = `Answer the following question using ONLY the wiki context provided. Cite which wiki page(s) your answer comes from.

## Question
${question}

## Instructions
- Answer based solely on the provided wiki content.
- If the wiki doesn't contain enough information, say so clearly.
- Cite sources as [page-name.md] after relevant statements.
- Be concise but thorough.`;

        const claudeOptions: { maxTokens?: number; systemPrompt: string } = {
          systemPrompt:
            "You are a context-aware assistant. Answer questions using only the provided wiki pages. Always cite your sources.",
        };
        if (options.maxTokens) {
          claudeOptions.maxTokens = parseInt(options.maxTokens, 10);
        }

        const response = await claude.promptWithFiles(
          prompt,
          contextFiles,
          claudeOptions
        );

        spinner.stop();

        // Display the answer
        console.log();
        console.log(chalk.bold.cyan("Answer:"));
        console.log();
        console.log(response.content);
        console.log();

        // Show token usage
        if (response.tokensUsed) {
          console.log(chalk.dim(`Tokens used: ${response.tokensUsed}`));
        }
        console.log(
          chalk.dim(`Based on ${contextFiles.length} wiki page(s)`)
        );

        // Save if requested
        if (options.save) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const slug = question
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 50);
          const savePath = `manual/query-${slug}-${timestamp.slice(0, 10)}.md`;

          const saveContent = `# Q: ${question}

${response.content}

_Query answered: ${new Date().toISOString()}_
_Pages consulted: ${contextFiles.map((f) => f.path).join(", ")}_
`;
          pageManager.write(savePath, saveContent);
          console.log();
          console.log(chalk.green(`Answer saved to ${chalk.bold(savePath)}`));
        }
      } catch (error) {
        spinner.fail(chalk.red("Query failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
