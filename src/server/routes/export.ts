import type { FastifyInstance, FastifyRequest } from "fastify";
import { PageManager } from "../../wiki/pages.js";
import { ExportManager } from "../../storage/exports.js";
import { exportClaudeMd } from "../../export/claude-md.js";
import { exportSystemPrompt } from "../../export/system-prompt.js";
import { exportMarkdown } from "../../export/markdown.js";
import type { PackOptions, ExportResult } from "../../types/page.js";

interface ExportBody {
  format?: "claude-md" | "system-prompt" | "markdown";
  budget?: number;
  scope?: string;
  snapshot?: boolean;
}

export async function registerExportRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // POST /api/export — generate and save an export
  fastify.post(
    "/api/export",
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
            snapshot: { type: "boolean" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              format: { type: "string" },
              tokenCount: { type: "number" },
              pagesIncluded: { type: "number" },
              exportPath: { type: "string" },
              snapshotPath: { type: "string" },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: ExportBody }>, _reply) => {
      const pm = new PageManager(fastify.ctx);
      const exportMgr = new ExportManager(fastify.ctx);
      exportMgr.initialize();

      const body = request.body ?? {};

      const options: PackOptions = {
        format: body.format ?? "claude-md",
        budget: body.budget,
        scope: body.scope,
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

      // Save to disk
      const shouldSnapshot = body.snapshot ?? true;

      if (shouldSnapshot) {
        const { exportPath, snapshotPath } =
          exportMgr.writeWithSnapshot(result);
        return {
          format: result.format,
          tokenCount: result.tokenCount,
          pagesIncluded: result.pagesIncluded,
          exportPath,
          snapshotPath,
        };
      }

      const exportPath = exportMgr.writeExport(result);
      return {
        format: result.format,
        tokenCount: result.tokenCount,
        pagesIncluded: result.pagesIncluded,
        exportPath,
        snapshotPath: null,
      };
    }
  );
}
