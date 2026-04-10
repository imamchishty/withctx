import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { VectorManager } from "../../vector/index.js";
import type { VectorStoreConfig } from "../../types/vector.js";

interface SearchOptions {
  limit?: string;
  threshold?: string;
  source?: string;
}

export function registerSearchCommand(program: Command): void {
  program
    .command("search <query>")
    .description("Semantic search across embedded wiki content")
    .option("-n, --limit <n>", "Number of results to show (default: 5)")
    .option(
      "-t, --threshold <score>",
      "Minimum similarity score 0-1 (default: 0)"
    )
    .option(
      "-s, --source <type>",
      "Filter by source type: wiki, source, memory"
    )
    .action(async (query: string, options: SearchOptions) => {
      const spinner = ora("Searching...").start();

      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(
            chalk.red("No .ctx/ directory found. Run 'ctx setup' first.")
          );
          process.exit(1);
        }

        const vectorConfig: Partial<VectorStoreConfig> = {};
        const manager = new VectorManager({ config: vectorConfig, ctxDir });

        const limit = options.limit ? parseInt(options.limit, 10) : 5;
        const threshold = options.threshold
          ? parseFloat(options.threshold)
          : 0;

        const filter: Record<string, string> | undefined = options.source
          ? { sourceType: options.source }
          : undefined;

        const results = await manager.search(query, {
          limit,
          threshold,
          filter,
        });

        spinner.stop();

        if (results.length === 0) {
          console.log();
          console.log(
            chalk.yellow(
              "  No results found. Run 'ctx embed' first to generate embeddings."
            )
          );
          console.log();
          return;
        }

        console.log();
        console.log(
          chalk.bold(`  Search results for: "${query}"`)
        );
        console.log(chalk.dim(`  Showing top ${results.length} results`));
        console.log();

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const scoreColor =
            result.score >= 0.8
              ? chalk.green
              : result.score >= 0.5
                ? chalk.cyan
                : chalk.yellow;

          console.log(
            `  ${chalk.bold(`${i + 1}.`)} ${chalk.cyan(result.chunk.metadata.source)} ${scoreColor(`[${result.score.toFixed(3)}]`)}`
          );

          if (result.chunk.metadata.section) {
            console.log(
              `     ${chalk.dim("Section:")} ${result.chunk.metadata.section}`
            );
          }

          // Show a preview of the content (first 200 chars)
          const preview = result.chunk.content
            .replace(/\n/g, " ")
            .trim()
            .slice(0, 200);
          console.log(`     ${chalk.dim(preview)}${preview.length >= 200 ? "..." : ""}`);
          console.log();
        }
      } catch (error) {
        spinner.fail(chalk.red("Search failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
