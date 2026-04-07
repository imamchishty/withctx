import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { ClaudeClient } from "../../claude/client.js";
import { ConnectorRegistry } from "../../connectors/registry.js";
import { LocalFilesConnector } from "../../connectors/local-files.js";
import type { RawDocument } from "../../types/source.js";

interface SyncOptions {
  source?: string;
  maxTokens?: string;
}

interface SyncState {
  sources: Record<string, { lastSyncAt: string; itemCount: number }>;
}

function loadSyncState(ctxDir: CtxDirectory): SyncState {
  const statePath = join(ctxDir.path, "sync-state.json");
  if (existsSync(statePath)) {
    return JSON.parse(readFileSync(statePath, "utf-8")) as SyncState;
  }
  return { sources: {} };
}

function saveSyncState(ctxDir: CtxDirectory, state: SyncState): void {
  const statePath = join(ctxDir.path, "sync-state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function registerSyncCommand(program: Command): void {
  program
    .command("sync")
    .description("Incrementally sync changed sources into the wiki")
    .option("--source <name>", "Sync a specific source only")
    .option("--max-tokens <n>", "Max tokens for Claude response")
    .action(async (options: SyncOptions) => {
      const spinner = ora("Loading configuration...").start();

      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        const syncState = loadSyncState(ctxDir);

        // Build connectors
        const registry = new ConnectorRegistry();
        if (config.sources?.local) {
          for (const source of config.sources.local) {
            if (options.source && source.name !== options.source) continue;
            const resolvedPath = source.path.startsWith(".")
              ? `${projectRoot}/${source.path}`
              : source.path;
            registry.register(new LocalFilesConnector(source.name, resolvedPath));
          }
        }

        const connectors = registry.getAll();
        if (connectors.length === 0) {
          spinner.fail(
            chalk.red(
              options.source
                ? `Source '${options.source}' not found in config.`
                : "No sources configured."
            )
          );
          process.exit(1);
        }

        // Fetch only changed documents
        spinner.text = "Fetching changed documents...";
        const changedDocs: RawDocument[] = [];

        for (const connector of connectors) {
          const valid = await connector.validate();
          if (!valid) continue;

          const sourceState = syncState.sources[connector.name];
          const since = sourceState ? new Date(sourceState.lastSyncAt) : undefined;

          spinner.text = `Syncing ${chalk.cyan(connector.name)}${since ? chalk.dim(` (since ${sourceState.lastSyncAt})`) : ""}...`;

          try {
            for await (const doc of connector.fetch({ since })) {
              changedDocs.push(doc);
            }
          } catch (error) {
            spinner.warn(
              chalk.yellow(
                `Error syncing ${connector.name}: ${error instanceof Error ? error.message : String(error)}`
              )
            );
          }

          // Update sync state for this source
          syncState.sources[connector.name] = {
            lastSyncAt: new Date().toISOString(),
            itemCount: changedDocs.length,
          };
        }

        if (changedDocs.length === 0) {
          saveSyncState(ctxDir, syncState);
          spinner.succeed(chalk.green("Everything is up to date — no changes detected."));
          return;
        }

        spinner.succeed(`Found ${chalk.bold(String(changedDocs.length))} changed document(s)`);

        // Check Claude availability
        const claude = new ClaudeClient(config.costs?.model ?? "claude-sonnet-4");
        const available = await claude.isAvailable();
        if (!available) {
          spinner.fail(chalk.red("Claude CLI not found."));
          process.exit(1);
        }

        // Load existing wiki for context
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

        // Build prompt for incremental update
        const syncSpinner = ora("Updating wiki pages with Claude...").start();

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

        for (const doc of changedDocs) {
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
        if (options.maxTokens) {
          claudeOptions.maxTokens = parseInt(options.maxTokens, 10);
        }

        const response = await claude.prompt(prompt, claudeOptions);

        // Parse and write updated pages
        const pagePattern = /---PAGE:\s*(.+?)---\n([\s\S]*?)---END PAGE---/g;
        let match;
        let updatedCount = 0;

        while ((match = pagePattern.exec(response.content)) !== null) {
          const pagePath = match[1].trim();
          const pageContent = match[2].trim();
          pageManager.write(pagePath, pageContent);
          updatedCount++;
        }

        // Save sync state
        saveSyncState(ctxDir, syncState);

        // Update log
        const logContent = ctxDir.readPage("log.md") ?? "";
        const logEntry = `| ${new Date().toISOString()} | sync | Synced ${changedDocs.length} changed docs, updated ${updatedCount} pages |`;
        ctxDir.writePage("log.md", logContent + "\n" + logEntry);

        syncSpinner.succeed(
          `Updated ${chalk.bold(String(updatedCount))} wiki page(s) from ${chalk.bold(String(changedDocs.length))} changed document(s)`
        );

        console.log();
        for (const connector of connectors) {
          const state = syncState.sources[connector.name];
          if (state) {
            console.log(
              `  ${chalk.cyan(connector.name)}: last synced ${chalk.dim(state.lastSyncAt)}`
            );
          }
        }
        console.log();
      } catch (error) {
        spinner.fail(chalk.red("Sync failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
