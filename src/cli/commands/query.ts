import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import readline from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { createLLMFromCtxConfig } from "../../llm/index.js";
import { recordCall, resolvePricing } from "../../usage/recorder.js";
import { assertWithinBudget, BudgetExceededError } from "../../usage/budget.js";
import { noCtxDirError, noWikiPagesError } from "../../errors.js";
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

// Threshold above which we print a cost estimate + prompt before
// calling the LLM. Below this, the spend is negligible and the prompt
// would just be noise.
const COST_WARN_THRESHOLD = 0.01;

function estimateTokens(text: string): number {
  // Rough heuristic: ~4 chars per token for English text.
  return Math.ceil(text.length / 4);
}

/**
 * Estimate query cost using the central pricing resolver. Picks up
 * any user `ai.pricing` overrides and falls back to Sonnet pricing for
 * unknown models — same behaviour as ctx sync / ingest / costs, so
 * there's exactly one cost story across the CLI.
 */
function estimateCost(inputTokens: number, outputTokens: number, model: string): number {
  const pricing =
    resolvePricing(model) ??
    resolvePricing("claude-sonnet-4") ??
    { input: 3, output: 15 };
  return (
    (inputTokens * pricing.input) / 1_000_000 +
    (outputTokens * pricing.output) / 1_000_000
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
          spinner?.stop();
          throw noCtxDirError();
        }

        const pageManager = new PageManager(ctxDir);
        const topK = options.topK ? Math.max(1, parseInt(options.topK, 10)) : 8;

        // Resolve the model name once up front so every estimateCost
        // call below hits the same pricing row. Priority order matches
        // createLLMFromCtxConfig: per-op override → ai.model → legacy
        // costs.model → built-in default.
        const queryModel =
          config.ai?.models?.query ??
          config.ai?.model ??
          config.costs?.model ??
          "claude-sonnet-4";

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
          // Fallback: full wiki with token cap.
          // Large wikis can exceed model context limits, so we cap at
          // ~100K tokens (~400K chars) and include as many pages as fit.
          retrievalMode = "full";
          if (spinner) spinner.text = "Loading wiki (vector store unavailable — using page selection)...";
          const pages = pageManager.list(options.scope);
          if (pages.length === 0) {
            spinner?.stop();
            throw noWikiPagesError();
          }
          const MAX_CONTEXT_CHARS = 400_000; // ~100K tokens
          let totalChars = 0;
          for (const pagePath of pages) {
            const page = pageManager.read(pagePath);
            if (page) {
              if (totalChars + page.content.length > MAX_CONTEXT_CHARS) {
                // Still add a truncated version if there's room
                const remaining = MAX_CONTEXT_CHARS - totalChars;
                if (remaining > 500) {
                  contextFiles.push({ path: pagePath, content: page.content.slice(0, remaining) + "\n...[truncated — run 'ctx embed' for better results]" });
                  citations.push({ filePath: `.ctx/context/${pagePath}` });
                }
                break;
              }
              contextFiles.push({ path: pagePath, content: page.content });
              citations.push({ filePath: `.ctx/context/${pagePath}` });
              totalChars += page.content.length;
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
        const estCost = estimateCost(estInput, maxOutputTokens, queryModel);

        if (spinner) spinner.stop();

        // Hard budget enforcement — reject the call before it's issued
        // if month-to-date spend + this call would exceed costs.budget.
        try {
          assertWithinBudget(ctxDir, config, estCost, "ctx query");
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            if (raw) console.error(err.message);
            else console.error(chalk.red(err.message));
            process.exit(78);
          }
          throw err;
        }

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

        // --- 4. Call the LLM ---------------------------------------------
        const claude = createLLMFromCtxConfig(config, "query");
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
        // Streaming path: only when the caller actually benefits from
        // live tokens — interactive TTY, vector retrieval (single-turn),
        // no --raw, no --continue, provider supports it. Every other
        // caller (scripts, --json, --raw, multi-turn) uses the batched
        // prompt() path so buffered consumers see the full answer.
        const canStream =
          retrievalMode === "vector" &&
          !options.continue &&
          !raw &&
          process.stdout.isTTY === true &&
          typeof claude.promptStream === "function";

        if (canStream && claude.promptStream) {
          askSpinner?.stop();
          // Render the "Answer" heading up-front so the streaming
          // tokens appear in the same visual block as the non-stream
          // path — users see the same UI with a faster first token.
          heading("Answer");
          console.log();
          const handle = claude.promptStream(userPrompt, {
            systemPrompt,
            maxTokens: maxOutputTokens,
          });
          for await (const chunk of handle.textStream) {
            process.stdout.write(chunk);
          }
          if (!process.stdout.write("\n")) {
            // best-effort drain
          }
          response = await handle.finalResponse;
        } else if (options.continue && history.turns.length > 0) {
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
          askSpinner?.stop();
        } else if (retrievalMode === "full") {
          // Full wiki: use promptWithFiles for prompt caching.
          response = await claude.promptWithFiles(userPrompt, contextFiles, {
            systemPrompt,
            maxTokens: maxOutputTokens,
          });
          askSpinner?.stop();
        } else {
          // Vector mode: chunks are embedded in the prompt directly.
          response = await claude.prompt(userPrompt, {
            systemPrompt,
            maxTokens: maxOutputTokens,
          });
          askSpinner?.stop();
        }

        // --- 5. Render output --------------------------------------------
        if (raw) {
          process.stdout.write(response.content);
          if (!response.content.endsWith("\n")) process.stdout.write("\n");
        } else {
          // Streaming path already rendered the "Answer" heading and
          // the body; skip re-rendering and jump straight to sources +
          // stats.
          if (!canStream) {
            heading("Answer");
            console.log();
            console.log(response.content);
          }
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
            ? estimateCost(
                response.tokensUsed.input,
                response.tokensUsed.output,
                claude.getModel()
              )
            : estCost;
          stats.push(`~$${actualCost.toFixed(4)}`);
          dim(stats.join("  \u00B7  "));
        }

        // Persist call to .ctx/usage.jsonl history.
        if (response.tokensUsed) {
          recordCall(ctxDir, "query", claude.getModel(), {
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
        spinner?.stop();
        // CtxError bubbles up to the global handler in cli/index.ts,
        // which formats it with code + "To fix:" + docs link. Don't
        // swallow it here with a generic "Query failed" ring.
        const { isCtxError } = await import("../../errors.js");
        if (isCtxError(error)) throw error;
        if (error instanceof Error) {
          console.error(chalk.red(`Query failed: ${error.message}`));
        }
        process.exit(1);
      }
    });
}
