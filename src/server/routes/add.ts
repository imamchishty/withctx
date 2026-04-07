import type { FastifyInstance, FastifyRequest } from "fastify";
import { PageManager } from "../../wiki/pages.js";

interface AddBody {
  path: string;
  content: string;
  title?: string;
}

export async function registerAddRoutes(
  fastify: FastifyInstance
): Promise<void> {
  fastify.post(
    "/api/add",
    {
      schema: {
        body: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            title: { type: "string" },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              path: { type: "string" },
              message: { type: "string" },
            },
          },
          400: {
            type: "object",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: AddBody }>, reply) => {
      const { path, content, title } = request.body;

      // Validate path
      if (!path.endsWith(".md")) {
        reply.status(400);
        return {
          error: "BadRequest",
          message: "Page path must end with .md",
        };
      }

      if (path.includes("..") || path.startsWith("/")) {
        reply.status(400);
        return {
          error: "BadRequest",
          message: "Page path must be relative and cannot contain '..'",
        };
      }

      const pm = new PageManager(fastify.ctx);

      // Prepend title as H1 if provided and content doesn't start with one
      let pageContent = content;
      if (title && !content.trimStart().startsWith("# ")) {
        pageContent = `# ${title}\n\n${content}`;
      }

      pm.write(path, pageContent);

      reply.status(201);
      return {
        path,
        message: `Page "${path}" created successfully.`,
      };
    }
  );
}
