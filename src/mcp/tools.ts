import type { PageManager } from "../wiki/pages.js";
import type { CtxDirectory } from "../storage/ctx-dir.js";
import type { CtxConfig } from "../types/config.js";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * Tool definition with JSON Schema for MCP protocol.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Create all MCP tool definitions.
 */
export function createTools(
  pageManager: PageManager,
  ctxDir: CtxDirectory,
  config: CtxConfig
): ToolDefinition[] {
  return [
    {
      name: "search_context",
      description:
        "Search across compiled wiki knowledge. Returns matching pages with content snippets and relevance.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query to match against wiki page content and titles",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default: 5)",
            default: 5,
          },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const query = args.query as string;
        const limit = (args.limit as number) ?? 5;
        const results = pageManager.search(query);

        return results.slice(0, limit).map((page) => ({
          content: page.content.slice(0, 500),
          source: page.path,
          relevance: calculateRelevance(page.content, page.title, query),
        }));
      },
    },

    {
      name: "get_page",
      description:
        'Retrieve a specific wiki page by its path. Returns the full page content as markdown.',
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Relative path to the wiki page, e.g. "overview.md" or "repos/api-service/overview.md"',
          },
        },
        required: ["path"],
      },
      handler: async (args) => {
        const pagePath = args.path as string;
        const page = pageManager.read(pagePath);
        if (!page) {
          return { error: `Page not found: ${pagePath}` };
        }
        return {
          path: page.path,
          title: page.title,
          content: page.content,
          updatedAt: page.updatedAt,
        };
      },
    },

    {
      name: "get_architecture",
      description:
        "Return the architecture overview for the project. Falls back to overview.md if architecture.md doesn't exist.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const page =
          pageManager.read("architecture.md") ??
          pageManager.read("overview.md");
        if (!page) {
          return {
            error:
              "No architecture.md or overview.md found. Run 'ctx ingest' to generate wiki pages.",
          };
        }
        return { content: page.content, source: page.path };
      },
    },

    {
      name: "get_conventions",
      description: "Return the coding conventions for the project.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const page = pageManager.read("conventions.md");
        if (!page) {
          return { error: "No conventions.md found. Run 'ctx ingest' to generate wiki pages." };
        }
        return { content: page.content, source: page.path };
      },
    },

    {
      name: "get_decisions",
      description: "Return decision records (ADRs) for the project.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const page = pageManager.read("decisions.md");
        if (!page) {
          return { error: "No decisions.md found. Run 'ctx ingest' to generate wiki pages." };
        }
        return { content: page.content, source: page.path };
      },
    },

    {
      name: "get_faq",
      description: "Return the FAQ for the project.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const page = pageManager.read("faq.md");
        if (!page) {
          return { error: "No faq.md found. Run 'ctx ingest' to generate wiki pages." };
        }
        return { content: page.content, source: page.path };
      },
    },

    {
      name: "list_pages",
      description: "List all wiki pages with their paths and titles.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const pagePaths = pageManager.list();
        return pagePaths.map((p) => {
          const page = pageManager.read(p);
          return {
            path: p,
            title: page?.title ?? basename(p, ".md"),
          };
        });
      },
    },

    {
      name: "list_sources",
      description:
        "Show what data sources have been configured in ctx.yaml, including their types and names.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const sources: Array<{ name: string; type: string }> = [];
        if (config.sources?.local) {
          for (const s of config.sources.local)
            sources.push({ name: s.name, type: "local" });
        }
        if (config.sources?.jira) {
          for (const s of config.sources.jira)
            sources.push({ name: s.name, type: "jira" });
        }
        if (config.sources?.confluence) {
          for (const s of config.sources.confluence)
            sources.push({ name: s.name, type: "confluence" });
        }
        if (config.sources?.github) {
          for (const s of config.sources.github)
            sources.push({ name: s.name, type: "github" });
        }
        if (config.sources?.teams) {
          for (const s of config.sources.teams)
            sources.push({ name: s.name, type: "teams" });
        }
        if (config.sources?.cicd) {
          for (const s of config.sources.cicd)
            sources.push({ name: s.name, type: "cicd" });
        }
        if (config.sources?.coverage) {
          for (const s of config.sources.coverage)
            sources.push({ name: s.name, type: "coverage" });
        }
        if (config.sources?.["pull-requests"]) {
          for (const s of config.sources["pull-requests"])
            sources.push({ name: s.name, type: "pull-requests" });
        }
        return { project: config.project, sources };
      },
    },

    {
      name: "get_file_context",
      description:
        "Given a file path, return all relevant wiki context. Searches wiki for mentions of the file, its directory, and its module name.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              'File path to get context for, e.g. "src/middleware/auth.ts"',
          },
        },
        required: ["filePath"],
      },
      handler: async (args) => {
        const filePath = args.filePath as string;
        const parts = filePath.split("/");
        const fileName = basename(filePath);
        const dirName = parts.length > 1 ? parts[parts.length - 2] : "";
        const moduleName = parts.length > 2 ? parts[parts.length - 3] : "";

        // Search for the file name, directory, and module
        const searchTerms = [fileName, dirName, moduleName].filter(
          (t) => t.length > 0
        );
        const allResults = new Map<string, { path: string; title: string; content: string; matchedOn: string[] }>();

        for (const term of searchTerms) {
          const results = pageManager.search(term);
          for (const page of results) {
            const existing = allResults.get(page.path);
            if (existing) {
              existing.matchedOn.push(term);
            } else {
              allResults.set(page.path, {
                path: page.path,
                title: page.title,
                content: page.content,
                matchedOn: [term],
              });
            }
          }
        }

        const sorted = [...allResults.values()].sort(
          (a, b) => b.matchedOn.length - a.matchedOn.length
        );

        return {
          filePath,
          results: sorted.slice(0, 10).map((r) => ({
            path: r.path,
            title: r.title,
            content: r.content.slice(0, 500),
            matchedOn: r.matchedOn,
          })),
        };
      },
    },

    {
      name: "add_memory",
      description:
        "Store an agent learning or memory note. Writes to .ctx/context/manual/ and updates the index.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The memory content to store (markdown)",
          },
          source: {
            type: "string",
            description:
              "Where this memory came from, e.g. 'claude-code', 'cursor'",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for categorizing the memory",
          },
        },
        required: ["content"],
      },
      handler: async (args) => {
        const content = args.content as string;
        const source = (args.source as string) ?? "mcp-agent";
        const tags = (args.tags as string[]) ?? [];

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const fileName = `memory-${timestamp}.md`;
        const relativePath = `manual/${fileName}`;

        const tagLine = tags.length > 0 ? `\nTags: ${tags.join(", ")}` : "";
        const fullContent = `# Agent Memory\n\n_Source: ${source}_\n_Recorded: ${new Date().toISOString()}_${tagLine}\n\n${content}\n`;

        ctxDir.writePage(relativePath, fullContent);

        // Update index.md with the new memory entry
        const indexPath = join(ctxDir.contextPath, "index.md");
        if (existsSync(indexPath)) {
          const indexContent = readFileSync(indexPath, "utf-8");
          const newEntry = `\n- [Memory: ${timestamp}](manual/${fileName}) — ${content.slice(0, 80)}`;
          writeFileSync(indexPath, indexContent + newEntry);
        }

        return {
          stored: true,
          path: relativePath,
          message: `Memory saved to ${relativePath}`,
        };
      },
    },
  ];
}

/**
 * Calculate a simple relevance score for search results.
 */
function calculateRelevance(
  content: string,
  title: string,
  query: string
): number {
  const queryLower = query.toLowerCase();
  const titleLower = title.toLowerCase();
  const contentLower = content.toLowerCase();

  let score = 0;

  // Title match is highly relevant
  if (titleLower.includes(queryLower)) {
    score += 0.5;
  }

  // Count occurrences in content
  const occurrences = contentLower.split(queryLower).length - 1;
  score += Math.min(occurrences * 0.1, 0.5);

  return Math.min(score, 1.0);
}
