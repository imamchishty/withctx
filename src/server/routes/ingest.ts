import type { FastifyInstance, FastifyRequest } from "fastify";
import { PageManager } from "../../wiki/pages.js";
import { ClaudeClient } from "../../claude/client.js";
import { SourceCacheManager } from "../../storage/sources.js";
import type { SourceType } from "../../types/source.js";

interface IngestBody {
  source?: string;
  type?: SourceType;
  content?: string;
  title?: string;
  force?: boolean;
}

export async function registerIngestRoutes(
  fastify: FastifyInstance
): Promise<void> {
  fastify.post(
    "/api/ingest",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            source: { type: "string" },
            type: { type: "string" },
            content: { type: "string" },
            title: { type: "string" },
            force: { type: "boolean" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              pagesCreated: { type: "number" },
              pagesUpdated: { type: "number" },
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
    async (request: FastifyRequest<{ Body: IngestBody }>, reply) => {
      const body = request.body ?? {};

      // Direct content ingestion mode
      if (body.content) {
        return await ingestDirectContent(fastify, body);
      }

      // Source-based ingestion
      if (!body.source) {
        reply.status(400);
        return {
          error: "BadRequest",
          message:
            "Provide either 'content' for direct ingestion or 'source' for source-based ingestion.",
        };
      }

      // For now, return a placeholder for source-based ingestion
      // The actual connector-based ingestion would be wired up here
      return {
        pagesCreated: 0,
        pagesUpdated: 0,
        message: `Source-based ingestion for "${body.source}" is not yet wired to connectors. Use direct content ingestion or the CLI.`,
      };
    }
  );
}

async function ingestDirectContent(
  fastify: FastifyInstance,
  body: IngestBody
): Promise<{ pagesCreated: number; pagesUpdated: number; message: string }> {
  const pm = new PageManager(fastify.ctx);
  const model = fastify.config.costs?.model ?? "claude-sonnet-4";
  const claude = new ClaudeClient(model);

  const title = body.title ?? "Untitled Document";
  const content = body.content ?? "";

  // Use Claude to compile the raw content into a wiki page
  const response = await claude.prompt(
    `You are a technical writer. Convert the following raw content into a clean wiki page in Markdown format.
The page should have:
- A clear title (H1)
- Well-organized sections
- Key facts and decisions highlighted
- Links to related concepts where appropriate (use .md extension)

Title hint: ${title}

Raw content:
${content.slice(0, 8000)}

Output ONLY the markdown content, nothing else.`,
    { maxTokens: 4096 }
  );

  // Determine page path
  const pagePath = slugify(title) + ".md";
  const existing = pm.read(pagePath);

  pm.write(pagePath, response.content);

  // Update source cache
  const sourceCache = new SourceCacheManager(fastify.ctx);
  sourceCache.updateSyncTime(
    body.source ?? "direct",
    body.type ?? "local",
    1
  );

  return {
    pagesCreated: existing ? 0 : 1,
    pagesUpdated: existing ? 1 : 0,
    message: `Ingested content as "${pagePath}".`,
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}
