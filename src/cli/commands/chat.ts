import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { createLLMFromCtxConfig } from "../../llm/index.js";
import { VectorManager } from "../../vector/index.js";
import type { VectorStoreConfig, SearchResult } from "../../types/vector.js";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

async function tryVectorSearch(
  ctxDir: CtxDirectory,
  question: string,
  topK: number,
): Promise<Array<{ path: string; content: string }> | null> {
  try {
    const vectorConfig: Partial<VectorStoreConfig> = {};
    const manager = new VectorManager({ config: vectorConfig, ctxDir });
    const stats = await manager.getStats();
    if (!stats.totalChunks || stats.totalChunks === 0) return null;
    const results = await manager.search(question, { limit: topK });
    if (results.length === 0) return null;
    return results.map((r: SearchResult) => ({
      path: r.chunk.metadata.source,
      content: r.chunk.content,
    }));
  } catch {
    return null;
  }
}

export function registerChatCommand(program: Command): void {
  program
    .command("chat")
    .description("Start an interactive chat session with your context wiki")
    .option("--top-k <n>", "Number of wiki chunks to retrieve per question (default 10)")
    .action(async (options: { topK?: string }) => {
      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);
        const topK = options.topK ? Math.max(1, parseInt(options.topK, 10)) : 10;

        if (!ctxDir.exists()) {
          console.error(chalk.red("No .ctx/ directory found. Run 'ctx setup' first."));
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);
        const pages = pageManager.list();

        if (pages.length === 0) {
          console.error(
            chalk.red("No wiki pages found. Run 'ctx ingest' first.")
          );
          process.exit(1);
        }

        // Check if vector search is available
        const hasVectors = await tryVectorSearch(ctxDir, "test", 1) !== null;

        // If no vectors, load wiki with token cap
        let staticContext = "";
        if (!hasVectors) {
          const MAX_CHARS = 400_000; // ~100K tokens
          let totalChars = 0;
          const contextFiles: Array<{ path: string; content: string }> = [];
          for (const pagePath of pages) {
            const page = pageManager.read(pagePath);
            if (page) {
              if (totalChars + page.content.length > MAX_CHARS) break;
              contextFiles.push({ path: pagePath, content: page.content });
              totalChars += page.content.length;
            }
          }
          staticContext = contextFiles
            .map((f) => `--- ${f.path} ---\n${f.content}`)
            .join("\n\n");
        }

        // Check Claude
        const claude = createLLMFromCtxConfig(config, "chat");
        const available = await claude.isAvailable();
        if (!available) {
          console.error(chalk.red("Claude CLI not found."));
          process.exit(1);
        }

        // Print header
        console.log();
        console.log(
          chalk.bold.cyan("withctx chat") +
            chalk.dim(` — ${pages.length} wiki pages, ${hasVectors ? "vector search" : "capped context"}`)
        );
        console.log(chalk.dim("Commands: /save <filename> — save last answer | /exit — quit"));
        console.log(chalk.dim("─".repeat(60)));
        console.log();

        // Start REPL
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
          prompt: chalk.green("you > "),
        });

        const history: ChatMessage[] = [];
        let lastAnswer = "";

        const askQuestion = async (question: string): Promise<string> => {
          // Get relevant context per question via vector search
          let wikiContext: string;
          if (hasVectors) {
            const chunks = await tryVectorSearch(ctxDir, question, topK);
            if (chunks && chunks.length > 0) {
              wikiContext = chunks
                .map((c, i) => `### Chunk ${i + 1}: ${c.path}\n${c.content}`)
                .join("\n\n");
            } else {
              wikiContext = staticContext;
            }
          } else {
            wikiContext = staticContext;
          }

          // Build conversation context
          let conversationContext = "";
          if (history.length > 0) {
            conversationContext = "\n## Conversation History\n";
            const recentHistory = history.slice(-10);
            for (const msg of recentHistory) {
              conversationContext += `\n${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}\n`;
            }
          }

          const prompt = `Answer the following question using the wiki context provided. Cite wiki page sources in [brackets].
${conversationContext}
## Current Question
${question}

## Wiki Context
${wikiContext}`;

          const response = await claude.prompt(prompt, {
            systemPrompt:
              "You are a helpful context assistant. Answer questions using the wiki. Cite sources as [page.md]. Be concise.",
          });

          return response.content;
        };

        rl.prompt();

        rl.on("line", async (line: string) => {
          const input = line.trim();

          if (!input) {
            rl.prompt();
            return;
          }

          // Handle commands
          if (input === "/exit" || input === "/quit") {
            console.log(chalk.dim("\nGoodbye!"));
            rl.close();
            process.exit(0);
          }

          if (input.startsWith("/save")) {
            if (!lastAnswer) {
              console.log(chalk.yellow("No answer to save yet."));
              rl.prompt();
              return;
            }

            const parts = input.split(/\s+/);
            const filename =
              parts[1] ??
              `chat-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`;
            const savePath = filename.endsWith(".md") ? filename : `${filename}.md`;

            const saveContent = `# Chat Answer

${lastAnswer}

_Saved from chat session: ${new Date().toISOString()}_
`;
            pageManager.write(`manual/${savePath}`, saveContent);
            console.log(chalk.green(`Saved to manual/${savePath}`));
            rl.prompt();
            return;
          }

          // Process question
          history.push({ role: "user", content: input });

          process.stdout.write(chalk.dim("thinking..."));

          try {
            const answer = await askQuestion(input);
            lastAnswer = answer;
            history.push({ role: "assistant", content: answer });

            // Clear "thinking..." and print answer
            process.stdout.write("\r" + " ".repeat(20) + "\r");
            console.log();
            console.log(chalk.cyan("ctx > ") + answer);
            console.log();
          } catch (error) {
            process.stdout.write("\r" + " ".repeat(20) + "\r");
            console.log(
              chalk.red(
                `Error: ${error instanceof Error ? error.message : String(error)}`
              )
            );
          }

          rl.prompt();
        });

        rl.on("close", () => {
          process.exit(0);
        });
      } catch (error) {
        console.error(chalk.red("Chat initialization failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
