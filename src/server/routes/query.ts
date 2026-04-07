import type { FastifyInstance, FastifyRequest } from "fastify";
import { PageManager } from "../../wiki/pages.js";
import { ClaudeClient } from "../../claude/client.js";
import type { QueryResult } from "../../types/page.js";

interface QueryBody {
  question: string;
  scope?: string;
  maxPages?: number;
}

export async function registerQueryRoutes(
  fastify: FastifyInstance
): Promise<void> {
  fastify.post(
    "/api/query",
    {
      schema: {
        body: {
          type: "object",
          required: ["question"],
          properties: {
            question: { type: "string" },
            scope: { type: "string" },
            maxPages: { type: "number" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              answer: { type: "string" },
              sources: { type: "array" },
              tokenCount: { type: "number" },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: QueryBody }>, _reply) => {
      const pm = new PageManager(fastify.ctx);
      const { question, scope, maxPages } = request.body;

      // Find relevant pages by keyword search
      const searchResults = pm.search(question);
      const limit = maxPages ?? 10;
      const relevant = searchResults.slice(0, limit);

      if (relevant.length === 0) {
        return {
          answer:
            "No relevant pages found in the wiki for this question.",
          sources: [],
          tokenCount: 0,
        } satisfies QueryResult;
      }

      // Build context from relevant pages
      const files = relevant.map((page) => ({
        path: page.path,
        content: page.content,
      }));

      const model = fastify.config.costs?.model ?? "claude-sonnet-4";
      const claude = new ClaudeClient(model);

      const response = await claude.promptWithFiles(
        `Answer this question using the wiki pages provided as context. Be concise and cite the page paths when referencing information.\n\nQuestion: ${question}`,
        files,
        { maxTokens: 2048 }
      );

      const result: QueryResult = {
        answer: response.content,
        sources: relevant.map((page, idx) => ({
          page: page.path,
          relevance: 1 - idx * 0.1, // Simple decreasing relevance
        })),
        tokenCount: response.tokensUsed ?? 0,
      };

      return result;
    }
  );
}
