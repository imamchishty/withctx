import type { FastifyInstance, FastifyRequest } from "fastify";
import { PageManager } from "../../wiki/pages.js";
import { ClaudeClient } from "../../claude/client.js";
import { runLint, type LintRuleName } from "../../lint/linter.js";
import { writeLintReportFile } from "../../lint/reporter.js";
import { SourceCacheManager } from "../../storage/sources.js";

interface LintBody {
  rules?: LintRuleName[];
  staleDays?: number;
}

export async function registerLintRoutes(
  fastify: FastifyInstance
): Promise<void> {
  fastify.post(
    "/api/lint",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            rules: {
              type: "array",
              items: {
                type: "string",
                enum: ["contradictions", "stale", "orphan", "missing"],
              },
            },
            staleDays: { type: "number" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              timestamp: { type: "string" },
              pagesChecked: { type: "number" },
              issues: { type: "array" },
              summary: { type: "object" },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: LintBody }>, _reply) => {
      const pm = new PageManager(fastify.ctx);
      const body = request.body ?? {};

      const model = fastify.config.costs?.model ?? "claude-sonnet-4";
      const claude = new ClaudeClient(model, { baseURL: fastify.config.ai?.base_url });

      // Get source freshness for staleness checks
      const sourceCache = new SourceCacheManager(fastify.ctx);
      const sourceFreshness = sourceCache.getSourceFreshnessMap();

      const report = await runLint(pm, {
        rules: body.rules,
        claude,
        staleness: {
          staleDays: body.staleDays,
          sourceFreshness,
        },
      });

      // Write lint report to .ctx/
      writeLintReportFile(report, fastify.ctx);

      return report;
    }
  );
}
