import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPagesRoutes } from "./routes/pages.js";
import { registerQueryRoutes } from "./routes/query.js";
import { registerPackRoutes } from "./routes/pack.js";
import { registerAddRoutes } from "./routes/add.js";
import { registerLintRoutes } from "./routes/lint.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerStatusRoutes } from "./routes/status.js";
import { registerExportRoutes } from "./routes/export.js";
import type { CtxDirectory } from "../storage/ctx-dir.js";
import type { CtxConfig } from "../types/config.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  ctx: CtxDirectory;
  config: CtxConfig;
}

/**
 * Create and configure the Fastify server.
 */
export async function createServer(
  options: ServerOptions
): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: true,
  });

  // CORS support
  fastify.addHook("onRequest", async (request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS"
    );
    reply.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );

    if (request.method === "OPTIONS") {
      reply.status(204).send();
    }
  });

  // Decorate fastify with shared context
  fastify.decorate("ctx", options.ctx);
  fastify.decorate("config", options.config);

  // Global error handler
  fastify.setErrorHandler(async (error, request, reply) => {
    fastify.log.error(error);

    const err = error as { statusCode?: number; name?: string; message?: string };
    const statusCode = err.statusCode ?? 500;
    reply.status(statusCode).send({
      error: err.name ?? "InternalServerError",
      message: err.message ?? "An unexpected error occurred.",
      statusCode,
    });
  });

  // Register routes
  await registerHealthRoutes(fastify);
  await registerPagesRoutes(fastify);
  await registerQueryRoutes(fastify);
  await registerPackRoutes(fastify);
  await registerAddRoutes(fastify);
  await registerLintRoutes(fastify);
  await registerIngestRoutes(fastify);
  await registerStatusRoutes(fastify);
  await registerExportRoutes(fastify);

  return fastify;
}

/**
 * Start the server.
 */
export async function startServer(options: ServerOptions): Promise<void> {
  const fastify = await createServer(options);
  const port = options.port ?? 4040;
  const host = options.host ?? "127.0.0.1";

  try {
    await fastify.listen({ port, host });
    fastify.log.info(`withctx server listening on http://${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// Augment Fastify types
declare module "fastify" {
  interface FastifyInstance {
    ctx: CtxDirectory;
    config: CtxConfig;
  }
}
