import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import readline from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { ClaudeClient } from "../../claude/client.js";
import { recordCall } from "../../usage/recorder.js";
import { VectorManager } from "../../vector/index.js";
import type { SearchResult, VectorStoreConfig } from "../../types/vector.js";
import { heading, dim, success, divider } from "../utils/ui.js";

interface QueryOptions {
  save?: boolean;
  scope?: string;
  maxTokens?: string;
  topK?: string;
  continue?: boolean;
  yes?: boolean;
  raw?: boolean;
}

interface SourceCitation {
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
}

interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
  sources?: SourceCitation[];
  timestamp: string;
}

interface QueryHistory {
  turns: HistoryTurn[];
}

const HISTORY_FILE = ".query-history.json";
const MAX_HISTORY_TURNS = 6;

// Rough pricing per 1M tokens for Sonnet-class models (input/output).
const INPUT_COST_PER_1M = 3.0;
const OUTPUT_COST_PER_1M = 15.0;
const COST_WARN_THRESHOLD = 0.01;

function estimateTokens(text: string): number {
  // Rough heuristic: ~4 chars per token for English text.
  return Math.ceil(text.length / 4);
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * INPUT_COST_PER_1M) / 1_000_000 +
    (outputTokens * OUTPUT_COST_PER_1M) / 1_000_000
  );
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      // Default yes on empty.
      resolve(trimmed === "" || trimmed === "y" || trimmed === "yes");
    });
  });
}

function loadHistory(ctxDir: CtxDirectory): QueryHistory {
  const path = join(ctxDir.path, HISTORY_FILE);
  if (!existsSync(path)) return { turns: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && Array.isArray(parsed.turns)) return parsed;
  } catch {
    // Corrupted — start fresh.
  }
  return { turns: [] };
}

function saveHistory(ctxDir: CtxDirectory, history: QueryHistory): void {
  const path = join(ctxDir.path, HISTORY_FILE);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Keep only the last MAX_HISTORY_TURNS turns.
  const trimmed: QueryHistory = {
    turns: history.turns.slice(-MAX_HISTORY_TURNS),
  };
  writeFileSync(path, JSON.stringify(trimmed, null, 2));
}

/**
 * Compute the line range (1-indexed, inclusive) where a chunk's content
 * appears in the given source text. Returns undefined if it can't be located.
 */
function computeLineRange(
  sourceText: string,
  chunkContent: string
): { lineStart: number; lineEnd: number } | undefined {
  // Try to match the first non-empty line of the chunk.
  const chunkLines = chunkContent.split("\n").map((l) => l.trimEnd());
  let firstMeaningful = chunkLines.findIndex((l) => l.trim().length > 0);
  if (firstMeaningful < 0) return undefined;

  const sourceLines = sourceText.split("\n");
  const needle = chunkLines[firstMeaningful];

  for (let i = 0; i < sourceLines.length; i++) {
    if (sourceLines[i].trimEnd() === needle) {
      const lineStart = i + 1 - firstMeaningful;
      const lineEnd = lineStart + chunkLines.length - 1;
      return {
        lineStart: Math.max(1, lineStart),
        lineEnd: Math.min(sourceLines.length, Math.max(1, lineEnd)),
      };
    }
  }
  return undefined;
}

/**
 * Attempt vector retrieval; returns null if the store is empty or init fails.
 */
async function tryVectorRetrieval(
  ctxDir: CtxDirectory,
  question: string,
  topK: number
): Promise<SearchResult[] | null> {
  try {
    const vectorConfig: Partial<VectorStoreConfig> = {};
    const manager = new VectorManager({ config: vectorConfig, ctxDir });
    const stats = await manager.getStats();
    if (!stats.totalChunks || stats.totalChunks === 0) return null;
    const results = await manager.search(question, { limit: topK });
    if (results.length === 0) return null;
    return results;
  } catch {
    return null;
  }
}

