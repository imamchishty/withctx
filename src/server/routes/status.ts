import type { FastifyInstance } from "fastify";
import { PageManager } from "../../wiki/pages.js";
import { SourceCacheManager } from "../../storage/sources.js";
import { CostTracker } from "../../costs/tracker.js";

export async function registerStatusRoutes(
  fastify: FastifyInstance
): Promise<void> {
  fastify.get(
    "/api/status",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              project: { type: "string" },
              initialized: { type: "boolean" },
              pages: { type: "object" },
              sources: { type: "object" },
              costs: { type: "object" },
            },
          },
        },
      },
    },
    async (_request, _reply) => {
      const pm = new PageManager(fastify.ctx);
      const sourceCache = new SourceCacheManager(fastify.ctx);
      const costTracker = new CostTracker(fastify.ctx, {
        budget: fastify.config.costs?.budget,
        alertAt: fastify.config.costs?.alert_at,
      });

      // Page stats
      const allPages = pm.list();
      const index = pm.getIndex();

      // Source stats
      const sourceMeta = sourceCache.getAllSourceMeta();

      // Cost stats
      const budgetInfo = costTracker.checkBudget();
      const monthCost = costTracker.getCurrentMonthCost();

      return {
        project: fastify.config.project,
        initialized: fastify.ctx.exists(),
        pages: {
          total: allPages.length,
          indexed: index.length,
          paths: allPages,
        },
        sources: {
          count: Object.keys(sourceMeta).length,
          details: sourceMeta,
        },
        costs: {
          currentMonth: monthCost,
          budget: fastify.config.costs?.budget ?? null,
          budgetUsed: budgetInfo?.percentUsed ?? null,
          alert: budgetInfo?.alert ?? false,
        },
      };
    }
  );
}
