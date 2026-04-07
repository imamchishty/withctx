import type { FastifyInstance, FastifyRequest } from "fastify";
import { PageManager } from "../../wiki/pages.js";
import { exportClaudeMd } from "../../export/claude-md.js";
import { exportSystemPrompt } from "../../export/system-prompt.js";
import { exportMarkdown } from "../../export/markdown.js";
import type { PackOptions, ExportResult } from "../../types/page.js";

interface PackBody {
  format?: "claude-md" | "system-prompt" | "markdown";
  budget?: number;
  scope?: string;
  query?: string;
  output?: string;
}

export async function registerPackRoutes(
  fastify: FastifyInstance
): Promise<void> {
  fastify.post(
    "/api/pack",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["claude-md", "system-prompt", "markdown"],
            },
            budget: { type: "number" },
            scope: { type: "string" },
            query: { type: "string" },
            output: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              format: { type: "string" },
              content: { type: "string" },
              tokenCount: { type: "number" },
              pagesIncluded: { type: "number" },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: PackBody }>, _reply) => {
      const pm = new PageManager(fastify.ctx);
      const body = request.body ?? {};

      const options: PackOptions = {
        format: body.format ?? "claude-md",
        budget: body.budget,
        scope: body.scope,
        query: body.query,
        output: body.output,
      };

      let result: ExportResult;

      switch (options.format) {
        case "system-prompt":
          result = exportSystemPrompt(pm, options);
          break;
        case "markdown":
          result = exportMarkdown(pm, options);
          break;
        case "claude-md":
        default:
          result = exportClaudeMd(pm, options);
          break;
      }

      return result;
    }
  );
}
