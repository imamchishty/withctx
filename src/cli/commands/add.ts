import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { readFileSync } from "node:fs";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { ClaudeClient } from "../../claude/client.js";
import { runInteractiveSourceAdd, SOURCE_TYPE_NAMES } from "./sources-interactive.js";

type NoteType = "note" | "decision" | "convention" | "context" | "correction";

interface AddOptions {
  file?: string;
  type?: NoteType;
  tag?: string;
}

export function registerAddCommand(program: Command): void {
  program
    .command("add")
    .description("Add a note, decision, convention, or correction to the wiki — or 'ctx add <source-type>' to add a source")
    .argument("[text...]", "Text to add (or use --file). Use a source type name (confluence, jira, github, slack, notion, local) to add a source.")
    .option("--file <path>", "Read content from a file")
    .option(
      "--type <type>",
      "Type: note, decision, convention, context, correction",
      "note"
    )
    .option("--tag <tag>", "Tag for categorization")
    .action(async (textParts: string[], options: AddOptions) => {
      // Check if first argument is a source type — delegate to interactive source add
      if (
        textParts.length >= 1 &&
        (SOURCE_TYPE_NAMES as readonly string[]).includes(textParts[0].toLowerCase())
      ) {
        const sourceType = textParts[0].toLowerCase();
        const pathArg = textParts[1]; // e.g. "ctx add local ./my-docs"
        await runInteractiveSourceAdd(sourceType, pathArg);
        return;
      }

      const spinner = ora("Processing...").start();

      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        // Get the text to add
        let text: string;
        if (options.file) {
          try {
            text = readFileSync(options.file, "utf-8");
          } catch {
            spinner.fail(chalk.red(`Could not read file: ${options.file}`));
            process.exit(1);
          }
        } else if (textParts.length > 0) {
          text = textParts.join(" ");
        } else {
          spinner.fail(chalk.red("No text provided. Usage: ctx add \"your text\" or ctx add --file path"));
          process.exit(1);
        }

        const noteType = options.type ?? "note";

        // Load existing wiki pages
        const pageManager = new PageManager(ctxDir);
        const existingPages = pageManager.list().filter(
          (p) => p !== "index.md" && p !== "log.md"
        );

        const existingContent = existingPages
          .map((p) => {
            const page = pageManager.read(p);
            return page ? `--- ${p} ---\n${page.content}` : "";
          })
          .filter(Boolean)
          .join("\n\n");

        // Build Claude prompt
        spinner.text = "Integrating into wiki with Claude...";

        const typeInstructions: Record<NoteType, string> = {
          note: "Add this note to the most relevant wiki page(s). Create a new page if no existing page fits.",
          decision:
            "Record this as an architectural/design decision. Add it to a decisions page or the most relevant technical page. Include rationale if provided.",
          convention:
            "Record this as a team convention or standard. Add it to a conventions page or create one. Make it clear this is a team agreement.",
          context:
            "Add this as background context. Integrate it into the most relevant page(s), providing additional understanding.",
          correction:
            "This is a CORRECTION that overrides previous information. Find the relevant page(s) and update them. Mark the corrected information clearly. This takes priority over existing source content.",
        };

        let prompt = `You are a context wiki editor. ${typeInstructions[noteType]}

## New ${noteType.toUpperCase()}
${text}
${options.tag ? `\nTag: ${options.tag}` : ""}

## Output Format
For each page to create or update:

---PAGE: <filename.md>---
<full page content>
---END PAGE---

Include an updated index.md if you created a new page.

## Existing Wiki Pages
${existingContent || "No existing pages yet."}
`;

        const claude = new ClaudeClient(config.costs?.model ?? "claude-sonnet-4", { baseURL: config.ai?.base_url });
        const available = await claude.isAvailable();
        if (!available) {
          spinner.fail(chalk.red("Claude CLI not found."));
          process.exit(1);
        }

        const response = await claude.prompt(prompt, {
          systemPrompt:
            "You are a wiki editor. Integrate the provided content into the wiki. Output only the pages that need changes.",
        });

        // Parse and write pages
        const pagePattern = /---PAGE:\s*(.+?)---\n([\s\S]*?)---END PAGE---/g;
        let match;
        let updatedCount = 0;
        const affectedPages: string[] = [];

        while ((match = pagePattern.exec(response.content)) !== null) {
          const pagePath = match[1].trim();
          const pageContent = match[2].trim();
          pageManager.write(pagePath, pageContent);
          affectedPages.push(pagePath);
          updatedCount++;
        }

        if (updatedCount === 0) {
          // Fallback: save as manual note
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const manualPath = `manual/${noteType}-${timestamp}.md`;
          const manualContent = `# ${noteType.charAt(0).toUpperCase() + noteType.slice(1)}${options.tag ? ` [${options.tag}]` : ""}

${text}

_Added: ${new Date().toISOString()}_
`;
          pageManager.write(manualPath, manualContent);
          affectedPages.push(manualPath);
          updatedCount = 1;
        }

        // Update log
        const logContent = ctxDir.readPage("log.md") ?? "";
        const logEntry = `| ${new Date().toISOString()} | add | Added ${noteType}: ${text.slice(0, 60)}${text.length > 60 ? "..." : ""} |`;
        ctxDir.writePage("log.md", logContent + "\n" + logEntry);

        spinner.succeed(chalk.green(`${noteType.charAt(0).toUpperCase() + noteType.slice(1)} added successfully`));

        console.log();
        console.log(chalk.bold("  Pages affected:"));
        for (const page of affectedPages) {
          console.log(`    ${chalk.cyan(page)}`);
        }
        console.log();
      } catch (error) {
        spinner.fail(chalk.red("Failed to add content"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
