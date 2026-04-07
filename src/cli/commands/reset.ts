import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";

interface ResetOptions {
  force?: boolean;
  reingest?: boolean;
}

async function promptConfirmation(message: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

export function registerResetCommand(program: Command): void {
  program
    .command("reset")
    .description("Delete all compiled wiki pages and optionally re-ingest")
    .option("--force", "Skip confirmation prompt")
    .option("--reingest", "Run full ingest after reset")
    .action(async (options: ResetOptions) => {
      try {
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          console.error(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        // Count existing pages
        const existingPages = ctxDir.listPages();
        const contentPages = existingPages.filter(
          (p) => p !== "index.md" && p !== "log.md"
        );

        if (contentPages.length === 0) {
          console.log(chalk.yellow("No wiki pages to reset."));
          return;
        }

        console.log();
        console.log(chalk.bold("Pages that will be deleted:"));
        for (const page of contentPages) {
          console.log(`  ${chalk.red("x")} ${page}`);
        }
        console.log();
        console.log(chalk.dim(`  index.md and log.md will be preserved.`));
        console.log();

        // Confirm unless --force
        if (!options.force) {
          const confirmed = await promptConfirmation(
            chalk.yellow(`Delete ${contentPages.length} wiki page(s)? This cannot be undone. [y/N] `)
          );
          if (!confirmed) {
            console.log(chalk.dim("Aborted."));
            return;
          }
        }

        const spinner = ora("Resetting wiki pages...").start();

        // Delete all .md files in context/ except index.md and log.md
        let deletedCount = 0;
        for (const page of contentPages) {
          const fullPath = join(ctxDir.contextPath, page);
          if (existsSync(fullPath)) {
            unlinkSync(fullPath);
            deletedCount++;
          }
        }

        // Reset index.md
        ctxDir.writePage(
          "index.md",
          "# Wiki Index\n\n_No pages compiled yet. Run `ctx ingest` to get started._\n"
        );

        // Log the reset
        const logContent = ctxDir.readPage("log.md") ?? "";
        const logEntry = `| ${new Date().toISOString()} | reset | Deleted ${deletedCount} wiki pages${options.reingest ? " (re-ingest pending)" : ""} |`;
        ctxDir.writePage("log.md", logContent + "\n" + logEntry);

        spinner.succeed(
          chalk.green(`Reset complete — deleted ${chalk.bold(String(deletedCount))} wiki page(s)`)
        );

        // Optionally re-ingest
        if (options.reingest) {
          console.log();
          console.log(chalk.dim("Running full ingest..."));
          console.log();

          // Dynamically import and invoke the ingest command
          const { execSync } = await import("node:child_process");
          try {
            execSync("npx ctx ingest", {
              cwd: projectRoot,
              stdio: "inherit",
            });
          } catch {
            console.error(chalk.red("Re-ingest failed. Run 'ctx ingest' manually."));
            process.exit(1);
          }
        }
      } catch (error) {
        console.error(chalk.red("Reset failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
