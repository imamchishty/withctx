import { Command } from "commander";
import chalk from "chalk";

interface McpOptions {
  list?: boolean;
}

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Start the MCP (Model Context Protocol) server for AI agent integration")
    .option("--list", "List available MCP tools without starting the server")
    .action(async (options: McpOptions) => {
      try {
        if (options.list) {
          // Import tools to list them
          const { loadConfig, getProjectRoot } = await import(
            "../../config/loader.js"
          );
          const { CtxDirectory } = await import("../../storage/ctx-dir.js");
          const { PageManager } = await import("../../wiki/pages.js");
          const { createTools } = await import("../../mcp/tools.js");

          const config = loadConfig();
          const projectRoot = getProjectRoot();
          const ctxDir = new CtxDirectory(projectRoot);

          if (!ctxDir.exists()) {
            console.error(
              chalk.red("No .ctx/ directory found. Run 'ctx init' first.")
            );
            process.exit(1);
          }

          const pageManager = new PageManager(ctxDir);
          const tools = createTools(pageManager, ctxDir, config);

          console.log(chalk.bold("\nAvailable MCP Tools:\n"));
          for (const tool of tools) {
            console.log(`  ${chalk.cyan(tool.name)}`);
            console.log(`    ${chalk.dim(tool.description)}`);
            const required = (tool.inputSchema as Record<string, unknown>)
              .required as string[] | undefined;
            if (required && required.length > 0) {
              console.log(
                `    ${chalk.dim("Required params:")} ${required.join(", ")}`
              );
            }
            console.log();
          }

          console.log(chalk.dim(`  Total: ${tools.length} tools`));
          console.log();
          console.log(
            chalk.dim(
              '  Run "ctx mcp" to start the server (connects via stdio)'
            )
          );
          console.log();
          return;
        }

        // Start MCP server — dynamic import to avoid loading MCP SDK for other commands
        const { startMcpServer } = await import("../../mcp/server.js");
        await startMcpServer();
      } catch (error) {
        if (error instanceof Error) {
          process.stderr.write(
            chalk.red(`[withctx] MCP error: ${error.message}\n`)
          );
        }
        process.exit(1);
      }
    });
}
