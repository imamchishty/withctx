#!/usr/bin/env node

import { startMcpServer } from "./server.js";

startMcpServer().catch((error) => {
  process.stderr.write(
    `[withctx] MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
