import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(
  fastify: FastifyInstance
): Promise<void> {
  fastify.get(
    "/api/health",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              timestamp: { type: "string" },
              version: { type: "string" },
            },
          },
        },
      },
    },
    async (_request, _reply) => {
      return {
        status: "ok",
        timestamp: new Date().toISOString(),
        version: "0.1.0",
      };
    }
  );
}
