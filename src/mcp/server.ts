import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, getProjectRoot } from "../config/loader.js";
import { CtxDirectory } from "../storage/ctx-dir.js";
import { PageManager } from "../wiki/pages.js";
import { createTools, type ToolDefinition } from "./tools.js";

/**
 * Create and configure the MCP server.
 */
export function createMcpServer(): {
  server: Server;
  tools: ToolDefinition[];
} {
  const config = loadConfig();
  const projectRoot = getProjectRoot();
  const ctxDir = new CtxDirectory(projectRoot);

  if (!ctxDir.exists()) {
    throw new Error("No .ctx/ directory found. Run 'ctx init' first.");
  }

  const pageManager = new PageManager(ctxDir);
  const tools = createTools(pageManager, ctxDir, config);

  const server = new Server(
    {
      name: "withctx",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // Register tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `Unknown tool: ${name}` }),
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(args ?? {});
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  });

  return { server, tools };
}

/**
 * Start the MCP server on stdio transport.
 */
export async function startMcpServer(): Promise<void> {
  const { server, tools } = createMcpServer();

  // Print info to stderr (stdout is reserved for MCP protocol)
  const toolNames = tools.map((t) => t.name).join(", ");
  process.stderr.write(
    `[withctx] MCP server starting with ${tools.length} tools: ${toolNames}\n`
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("[withctx] MCP server connected via stdio\n");
}
