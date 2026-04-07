import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";

interface ServeOptions {
  port?: string;
}

export function registerServeCommand(program: Command): void {
  program
    .command("serve")
    .description("Start the withctx API server")
    .option("--port <port>", "Port to listen on", "4400")
    .action(async (options: ServeOptions) => {
      const spinner = ora("Starting server...").start();

      try {
        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        const port = parseInt(options.port ?? "4400", 10);
        const pageManager = new PageManager(ctxDir);

        // Dynamic import of fastify to avoid loading it for other commands
        const { default: Fastify } = await import("fastify");
        const fastify = Fastify({ logger: false });

        // --- Health ---
        fastify.get("/health", async () => {
          return { status: "ok", project: config.project, timestamp: new Date().toISOString() };
        });

        // --- Pages ---
        fastify.get("/api/pages", async () => {
          const pages = pageManager.list();
          return {
            pages: pages.map((p) => {
              const page = pageManager.read(p);
              return {
                path: p,
                title: page?.title ?? p,
                updatedAt: page?.updatedAt ?? null,
              };
            }),
          };
        });

        fastify.get<{ Params: { path: string } }>(
          "/api/pages/:path",
          async (request, reply) => {
            const pagePath = request.params.path;
            const page = pageManager.read(pagePath);
            if (!page) {
              reply.status(404);
              return { error: "Page not found" };
            }
            return page;
          }
        );

        // --- Index ---
        fastify.get("/api/index", async () => {
          return { entries: pageManager.getIndex() };
        });

        // --- Search ---
        fastify.get<{ Querystring: { q: string } }>(
          "/api/search",
          async (request) => {
            const query = request.query.q ?? "";
            if (!query) {
              return { results: [] };
            }
            const results = pageManager.search(query);
            return {
              query,
              results: results.map((p) => ({
                path: p.path,
                title: p.title,
                snippet: p.content.slice(0, 200),
              })),
            };
          }
        );

        // --- Sources status ---
        fastify.get("/api/sources", async () => {
          const sources: Array<{ name: string; type: string }> = [];
          if (config.sources?.local) {
            for (const s of config.sources.local) sources.push({ name: s.name, type: "local" });
          }
          if (config.sources?.jira) {
            for (const s of config.sources.jira) sources.push({ name: s.name, type: "jira" });
          }
          if (config.sources?.confluence) {
            for (const s of config.sources.confluence) sources.push({ name: s.name, type: "confluence" });
          }
          if (config.sources?.github) {
            for (const s of config.sources.github) sources.push({ name: s.name, type: "github" });
          }
          if (config.sources?.teams) {
            for (const s of config.sources.teams) sources.push({ name: s.name, type: "teams" });
          }
          return { sources };
        });

        // --- Costs ---
        fastify.get("/api/costs", async () => {
          const costs = ctxDir.readCosts();
          return costs ?? { totalTokens: 0, totalCostUsd: 0, operations: [] };
        });

        // --- Pack (generate CLAUDE.md on the fly) ---
        fastify.get<{ Querystring: { format?: string; scope?: string } }>(
          "/api/pack",
          async (request) => {
            const format = request.query.format ?? "claude-md";
            const scope = request.query.scope;
            const allPagePaths = pageManager.list(scope);
            const pages: Array<{ path: string; content: string }> = [];

            for (const pagePath of allPagePaths) {
              if (pagePath === "log.md") continue;
              const page = pageManager.read(pagePath);
              if (page) {
                pages.push({ path: pagePath, content: page.content });
              }
            }

            let output: string;
            if (format === "system-prompt") {
              output = `You have access to the following project context for "${config.project}":\n\n`;
              for (const page of pages) {
                output += `<context file="${page.path}">\n${page.content}\n</context>\n\n`;
              }
            } else {
              output = `# CLAUDE.md — ${config.project}\n\n`;
              for (const page of pages) {
                output += `${page.content}\n\n---\n\n`;
              }
            }

            return {
              format,
              content: output,
              pageCount: pages.length,
              tokenEstimate: Math.ceil(output.length / 4),
            };
          }
        );

        // --- Status ---
        fastify.get("/api/status", async () => {
          const pages = pageManager.list();
          const costs = ctxDir.readCosts();

          return {
            project: config.project,
            pageCount: pages.length,
            costs: costs ?? { totalTokens: 0, totalCostUsd: 0 },
          };
        });

        // Start listening
        await fastify.listen({ port, host: "0.0.0.0" });

        spinner.succeed(chalk.green(`Server running on http://localhost:${port}`));
        console.log();
        console.log(chalk.bold("  API Endpoints:"));
        console.log(`    GET /health           ${chalk.dim("— Health check")}`);
        console.log(`    GET /api/pages        ${chalk.dim("— List all pages")}`);
        console.log(`    GET /api/pages/:path  ${chalk.dim("— Get a page")}`);
        console.log(`    GET /api/index        ${chalk.dim("— Wiki index")}`);
        console.log(`    GET /api/search?q=    ${chalk.dim("— Search pages")}`);
        console.log(`    GET /api/sources      ${chalk.dim("— Source list")}`);
        console.log(`    GET /api/costs        ${chalk.dim("— Cost report")}`);
        console.log(`    GET /api/pack         ${chalk.dim("— Pack wiki output")}`);
        console.log(`    GET /api/status       ${chalk.dim("— Project status")}`);
        console.log();
        console.log(chalk.dim("  Press Ctrl+C to stop"));

        // Handle graceful shutdown
        const shutdown = async () => {
          console.log(chalk.dim("\n  Shutting down..."));
          await fastify.close();
          process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (error) {
        spinner.fail(chalk.red("Server failed to start"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
