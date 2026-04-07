import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { ClaudeClient } from "../../claude/client.js";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function registerChatCommand(program: Command): void {
  program
    .command("chat")
    .description("Start an interactive chat session with your context wiki")
    .action(async () => {
      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          console.error(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
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

        // Load wiki context
        const contextFiles: Array<{ path: string; content: string }> = [];
        for (const pagePath of pages) {
          const page = pageManager.read(pagePath);
          if (page) {
            contextFiles.push({ path: pagePath, content: page.content });
          }
        }

        const wikiContext = contextFiles
          .map((f) => `--- ${f.path} ---\n${f.content}`)
          .join("\n\n");

        // Check Claude
        const claude = new ClaudeClient(config.costs?.model ?? "claude-sonnet-4");
        const available = await claude.isAvailable();
        if (!available) {
          console.error(chalk.red("Claude CLI not found."));
          process.exit(1);
        }

        // Print header
        console.log();
        console.log(
          chalk.bold.cyan("withctx chat") +
            chalk.dim(` — ${contextFiles.length} wiki pages loaded`)
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
          // Build conversation context
          let conversationContext = "";
          if (history.length > 0) {
            conversationContext = "\n## Conversation History\n";
            // Include last 10 messages for context window management
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
