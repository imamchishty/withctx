import { Command } from "commander";
import chalk from "chalk";
import { watch as fsWatch, existsSync, statSync } from "node:fs";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { createLLMFromCtxConfig } from "../../llm/index.js";
import { ConnectorRegistry } from "../../connectors/registry.js";
import { LocalFilesConnector } from "../../connectors/local-files.js";
import { safeResolve } from "../../security/paths.js";
import type { RawDocument } from "../../types/source.js";

interface WatchOptions {
  interval?: string;
  maxTokens?: string;
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function syncSource(
  sourceName: string,
  sourcePath: string,
  config: ReturnType<typeof loadConfig>,
  ctxDir: CtxDirectory
): Promise<void> {
  const registry = new ConnectorRegistry();
  registry.register(new LocalFilesConnector(sourceName, sourcePath));

  const connector = registry.get(sourceName);
  if (!connector) return;

  const valid = await connector.validate();
  if (!valid) {
    console.log(chalk.yellow(`  [${timestamp()}] Source '${sourceName}' validation failed — skipping`));
    return;
  }

  const docs: RawDocument[] = [];
  // Fetch only recently changed (last 30 seconds as a buffer)
  const since = new Date(Date.now() - 30_000);
  try {
    for await (const doc of connector.fetch({ since })) {
      docs.push(doc);
    }
  } catch (error) {
    console.log(chalk.red(`  [${timestamp()}] Error fetching from ${sourceName}: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }

  if (docs.length === 0) {
    console.log(chalk.dim(`  [${timestamp()}] No new content from ${sourceName}`));
    return;
  }

  console.log(chalk.cyan(`  [${timestamp()}] ${docs.length} changed document(s) from ${sourceName}`));

  // Check Claude availability
  const claude = createLLMFromCtxConfig(config, "watch");
  const available = await claude.isAvailable();
  if (!available) {
    console.log(chalk.red(`  [${timestamp()}] Claude API not available — skipping compilation`));
    return;
  }

  const pageManager = new PageManager(ctxDir);
  const existingPages = pageManager.list().filter(
    (p) => p !== "index.md" && p !== "log.md"
  );
  const existingContent = existingPages
    .map((p) => {
      const page = pageManager.read(p);
      return page ? `--- Existing: ${p} ---\n${page.content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  let prompt = `You are a context wiki maintainer. Update the existing wiki pages with new/changed source documents.

## Instructions
1. Review the changed documents below.
2. Update relevant existing wiki pages or create new ones as needed.
3. Preserve existing content that hasn't changed.
4. Add source attribution for new content.

## Output Format
For each page to create or update:

---PAGE: <filename.md>---
<full page content>
---END PAGE---

Only output pages that need changes. Include an updated index.md.

## Existing Wiki Pages
${existingContent}

## Changed Source Documents
`;

  for (const doc of docs) {
    prompt += `\n### ${doc.sourceName} / ${doc.title}\n`;
    const content =
      doc.content.length > 6000
        ? doc.content.slice(0, 6000) + "\n...[truncated]"
        : doc.content;
    prompt += `${content}\n`;
  }

  const claudeOptions: { maxTokens?: number; systemPrompt: string } = {
    systemPrompt:
      "You are a technical wiki maintainer. Update existing pages with new information. Preserve existing content.",
  };

  try {
    const response = await claude.prompt(prompt, claudeOptions);

    const pagePattern = /---PAGE:\s*(.+?)---\n([\s\S]*?)---END PAGE---/g;
    let match;
    let updatedCount = 0;

    while ((match = pagePattern.exec(response.content)) !== null) {
      const pagePath = match[1].trim();
      const pageContent = match[2].trim();
      pageManager.write(pagePath, pageContent);
      updatedCount++;
    }

    // Update log
    const logContent = ctxDir.readPage("log.md") ?? "";
    const logEntry = `| ${new Date().toISOString()} | watch-sync | Auto-synced ${docs.length} changed docs from ${sourceName}, updated ${updatedCount} pages |`;
    ctxDir.writePage("log.md", logContent + "\n" + logEntry);

    console.log(chalk.green(`  [${timestamp()}] Updated ${updatedCount} wiki page(s)`));
  } catch (error) {
    console.log(chalk.red(`  [${timestamp()}] Claude compilation failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}

export function registerWatchCommand(program: Command): void {
  program
    .command("watch")
    .description("Watch local sources for changes and auto-sync into the wiki")
    .option("--interval <seconds>", "Polling interval in seconds (alternative to fs.watch)", "0")
    .option("--max-tokens <n>", "Max tokens for Claude response")
    .action(async (options: WatchOptions) => {
      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          console.error(chalk.red("No .ctx/ directory found. Run 'ctx setup' first."));
          process.exit(1);
        }

        const localSources = config.sources?.local ?? [];
        if (localSources.length === 0) {
          console.error(chalk.red("No local sources configured in ctx.yaml."));
          process.exit(1);
        }

        console.log(chalk.bold("ctx watch") + chalk.dim(" — watching for changes..."));
        console.log();

        // Track debounce timers per source
        const debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
        const DEBOUNCE_MS = 2000;

        const pollingInterval = parseInt(options.interval ?? "0", 10);

        if (pollingInterval > 0) {
          // Polling mode
          console.log(chalk.dim(`  Polling every ${pollingInterval}s`));
          for (const source of localSources) {
            console.log(`  ${chalk.cyan(source.name)} ${chalk.dim(`(${source.path})`)}`);
          }
          console.log();

          const interval = setInterval(async () => {
            for (const source of localSources) {
              const resolvedPath = safeResolve(source.path, projectRoot);
              if (resolvedPath === null) continue;
              await syncSource(source.name, resolvedPath, config, ctxDir);
            }
          }, pollingInterval * 1000);

          // Graceful shutdown
          const cleanup = () => {
            console.log();
            console.log(chalk.dim("Stopping watch..."));
            clearInterval(interval);
            process.exit(0);
          };
          process.on("SIGINT", cleanup);
          process.on("SIGTERM", cleanup);
        } else {
          // fs.watch mode
          console.log(chalk.dim("  Using filesystem events (debounce: 2s)"));
          for (const source of localSources) {
            console.log(`  ${chalk.cyan(source.name)} ${chalk.dim(`(${source.path})`)}`);
          }
          console.log();

          const watchers: ReturnType<typeof fsWatch>[] = [];

          for (const source of localSources) {
            const resolvedPath = safeResolve(source.path, projectRoot);
            if (resolvedPath === null) {
              console.log(
                chalk.yellow(
                  `  Skipping ${source.name} — path "${source.path}" escapes the project root`
                )
              );
              continue;
            }

            if (!existsSync(resolvedPath)) {
              console.log(chalk.yellow(`  Skipping ${source.name} — path does not exist: ${resolvedPath}`));
              continue;
            }

            const stat = statSync(resolvedPath);
            if (!stat.isDirectory()) {
              console.log(chalk.yellow(`  Skipping ${source.name} — not a directory: ${resolvedPath}`));
              continue;
            }

            try {
              const watcher = fsWatch(resolvedPath, { recursive: true }, (eventType, filename) => {
                if (!filename) return;
                // Ignore .ctx directory and common non-content files
                if (filename.includes(".ctx") || filename.includes("node_modules") || filename.includes(".git")) {
                  return;
                }

                const relativeName = String(filename);
                console.log(
                  chalk.dim(`  [${timestamp()}] ${eventType}: ${source.name}/${relativeName}`)
                );

                // Debounce: wait 2s after last change before syncing
                const existing = debounceTimers.get(source.name);
                if (existing) clearTimeout(existing);

                debounceTimers.set(
                  source.name,
                  setTimeout(async () => {
                    debounceTimers.delete(source.name);
                    console.log(chalk.cyan(`  [${timestamp()}] Syncing ${source.name}...`));
                    await syncSource(source.name, resolvedPath, config, ctxDir);
                  }, DEBOUNCE_MS)
                );
              });

              watchers.push(watcher);
            } catch (error) {
              console.log(chalk.yellow(`  Could not watch ${source.name}: ${error instanceof Error ? error.message : String(error)}`));
            }
          }

          // Graceful shutdown
          const cleanup = () => {
            console.log();
            console.log(chalk.dim("Stopping watch..."));
            for (const watcher of watchers) {
              watcher.close();
            }
            for (const timer of debounceTimers.values()) {
              clearTimeout(timer);
            }
            process.exit(0);
          };
          process.on("SIGINT", cleanup);
          process.on("SIGTERM", cleanup);

          // Keep process alive
          console.log(chalk.dim("  Press Ctrl+C to stop."));
          console.log();
        }
      } catch (error) {
        console.error(chalk.red("Watch failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
