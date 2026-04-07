import type { FastifyInstance, FastifyRequest } from "fastify";
import { PageManager } from "../../wiki/pages.js";

export async function registerPagesRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // GET /api/pages — list all pages or search
  fastify.get(
    "/api/pages",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            subdir: { type: "string" },
            search: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              pages: { type: "array" },
              count: { type: "number" },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Querystring: { subdir?: string; search?: string };
      }>,
      _reply
    ) => {
      const pm = new PageManager(fastify.ctx);
      const { subdir, search } = request.query;

      if (search) {
        const results = pm.search(search);
        return { pages: results, count: results.length };
      }

      const paths = pm.list(subdir);
      const pages = paths
        .map((p) => pm.read(p))
        .filter((p) => p !== null);

      return { pages, count: pages.length };
    }
  );

  // GET /api/pages/:path — get a single page
  fastify.get(
    "/api/pages/:path",
    {
      schema: {
        params: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              page: { type: "object" },
            },
          },
          404: {
            type: "object",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { path: string } }>,
      reply
    ) => {
      const pm = new PageManager(fastify.ctx);
      // Decode the path parameter (may contain slashes as %2F)
      const pagePath = decodeURIComponent(request.params.path);
      const page = pm.read(pagePath);

      if (!page) {
        reply.status(404);
        return { error: "NotFound", message: `Page "${pagePath}" not found.` };
      }

      return { page };
    }
  );
}
