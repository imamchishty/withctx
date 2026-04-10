import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { resolve, relative } from "node:path";
import { getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import {
  scanForTodos,
  summariseTodos,
  renderTodosMarkdown,
} from "../../todos/scanner.js";

interface TodosOptions {
  path?: string;
  markers?: string;
  limit?: string;
  write?: boolean;
  json?: boolean;
}

/**
 * `ctx todos` — scan the current project (or a given path) for
 * TODO/FIXME/HACK/XXX/BUG/OPTIMIZE markers and either print them or
 * write them to `.ctx/context/todos.md` so they become part of the
 * compiled wiki.
 *
 * Intentionally zero LLM calls — this is a mechanical scanner, fast
 * enough to run on a pre-commit hook.
 */
export function registerTodosCommand(program: Command): void {
  program
    .command("todos")
    .description("Scan code for TODO/FIXME/HACK markers and add them to the wiki")
    .option("--path <dir>", "Directory to scan (defaults to project root)")
    .option(
      "--markers <list>",
      "Comma-separated markers to look for (defaults to TODO,FIXME,HACK,XXX,BUG,OPTIMIZE)"
    )
    .option("--limit <n>", "Stop after finding N items")
    .option("--write", "Write report to .ctx/context/todos.md", false)
    .option("--json", "Emit JSON instead of a table", false)
    .action((options: TodosOptions) => {
      const spinner = ora("Scanning for TODOs...").start();

      try {
        let rootDir: string;
        if (options.path) {
          rootDir = resolve(options.path);
        } else {
          try {
            rootDir = getProjectRoot();
          } catch {
            rootDir = resolve(process.cwd());
          }
        }

        const markers = options.markers
          ?.split(",")
          .map((m) => m.trim().toUpperCase())
          .filter(Boolean);

        const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;

        const items = scanForTodos(rootDir, {
          ...(markers && markers.length > 0 && { markers }),
          ...(limit && Number.isFinite(limit) && { limit }),
        });

        spinner.succeed(
          chalk.green(
            `Found ${items.length} marker${items.length === 1 ? "" : "s"} in ${relative(process.cwd(), rootDir) || "."}`
          )
        );

        if (options.json) {
          console.log(JSON.stringify(items, null, 2));
          return;
        }

        if (items.length === 0) {
          console.log();
          console.log(chalk.dim("  No TODOs found."));
          console.log();
          return;
        }

        // Pretty summary
        const summary = summariseTodos(items);
        console.log();
        console.log(chalk.bold("  Summary:"));
        for (const marker of Object.keys(summary).sort()) {
          console.log(`    ${chalk.cyan(marker.padEnd(10))} ${summary[marker]}`);
        }
        console.log();

        // Show first 20 by default
        const preview = items.slice(0, 20);
        console.log(chalk.bold(`  First ${preview.length}:`));
        for (const item of preview) {
          const text = item.text || chalk.dim("(no description)");
          console.log(
            `    ${chalk.dim(`${item.file}:${item.line}`)} ${chalk.yellow(item.marker)} ${text}`
          );
        }
        if (items.length > preview.length) {
          console.log(chalk.dim(`    ... and ${items.length - preview.length} more`));
        }
        console.log();

        if (options.write) {
          try {
            const projectRoot = getProjectRoot();
            const ctxDir = new CtxDirectory(projectRoot);
            if (!ctxDir.exists()) {
              console.log(
                chalk.yellow(
                  "  .ctx/ directory not found — run 'ctx init' first to enable --write."
                )
              );
              return;
            }
            const markdown = renderTodosMarkdown(items, {
              rootLabel: relative(projectRoot, rootDir) || ".",
            });
            ctxDir.writePage("todos.md", markdown);
            console.log(
              chalk.green("  Wrote ") + chalk.bold(".ctx/context/todos.md")
            );
            console.log();
          } catch (error) {
            console.log(
              chalk.yellow(
                `  Could not write todos.md: ${error instanceof Error ? error.message : String(error)}`
              )
            );
          }
        } else {
          console.log(
            chalk.dim("  Tip: ") +
              "run " +
              chalk.bold("ctx todos --write") +
              chalk.dim(" to save this to the wiki.")
          );
          console.log();
        }
      } catch (error) {
        spinner.fail(chalk.red("TODO scan failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
