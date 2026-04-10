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
import { HashIndex, type SyncIndex, type SyncIndexEntry } from "../../sync/hash-index.js";
import { formatCost, formatDuration } from "../utils/progress.js";
import * as ui from "../utils/ui.js";
import type { RawDocument } from "../../types/source.js";
import { recordCall, recordSnapshot } from "../../usage/recorder.js";

interface SyncOptions {
  source?: string;
  maxTokens?: string;
  dryRun?: boolean;
  force?: boolean;
}

/** Model pricing per million tokens (input/output) */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-haiku-3.5": { input: 0.8, output: 4 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateCost(tokens: number, model: string): { input: number; output: number; total: number } {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4"];
  const inputCost = (tokens / 1_000_000) * pricing.input;
  const estimatedOutputTokens = Math.ceil(tokens * 0.3);
  const outputCost = (estimatedOutputTokens / 1_000_000) * pricing.output;
  return { input: inputCost, output: outputCost, total: inputCost + outputCost };
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
    .option("--dry-run", "Show what would be synced without calling Claude")
    .option("--force", "Ignore hash index and rebuild everything")
    .action(async (options: SyncOptions) => {
      const spinner = ora("Loading configuration...").start();
      const startTime = Date.now();

      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        const syncState = loadSyncState(ctxDir);
        const hashIndex = new HashIndex(ctxDir.path);
        const oldIndex = await hashIndex.load();

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

        // Fetch all documents so we can compute accurate hash diffs.
        // --force bypasses incremental hashing entirely.
        spinner.text = "Fetching documents...";
        const allDocs: RawDocument[] = [];

        for (const connector of connectors) {
          const valid = await connector.validate();
          if (!valid) continue;

          spinner.text = `Fetching ${chalk.cyan(connector.name)}...`;

          try {
            for await (const doc of connector.fetch({})) {
              allDocs.push(doc);
            }
          } catch (error) {
            spinner.warn(
              chalk.yellow(
                `Error syncing ${connector.name}: ${error instanceof Error ? error.message : String(error)}`
              )
            );
          }

          syncState.sources[connector.name] = {
            lastSyncAt: new Date().toISOString(),
            itemCount: allDocs.length,
          };
        }

        // Hash every doc up-front so we can diff against the index.
        const newHashes = new Map<string, string>();
        const docById = new Map<string, RawDocument>();
        for (const doc of allDocs) {
          const hash = hashIndex.hashContent(doc.content);
          newHashes.set(doc.id, hash);
          docById.set(doc.id, doc);
        }

        const diff = options.force
          ? {
              unchanged: [] as string[],
              changed: [] as string[],
              added: Array.from(newHashes.keys()),
              removed: Object.keys(oldIndex.entries),
            }
          : hashIndex.diff(oldIndex, newHashes);

        const docsToCompile: RawDocument[] = [...diff.added, ...diff.changed]
          .map((id) => docById.get(id))
          .filter((d): d is RawDocument => d !== undefined);

        // Determine which wiki pages need rebuilding. A page is considered
        // "affected" if any of its source docs changed, were added, or were removed.
        const affectedPages = new Set<string>();
        for (const id of [...diff.changed, ...diff.added]) {
          const entry = oldIndex.entries[id];
          if (entry) {
            for (const p of entry.wikiPages) affectedPages.add(p);
          }
        }
        for (const id of diff.removed) {
          const entry = oldIndex.entries[id];
          if (entry) {
            for (const p of entry.wikiPages) affectedPages.add(p);
          }
        }

        const pageManager = new PageManager(ctxDir);
        const existingPages = pageManager.list().filter(
          (p) => p !== "index.md" && p !== "log.md"
        );

        // Short-circuit when nothing changed
        if (!options.force && docsToCompile.length === 0 && diff.removed.length === 0) {
          saveSyncState(ctxDir, syncState);
          // Refresh lastSeenAt timestamps on unchanged entries so the index
          // tracks when we last observed each doc.
          const now = new Date().toISOString();
          const refreshedEntries: Record<string, SyncIndexEntry> = { ...oldIndex.entries };
          for (const id of diff.unchanged) {
            const existing = refreshedEntries[id];
            if (existing) {
              refreshedEntries[id] = { ...existing, lastSeenAt: now };
            }
          }
          await hashIndex.save({
            version: 1,
            lastSync: now,
            entries: refreshedEntries,
          });

          spinner.succeed(chalk.green("Everything is up to date — no changes detected."));
          printSyncSummary({
            elapsed: Date.now() - startTime,
            docsUnchanged: diff.unchanged.length,
            docsChanged: 0,
            docsAdded: 0,
            docsRemoved: 0,
            pagesUnchanged: existingPages.length,
            pagesRebuilt: 0,
            pagesNew: 0,
            actualCost: 0,
            fullRebuildCost: estimateCost(
              estimateTokens(allDocs.map((d) => d.content).join("")),
              config.costs?.model ?? "claude-sonnet-4"
            ).total,
          });
          return;
        }

        spinner.succeed(
          `Diff: ${chalk.bold(String(diff.unchanged.length))} unchanged · ${chalk.bold(String(diff.changed.length))} changed · ${chalk.bold(String(diff.added.length))} new · ${chalk.bold(String(diff.removed.length))} removed`
        );

        if (options.dryRun) {
          const model = config.costs?.model ?? "claude-sonnet-4";
          const totalChars = docsToCompile.reduce((sum, doc) => sum + doc.content.length, 0);
          const tokens = estimateTokens(docsToCompile.map(d => d.content).join(""));
          const cost = estimateCost(tokens, model);
          const fullRebuildTokens = estimateTokens(allDocs.map(d => d.content).join(""));
          const fullRebuildCost = estimateCost(fullRebuildTokens, model);

          console.log();
          console.log(chalk.bold("=== Dry Run Report (Sync) ==="));
          console.log();
          console.log(chalk.bold("Documents to recompile:"));
          for (const doc of docsToCompile) {
            const docTokens = estimateTokens(doc.content);
            console.log(
              `  ${chalk.cyan(doc.sourceName)} / ${doc.title}  ${chalk.dim(`(${doc.contentType}, ${doc.content.length} chars, ~${docTokens.toLocaleString()} tokens)`)}`
            );
          }
          console.log();
          console.log(chalk.bold("Summary:"));
          console.log(`  Documents:          ${chalk.dim(String(diff.unchanged.length))} unchanged  ·  ${chalk.yellow(String(diff.changed.length))} changed  ·  ${chalk.green(String(diff.added.length))} new  ·  ${chalk.red(String(diff.removed.length))} removed`);
          console.log(`  Total characters:   ${chalk.cyan(totalChars.toLocaleString())}`);
          console.log(`  Estimated tokens:   ${chalk.cyan(tokens.toLocaleString())}`);
          console.log(`  Model:              ${chalk.cyan(model)}`);
          console.log(`  Est. incremental:   ${chalk.green(formatCost(cost.total))}`);
          console.log(`  Est. full rebuild:  ${chalk.dim(formatCost(fullRebuildCost.total))}`);
          console.log(`  Est. savings:       ${chalk.bold.green(formatCost(Math.max(0, fullRebuildCost.total - cost.total)))}`);
          console.log();
          if (affectedPages.size > 0) {
            console.log(chalk.bold("Wiki pages to rebuild:"));
            for (const page of affectedPages) {
              console.log(`  ${chalk.yellow(page)}`);
            }
            console.log();
          }
          console.log(chalk.dim("Run without --dry-run to execute."));
          return;
        }

        // Check Claude availability
        const claude = new ClaudeClient(config.costs?.model ?? "claude-sonnet-4");
        const available = await claude.isAvailable();
        if (!available) {
          ora().fail(chalk.red("Claude CLI not found."));
          process.exit(1);
        }

        // Load only the affected wiki pages for context (plus a minimal list
        // of unaffected pages so Claude knows what not to touch).
        const affectedContent = Array.from(affectedPages)
          .map((p) => {
            const page = pageManager.read(p);
            return page ? `--- Existing: ${p} ---\n${page.content}` : "";
          })
          .filter(Boolean)
          .join("\n\n");

        const unaffectedPages = existingPages.filter((p) => !affectedPages.has(p));

        // Build prompt for incremental update
        const syncSpinner = ora("Updating affected wiki pages with Claude...").start();

        let prompt = `You are a context wiki maintainer. Update the existing wiki pages with new/changed source documents.

## Instructions
1. Review the changed documents below.
2. Update the affected wiki pages shown below, or create new ones as needed.
3. Do NOT rewrite pages that are not affected — only output pages that actually need changes.
4. Preserve content from unchanged sources.
5. Add source attribution for new content.

## Output Format
For each page to create or update:

---PAGE: <filename.md>---
<full page content>
---END PAGE---

Only output pages that need changes. Include an updated index.md if the set of pages changed.

## Affected Wiki Pages
${affectedContent || "(none)"}

## Unaffected Pages (do not output these)
${unaffectedPages.join(", ") || "(none)"}

## Changed Source Documents
`;

        for (const doc of docsToCompile) {
          prompt += `\n### ${doc.sourceName} / ${doc.title} [id=${doc.id}]\n`;
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

        const response = docsToCompile.length > 0
          ? await claude.prompt(prompt, claudeOptions)
          : { content: "", tokensUsed: undefined };

        // Parse and write updated pages
        const pagePattern = /---PAGE:\s*(.+?)---\n([\s\S]*?)---END PAGE---/g;
        let match;
        const rebuiltPagePaths = new Set<string>();
        const newPagePaths = new Set<string>();
        const existingSet = new Set(existingPages);

        while ((match = pagePattern.exec(response.content)) !== null) {
          const pagePath = match[1].trim();
          const pageContent = match[2].trim();
          pageManager.write(pagePath, pageContent);
          if (existingSet.has(pagePath)) {
            rebuiltPagePaths.add(pagePath);
          } else {
            newPagePaths.add(pagePath);
          }
        }

        // Build the new hash index.
        // - unchanged docs: keep their old wikiPages
        // - changed/added docs: associate with all pages just written
        // - removed docs: drop from the index
        const now = new Date().toISOString();
        const newEntries: Record<string, SyncIndexEntry> = {};

        const writtenPages = [...rebuiltPagePaths, ...newPagePaths];

        for (const id of diff.unchanged) {
          const existing = oldIndex.entries[id];
          if (existing) {
            newEntries[id] = { ...existing, lastSeenAt: now };
          }
        }
        for (const id of diff.changed) {
          newEntries[id] = {
            documentId: id,
            contentHash: newHashes.get(id) ?? "",
            lastSeenAt: now,
            wikiPages: writtenPages.length > 0
              ? writtenPages
              : oldIndex.entries[id]?.wikiPages ?? [],
          };
        }
        for (const id of diff.added) {
          newEntries[id] = {
            documentId: id,
            contentHash: newHashes.get(id) ?? "",
            lastSeenAt: now,
            wikiPages: writtenPages,
          };
        }
        // Removed docs are simply not included in newEntries.

        const newSyncIndex: SyncIndex = {
          version: 1,
          lastSync: now,
          entries: newEntries,
        };
        await hashIndex.save(newSyncIndex);

        // Save sync state
        saveSyncState(ctxDir, syncState);

        // Update log
        const logContent = ctxDir.readPage("log.md") ?? "";
        const logEntry = `| ${now} | sync | Synced ${docsToCompile.length} changed docs, updated ${rebuiltPagePaths.size + newPagePaths.size} pages |`;
        ctxDir.writePage("log.md", logContent + "\n" + logEntry);

        syncSpinner.succeed(
          `Updated ${chalk.bold(String(rebuiltPagePaths.size + newPagePaths.size))} wiki page(s) from ${chalk.bold(String(docsToCompile.length))} changed document(s)`
        );

        // Compute actual cost from Claude response if available.
        const model = config.costs?.model ?? "claude-sonnet-4";
        let actualCost = 0;
        if (response.tokensUsed) {
          const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4"];
          actualCost =
            (response.tokensUsed.input / 1_000_000) * pricing.input +
            (response.tokensUsed.output / 1_000_000) * pricing.output;
          // Persist the call to .ctx/usage.jsonl history.
          recordCall(ctxDir, "sync", model, {
            input: response.tokensUsed.input,
            output: response.tokensUsed.output,
            cacheRead: response.tokensUsed.cacheRead ?? 0,
            cacheWrite: response.tokensUsed.cacheCreation ?? 0,
          });
        } else {
          const tokens = estimateTokens(docsToCompile.map((d) => d.content).join(""));
          actualCost = estimateCost(tokens, model).total;
        }

        // Snapshot wiki state for growth charts (best-effort).
        try {
          const wikiPages = ctxDir.listPages();
          let bytes = 0;
          for (const p of wikiPages) {
            const content = ctxDir.readPage(p);
            if (content) bytes += Buffer.byteLength(content);
          }
          recordSnapshot(ctxDir, {
            sourceDocs: allDocs.length,
            wikiPages: wikiPages.length,
            bytes,
          });
        } catch {
          // best-effort
        }

        const fullRebuildTokens = estimateTokens(allDocs.map((d) => d.content).join(""));
        const fullRebuildCost = estimateCost(fullRebuildTokens, model).total;

        printSyncSummary({
          elapsed: Date.now() - startTime,
          docsUnchanged: diff.unchanged.length,
          docsChanged: diff.changed.length,
          docsAdded: diff.added.length,
          docsRemoved: diff.removed.length,
          pagesUnchanged: unaffectedPages.length,
          pagesRebuilt: rebuiltPagePaths.size,
          pagesNew: newPagePaths.size,
          actualCost,
          fullRebuildCost,
        });
      } catch (error) {
        spinner.fail(chalk.red("Sync failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}

interface SyncSummaryInput {
  elapsed: number;
  docsUnchanged: number;
  docsChanged: number;
  docsAdded: number;
  docsRemoved: number;
  pagesUnchanged: number;
  pagesRebuilt: number;
  pagesNew: number;
  actualCost: number;
  fullRebuildCost: number;
}

function printSyncSummary(input: SyncSummaryInput): void {
  const savings = Math.max(0, input.fullRebuildCost - input.actualCost);

  console.log();
  ui.subheading(`Sync complete in ${formatDuration(input.elapsed)}`);
  console.log(
    `  Documents:  ${chalk.dim(`${input.docsUnchanged} unchanged`)}  ${chalk.dim("\u00B7")}  ${chalk.yellow(`${input.docsChanged} updated`)}  ${chalk.dim("\u00B7")}  ${chalk.green(`${input.docsAdded} new`)}  ${chalk.dim("\u00B7")}  ${chalk.red(`${input.docsRemoved} removed`)}`
  );
  console.log(
    `  Wiki pages: ${chalk.dim(`${input.pagesUnchanged} unchanged`)}  ${chalk.dim("\u00B7")}  ${chalk.yellow(`${input.pagesRebuilt} rebuilt`)}  ${chalk.dim("\u00B7")}  ${chalk.green(`${input.pagesNew} new`)}`
  );
  if (input.fullRebuildCost > 0) {
    console.log(
      `  Cost:       ${chalk.green(formatCost(input.actualCost))} ${chalk.dim(`(vs ${formatCost(input.fullRebuildCost)} full rebuild — saved ${formatCost(savings)})`)}`
    );
  } else {
    console.log(`  Cost:       ${chalk.green(formatCost(input.actualCost))}`);
  }
  console.log();
}