function deriveCitations(
  results: SearchResult[],
  pageManager: PageManager
): { chunks: Array<{ path: string; content: string }>; citations: SourceCitation[] } {
  const chunks: Array<{ path: string; content: string }> = [];
  const citations: SourceCitation[] = [];
  // Dedupe citations per (file, lineStart, lineEnd).
  const seen = new Set<string>();

  for (const r of results) {
    const source = r.chunk.metadata.source;
    const page = pageManager.read(source);
    const pageText = page?.content ?? "";
    const range = pageText ? computeLineRange(pageText, r.chunk.content) : undefined;

    const citation: SourceCitation = {
      filePath: `.ctx/context/${source}`,
      ...(range && { lineStart: range.lineStart, lineEnd: range.lineEnd }),
    };

    const key = `${citation.filePath}:${citation.lineStart ?? ""}:${citation.lineEnd ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push(citation);
    }

    chunks.push({
      path: source,
      content: r.chunk.content,
    });
  }

  return { chunks, citations };
}

function formatCitation(c: SourceCitation): string {
  if (c.lineStart !== undefined && c.lineEnd !== undefined) {
    return `${c.filePath}:${c.lineStart}-${c.lineEnd}`;
  }
  return c.filePath;
}

export function registerQueryCommand(program: Command): void {
  program
    .command("query")
    .description("Ask a question against the compiled wiki")
    .argument("<question...>", "Your question")
    .option("--save", "Save the answer as a wiki page")
    .option("--scope <dir>", "Limit to a specific wiki subdirectory")
    .option("--max-tokens <n>", "Max tokens for response")
    .option("-k, --top-k <n>", "Top-K vector chunks to retrieve (default: 8)")
    .option("-c, --continue", "Continue the previous query conversation")
    .option("-y, --yes", "Skip cost confirmation prompt")
    .option("--raw", "Output just the answer text (no formatting)")
    .action(async (questionParts: string[], options: QueryOptions) => {
      const question = questionParts.join(" ");
      const raw = options.raw === true;
      const spinner = raw ? null : ora("Loading context...").start();

      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner?.fail(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          if (raw) console.error("No .ctx/ directory found. Run 'ctx init' first.");
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);
        const topK = options.topK ? Math.max(1, parseInt(options.topK, 10)) : 8;

        // --- 1. Vector-first retrieval (with graceful fallback) -----------
        let contextFiles: Array<{ path: string; content: string }> = [];
        let citations: SourceCitation[] = [];
        let retrievalMode: "vector" | "full" = "vector";

        if (spinner) spinner.text = "Retrieving relevant chunks...";
        const vectorResults = await tryVectorRetrieval(ctxDir, question, topK);

        if (vectorResults) {
          const derived = deriveCitations(vectorResults, pageManager);
          contextFiles = derived.chunks;
          citations = derived.citations;
          retrievalMode = "vector";
        } else {
          // Fallback: full wiki (original behavior).
          retrievalMode = "full";
          if (spinner) spinner.text = "Loading full wiki (vector store unavailable)...";
          const pages = pageManager.list(options.scope);
          if (pages.length === 0) {
            spinner?.fail(
              chalk.red("No wiki pages found. Run 'ctx ingest' to compile your context.")
            );
            if (raw)
              console.error("No wiki pages found. Run 'ctx ingest' to compile your context.");
            process.exit(1);
          }
          for (const pagePath of pages) {
            const page = pageManager.read(pagePath);
            if (page) {
              contextFiles.push({ path: pagePath, content: page.content });
              citations.push({ filePath: `.ctx/context/${pagePath}` });
            }
          }
        }

        // --- 2. Build prior-turn messages if --continue -------------------
        const history = options.continue ? loadHistory(ctxDir) : { turns: [] };

        // --- 3. Cost preview ---------------------------------------------
        const contextBlob = contextFiles.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
        const historyBlob = history.turns.map((t) => t.content).join("\n");
        const maxOutputTokens = options.maxTokens ? parseInt(options.maxTokens, 10) : 1500;
        const estInput = estimateTokens(contextBlob + historyBlob + question) + 200;
        const estCost = estimateCost(estInput, maxOutputTokens);

        if (spinner) spinner.stop();

        if (!raw && estCost > COST_WARN_THRESHOLD && !options.yes) {
          console.log();
          console.log(
            chalk.yellow(
              `Estimated cost: ~$${estCost.toFixed(2)} (input: ${formatTokens(estInput)} tokens, output: ~${formatTokens(maxOutputTokens)}).`
            )
          );
          const ok = await promptYesNo(chalk.bold("Continue? [Y/n] "));
          if (!ok) {
            console.log(chalk.dim("Cancelled."));
            return;
          }
        }

        // --- 4. Call Claude ----------------------------------------------
        const queryModel = config.costs?.model ?? "claude-sonnet-4-20250514";
        const claude = new ClaudeClient(queryModel);
        const askSpinner = raw ? null : ora("Asking Claude...").start();

        const systemPrompt =
          "You are a context-aware assistant. Answer questions using only the provided wiki content. Be concise but thorough. Cite sources inline using [source-name.md] notation.";

        const userPrompt =
          retrievalMode === "vector"
            ? `Use ONLY the following retrieved wiki chunks to answer the question. Each chunk is labelled with its source path.

## Retrieved Chunks
${contextFiles.map((f, i) => `### Chunk ${i + 1}: ${f.path}\n${f.content}`).join("\n\n")}

## Question
${question}

## Instructions
- Answer based solely on the retrieved chunks.
- If the chunks don't contain enough information, say so clearly.
- Cite sources as [filename.md] after relevant statements.
- Be concise but thorough.`
            : `Answer the following question using ONLY the wiki context provided. Cite which wiki page(s) your answer comes from.

## Question
${question}

## Instructions
- Answer based solely on the provided wiki content.
- If the wiki doesn't contain enough information, say so clearly.
- Cite sources as [page-name.md] after relevant statements.
- Be concise but thorough.`;

        let response;
        if (options.continue && history.turns.length > 0) {
          // Multi-turn: build conversation with prior turns + current.
          const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
          for (const turn of history.turns) {
            messages.push({ role: turn.role, content: turn.content });
          }
          // Embed the retrieved chunks in the current user turn.
          messages.push({ role: "user", content: userPrompt });
          response = await claude.conversation(messages, {
            systemPrompt,
            maxTokens: maxOutputTokens,
          });
        } else if (retrievalMode === "full") {
          // Full wiki: use promptWithFiles for prompt caching.
          response = await claude.promptWithFiles(userPrompt, contextFiles, {
            systemPrompt,
            maxTokens: maxOutputTokens,
          });
        } else {
          // Vector mode: chunks are embedded in the prompt directly.
          response = await claude.prompt(userPrompt, {
            systemPrompt,
            maxTokens: maxOutputTokens,
          });
        }

        askSpinner?.stop();

        // --- 5. Render output --------------------------------------------
        if (raw) {
          process.stdout.write(response.content);
          if (!response.content.endsWith("\n")) process.stdout.write("\n");
        } else {
          heading("Answer");
          console.log();
          console.log(response.content);
          console.log();

          if (citations.length > 0) {
            console.log(chalk.bold("Sources:"));
            for (const c of citations) {
              console.log(`  ${chalk.dim("\u2192")} ${chalk.cyan(formatCitation(c))}`);
            }
            console.log();
          }

          console.log(divider());
          const stats: string[] = [];
          stats.push(
            retrievalMode === "vector"
              ? `${contextFiles.length} vector chunk(s)`
              : `${contextFiles.length} wiki page(s) (full scan)`
          );
          if (response.tokensUsed) {
            stats.push(
              `tokens: ${response.tokensUsed.input} in, ${response.tokensUsed.output} out`
            );
          }
          const actualCost = response.tokensUsed
            ? estimateCost(response.tokensUsed.input, response.tokensUsed.output)
            : estCost;
          stats.push(`~$${actualCost.toFixed(4)}`);
          dim(stats.join("  \u00B7  "));
        }

        // Persist call to .ctx/usage.jsonl history.
        if (response.tokensUsed) {
          recordCall(ctxDir, "query", queryModel, {
            input: response.tokensUsed.input,
            output: response.tokensUsed.output,
            cacheRead: response.tokensUsed.cacheRead ?? 0,
            cacheWrite: response.tokensUsed.cacheCreation ?? 0,
          });
        }

        // --- 6. Persist history ------------------------------------------
        const newHistory: QueryHistory = {
          turns: [
            ...history.turns,
            {
              role: "user",
              content: question,
              timestamp: new Date().toISOString(),
            },
            {
              role: "assistant",
              content: response.content,
              sources: citations,
              timestamp: new Date().toISOString(),
            },
          ],
        };
        saveHistory(ctxDir, newHistory);

        // --- 7. Save as wiki page if requested ---------------------------
        if (options.save) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const slug = question
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 50);
          const savePath = `manual/query-${slug}-${timestamp.slice(0, 10)}.md`;

          const sourcesBlock = citations.map((c) => `- ${formatCitation(c)}`).join("\n");
          const saveContent = `# Q: ${question}

${response.content}

## Sources
${sourcesBlock}

_Query answered: ${new Date().toISOString()}_
`;
          pageManager.write(savePath, saveContent);
          if (!raw) {
            console.log();
            success(`Answer saved to ${chalk.bold(savePath)}`);
          }
        }
      } catch (error) {
        spinner?.fail(chalk.red("Query failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
