import { Command } from "commander";
import chalk from "chalk";
import { execFileSync } from "node:child_process";
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
          console.error(chalk.red("No .ctx/ directory found. Run 'ctx setup' first."));
          process.exit(1);
        }

        const contextPath = ctxDir.contextPath;

        // Check if git is available and the directory is tracked
        try {
          execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd: projectRoot,
            stdio: "pipe",
          });
        } catch {
          console.error(
            chalk.red("Not a git repository. Diff requires git to track changes.")
          );
          process.exit(1);
        }

        // Run git diff on the context directory. argv form, with a
        // JS-side fallback from `git diff HEAD` to `git diff` so we
        // don't need the `|| ` shell operator. The original `||`
        // pattern was used to cope with fresh repos where HEAD
        // doesn't resolve yet.
        let diffOutput: string;
        const runDiff = (args: string[]): string => {
          try {
            return execFileSync("git", args, {
              cwd: projectRoot,
              encoding: "utf-8",
              maxBuffer: 5 * 1024 * 1024,
              stdio: ["pipe", "pipe", "ignore"],
            });
          } catch {
            return "";
          }
        };
        diffOutput = runDiff(["diff", "HEAD", "--", contextPath]);
        if (!diffOutput) {
          diffOutput = runDiff(["diff", "--", contextPath]);
        }

        // Also check for untracked files
        let untrackedOutput: string;
        try {
          untrackedOutput = execFileSync(
            "git",
            ["ls-files", "--others", "--exclude-standard", "--", contextPath],
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
