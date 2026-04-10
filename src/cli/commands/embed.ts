import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { VectorManager } from "../../vector/index.js";
import type { VectorStoreConfig } from "../../types/vector.js";

interface EmbedOptions {
  provider?: string;
  force?: boolean;
  store?: string;
}

export function registerEmbedCommand(program: Command): void {
  program
    .command("embed")
    .description("Chunk wiki pages and generate vector embeddings for semantic search")
    .option(
      "--provider <provider>",
      "Embedding provider: openai, local (default: auto-detect)"
    )
    .option("--store <store>", "Vector store: chroma, memory (default: auto-detect)")
    .option("--force", "Re-embed all pages, even if unchanged")
    .action(async (options: EmbedOptions) => {
      const spinner = ora("Initializing vector embeddings...").start();

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

        // Build vector store config
        const vectorConfig: Partial<VectorStoreConfig> = {};
        if (options.provider) {
          vectorConfig.embeddingProvider = options.provider as VectorStoreConfig["embeddingProvider"];
        }
        if (options.store) {
          vectorConfig.provider = options.store as VectorStoreConfig["provider"];
        }

        const manager = new VectorManager({ config: vectorConfig, ctxDir });
        await manager.initialize();

        if (options.force) {
          spinner.text = "Embedding all wiki pages (forced)...";
          const stats = await manager.embedAll((page, index, total) => {
            spinner.text = `Embedding [${index + 1}/${total}] ${page}`;
          });

          spinner.succeed(chalk.green("Embedding complete"));
          console.log();
          console.log(chalk.bold("  Embedding Stats:"));
          console.log(`    Pages embedded:    ${chalk.cyan(String(stats.pagesEmbedded))}`);
          console.log(`    Total chunks:      ${chalk.cyan(String(stats.totalChunks))}`);
          console.log(`    Dimensions:        ${chalk.cyan(String(stats.dimensions))}`);
          console.log(`    Store:             ${chalk.cyan(stats.storeType)}`);
          console.log(`    Embedding provider:${chalk.cyan(" " + stats.embeddingProvider)}`);
          console.log(`    Last embedded:     ${chalk.dim(stats.lastEmbeddedAt)}`);
          console.log();
        } else {
          spinner.text = "Refreshing embeddings (incremental)...";
          const result = await manager.refresh((page, index, total) => {
            spinner.text = `Embedding updated page: ${page}`;
          });

          spinner.succeed(chalk.green("Embedding refresh complete"));
          console.log();
          console.log(chalk.bold("  Refresh Stats:"));
          console.log(`    Updated:           ${chalk.cyan(String(result.updated))}`);
          console.log(`    Skipped:           ${chalk.dim(String(result.skipped))}`);
          console.log(`    Total chunks:      ${chalk.cyan(String(result.totalChunks))}`);
          console.log();

          if (result.updated === 0) {
            console.log(
              chalk.dim("  All pages up to date. Use --force to re-embed everything.")
            );
            console.log();
          }
        }
      } catch (error) {
        spinner.fail(chalk.red("Embedding failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
