import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";

interface GraphOptions {
  format?: "mermaid" | "dot" | "text";
  output?: string;
}

interface PageNode {
  path: string;
  title: string;
  references: string[];
}

function buildMermaidGraph(nodes: PageNode[]): string {
  const lines: string[] = [];
  lines.push("graph LR");

  // Create node IDs (sanitize path to valid mermaid ID)
  const toId = (path: string): string =>
    path.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_");

  // Define nodes
  for (const node of nodes) {
    const id = toId(node.path);
    const label = node.title || node.path;
    lines.push(`  ${id}["${label.replace(/"/g, "'")}"]`);
  }

  // Define edges
  const nodePathSet = new Set(nodes.map((n) => n.path));
  for (const node of nodes) {
    for (const ref of node.references) {
      if (nodePathSet.has(ref) && ref !== node.path) {
        lines.push(`  ${toId(node.path)} --> ${toId(ref)}`);
      }
    }
  }

  return lines.join("\n");
}

function buildDotGraph(nodes: PageNode[]): string {
  const lines: string[] = [];
  lines.push("digraph wiki {");
  lines.push("  rankdir=LR;");
  lines.push('  node [shape=box, style=rounded, fontname="Helvetica"];');

  const toId = (path: string): string =>
    path.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_");

  const nodePathSet = new Set(nodes.map((n) => n.path));

  for (const node of nodes) {
    const id = toId(node.path);
    const label = node.title || node.path;
    lines.push(`  ${id} [label="${label.replace(/"/g, "'")}"];`);
  }

  for (const node of nodes) {
    for (const ref of node.references) {
      if (nodePathSet.has(ref) && ref !== node.path) {
        lines.push(`  ${toId(node.path)} -> ${toId(ref)};`);
      }
    }
  }

  lines.push("}");
  return lines.join("\n");
}

function buildTextGraph(nodes: PageNode[]): string {
  const lines: string[] = [];
  const nodePathSet = new Set(nodes.map((n) => n.path));

  lines.push("Wiki Page Graph");
  lines.push("===============");
  lines.push("");

  for (const node of nodes) {
    lines.push(`[${node.title || node.path}] (${node.path})`);
    const validRefs = node.references.filter(
      (r) => nodePathSet.has(r) && r !== node.path
    );
    if (validRefs.length > 0) {
      for (const ref of validRefs) {
        const target = nodes.find((n) => n.path === ref);
        lines.push(`  --> ${target?.title || ref}`);
      }
    } else {
      lines.push("  (no outgoing links)");
    }
    lines.push("");
  }

  // Summary
  const totalEdges = nodes.reduce((sum, n) => {
    return sum + n.references.filter((r) => nodePathSet.has(r) && r !== n.path).length;
  }, 0);
  const orphans = nodes.filter((n) => {
    const hasOutgoing = n.references.some((r) => nodePathSet.has(r) && r !== n.path);
    const hasIncoming = nodes.some(
      (other) => other.path !== n.path && other.references.includes(n.path)
    );
    return !hasOutgoing && !hasIncoming;
  });

  lines.push("---");
  lines.push(`Pages: ${nodes.length}`);
  lines.push(`Links: ${totalEdges}`);
  if (orphans.length > 0) {
    lines.push(`Orphans: ${orphans.map((o) => o.path).join(", ")}`);
  }

  return lines.join("\n");
}

export function registerGraphCommand(program: Command): void {
  program
    .command("graph")
    .description("Generate a dependency graph of wiki page cross-references")
    .option("--format <type>", "Output format: mermaid, dot, text", "mermaid")
    .option("--output <path>", "Output file path (default: .ctx/exports/graph.<format>)")
    .action(async (options: GraphOptions) => {
      const spinner = ora("Scanning wiki pages...").start();

      try {
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx setup' first."));
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);
        const allPages = pageManager.list().filter(
          (p) => p !== "index.md" && p !== "log.md"
        );

        if (allPages.length === 0) {
          spinner.fail(chalk.red("No wiki pages found. Run 'ctx ingest' first."));
          process.exit(1);
        }

        // Build nodes with references
        const nodes: PageNode[] = [];
        for (const pagePath of allPages) {
          const page = pageManager.read(pagePath);
          if (!page) continue;

          nodes.push({
            path: pagePath,
            title: page.title,
            references: page.references,
          });
        }

        spinner.succeed(`Scanned ${chalk.bold(String(nodes.length))} wiki pages`);

        // Generate graph in the requested format
        const format = options.format ?? "mermaid";
        let graphContent: string;
        let fileExtension: string;

        switch (format) {
          case "dot":
            graphContent = buildDotGraph(nodes);
            fileExtension = "dot";
            break;
          case "text":
            graphContent = buildTextGraph(nodes);
            fileExtension = "txt";
            break;
          case "mermaid":
          default:
            graphContent = buildMermaidGraph(nodes);
            fileExtension = "mermaid";
            break;
        }

        // Determine output path
        const outputPath =
          options.output ??
          join(ctxDir.exportsPath, `graph.${fileExtension}`);

        // Ensure exports directory exists
        const outputDir = join(outputPath, "..");
        mkdirSync(outputDir, { recursive: true });

        writeFileSync(outputPath, graphContent);

        // Print to terminal
        console.log();
        console.log(chalk.bold(`Wiki Graph (${format}):`));
        console.log(chalk.dim("─".repeat(50)));
        console.log(graphContent);
        console.log(chalk.dim("─".repeat(50)));
        console.log();
        console.log(chalk.dim(`Written to: ${outputPath}`));

        // Stats
        const totalEdges = nodes.reduce((sum, n) => {
          const nodePathSet = new Set(nodes.map((nn) => nn.path));
          return sum + n.references.filter((r) => nodePathSet.has(r) && r !== n.path).length;
        }, 0);
        console.log(
          `  Pages: ${chalk.cyan(String(nodes.length))}  Links: ${chalk.cyan(String(totalEdges))}`
        );
        console.log();
      } catch (error) {
        spinner.fail(chalk.red("Graph generation failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
