import { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";

export function registerDiffCommand(program: Command): void {
  program
    .command("diff")
    .description("Show wiki changes since last sync (git diff on .ctx/context/)")
    .action(async () => {
      try {
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          console.error(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        const contextPath = ctxDir.contextPath;

        // Check if git is available and the directory is tracked
        try {
          execSync("git rev-parse --is-inside-work-tree", {
            cwd: projectRoot,
            stdio: "pipe",
          });
        } catch {
          console.error(
            chalk.red("Not a git repository. Diff requires git to track changes.")
          );
          process.exit(1);
        }

        // Run git diff on the context directory
        let diffOutput: string;
        try {
          // Show both staged and unstaged changes
          diffOutput = execSync(
            `git diff HEAD -- "${contextPath}" 2>/dev/null || git diff -- "${contextPath}" 2>/dev/null`,
            {
              cwd: projectRoot,
              encoding: "utf-8",
              maxBuffer: 5 * 1024 * 1024,
            }
          );
        } catch {
          diffOutput = "";
        }

        // Also check for untracked files
        let untrackedOutput: string;
        try {
          untrackedOutput = execSync(
            `git ls-files --others --exclude-standard "${contextPath}"`,
            {
              cwd: projectRoot,
              encoding: "utf-8",
            }
          );
        } catch {
          untrackedOutput = "";
        }

        if (!diffOutput.trim() && !untrackedOutput.trim()) {
          console.log(chalk.green("No changes to wiki since last commit."));
          return;
        }

        // Display diff with colors
        if (diffOutput.trim()) {
          console.log(chalk.bold("Wiki changes:"));
          console.log();

          const lines = diffOutput.split("\n");
          for (const line of lines) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
              console.log(chalk.green(line));
            } else if (line.startsWith("-") && !line.startsWith("---")) {
              console.log(chalk.red(line));
            } else if (line.startsWith("@@")) {
              console.log(chalk.cyan(line));
            } else if (line.startsWith("diff ") || line.startsWith("index ")) {
              console.log(chalk.dim(line));
            } else {
              console.log(line);
            }
          }
        }

        // Show untracked files
        if (untrackedOutput.trim()) {
          console.log();
          console.log(chalk.bold("New (untracked) wiki pages:"));
          const files = untrackedOutput.trim().split("\n");
          for (const file of files) {
            console.log(chalk.green(`  + ${file}`));
          }
        }

        console.log();
      } catch (error) {
        console.error(chalk.red("Diff failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
