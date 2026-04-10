import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, getProjectRoot } from "../../config/loader.js";
import { CtxDirectory } from "../../storage/ctx-dir.js";
import { PageManager } from "../../wiki/pages.js";
import { createLLMFromCtxConfig } from "../../llm/index.js";
import { detectDocType, type DocType } from "../../connectors/markdown-processor.js";

// ── Role definitions ────────────────────────────────────────────────────

type Role = "frontend" | "backend" | "sre" | "mobile" | "pm" | "qa" | "general";

const ROLE_DOC_TYPES: Record<Role, DocType[]> = {
  frontend: ["api", "testing", "repo-structure", "onboarding", "general"],
  backend: ["api", "database", "architecture", "deployment", "security", "testing"],
  sre: ["deployment", "architecture", "incident", "security", "dependencies"],
  mobile: ["api", "testing", "onboarding", "deployment"],
  pm: ["persona", "roadmap", "architecture", "onboarding", "feature-flags"],
  qa: ["testing", "api", "deployment", "feature-flags", "incident"],
  general: ["architecture", "onboarding", "repo-structure", "deployment", "testing"],
};

const VALID_ROLES = Object.keys(ROLE_DOC_TYPES) as Role[];

interface OnboardOptions {
  role?: string;
  name?: string;
  output?: string;
  regenerate?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function categorisePages(
  pageManager: PageManager,
  allPages: string[],
): Array<{ path: string; content: string; docType: DocType }> {
  const categorised: Array<{ path: string; content: string; docType: DocType }> = [];

  for (const pagePath of allPages) {
    if (pagePath === "log.md") continue;
    const page = pageManager.read(pagePath);
    if (!page) continue;

    const docType = detectDocType(pagePath, page.content);
    categorised.push({ path: pagePath, content: page.content, docType });
  }

  return categorised;
}

function selectPagesForRole(
  categorised: Array<{ path: string; content: string; docType: DocType }>,
  role: Role,
): Array<{ path: string; content: string }> {
  const relevantTypes = ROLE_DOC_TYPES[role];

  // Primary: pages matching the role's doc types
  const primary = categorised.filter((p) => relevantTypes.includes(p.docType));

  // Secondary: general pages not already included, as fallback context
  const primaryPaths = new Set(primary.map((p) => p.path));
  const secondary = categorised.filter(
    (p) => !primaryPaths.has(p.path) && p.docType === "general",
  );

  // Combine, keeping primary first; cap at reasonable context window
  const combined = [...primary, ...secondary].slice(0, 30);

  return combined.map((p) => ({ path: p.path, content: p.content }));
}

function describeConnectedSources(config: { sources?: Record<string, unknown> }): string {
  if (!config.sources) return "No external sources configured.";

  const connected: string[] = [];
  for (const [sourceType, sourceList] of Object.entries(config.sources)) {
    if (Array.isArray(sourceList) && sourceList.length > 0) {
      connected.push(`${sourceType} (${sourceList.length})`);
    }
  }

  if (connected.length === 0) return "No external sources configured.";
  return `Connected sources: ${connected.join(", ")}`;
}

function formatTokenCost(input: number, output: number): string {
  // Approximate cost for Sonnet: $3/MTok input, $15/MTok output
  const cost = (input / 1_000_000) * 3 + (output / 1_000_000) * 15;
  return `Tokens: ${input.toLocaleString()} in / ${output.toLocaleString()} out (~$${cost.toFixed(4)})`;
}

// ── Command registration ────────────────────────────────────────────────

export function registerOnboardCommand(program: Command): void {
  program
    .command("onboard")
    .description("Generate a personalised onboarding guide for a new team member")
    .option("--role <role>", `Role: ${VALID_ROLES.join(", ")}`)
    .option("--name <name>", "Personalise the guide with a name")
    .option("--output <file>", "Save the guide to a file instead of stdout")
    .option("--regenerate", "Regenerate the guide even if one exists")
    .action(async (options: OnboardOptions) => {
      const spinner = ora("Preparing onboarding guide...").start();

      try {
        // Validate role
        const role: Role = (options.role as Role) ?? "general";
        if (!VALID_ROLES.includes(role)) {
          spinner.fail(
            chalk.red(`Invalid role "${options.role}". Valid roles: ${VALID_ROLES.join(", ")}`),
          );
          process.exit(1);
        }

        const config = loadConfig();
        const projectRoot = getProjectRoot();
        const ctxDir = new CtxDirectory(projectRoot);

        if (!ctxDir.exists()) {
          spinner.fail(chalk.red("No .ctx/ directory found. Run 'ctx init' first."));
          process.exit(1);
        }

        const pageManager = new PageManager(ctxDir);
        const allPages = pageManager.list();

        if (allPages.length <= 1) {
          spinner.fail(chalk.red("Not enough wiki content. Run 'ctx ingest' first."));
          process.exit(1);
        }

        // Categorise pages by doc type
        spinner.text = "Categorising wiki pages...";
        const categorised = categorisePages(pageManager, allPages);

        // Select relevant pages for the role
        const contextFiles = selectPagesForRole(categorised, role);

        if (contextFiles.length === 0) {
          spinner.fail(chalk.red("No relevant wiki pages found for this role."));
          process.exit(1);
        }

        // Summarise what sources are connected
        const sourceSummary = describeConnectedSources(config as { sources?: Record<string, unknown> });

        // Build doc type summary for the prompt
        const docTypeCounts = new Map<DocType, number>();
        for (const page of categorised) {
          docTypeCounts.set(page.docType, (docTypeCounts.get(page.docType) ?? 0) + 1);
        }
        const docTypeSummary = [...docTypeCounts.entries()]
          .map(([type, count]) => `${type}: ${count}`)
          .join(", ");

        // Generate with Claude
        spinner.text = "Generating onboarding guide with Claude...";

        const claude = createLLMFromCtxConfig(config, "onboard");

        const nameClause = options.name ? ` Their name is ${options.name}.` : "";
        const roleLabel = role === "general" ? "new team member" : `new ${role} engineer`;

        const prompt = `Generate a personalised onboarding guide for a ${roleLabel} joining the ${config.project} project.${nameClause}

## Project context
${sourceSummary}
Wiki page types available: ${docTypeSummary}

## Required sections (use exactly these headings):

### Welcome
A warm, specific welcome.${options.name ? ` Address them by name (${options.name}).` : ""} Briefly explain what the project does and why it matters.

### Read These First
An ordered list of 5-7 wiki pages they should read first. For each page:
- The page path (from the wiki context provided)
- ONE sentence explaining WHY this page matters for their role
Order by importance. Prioritise pages most relevant to a ${roleLabel}.

### Key Concepts
A bullet list of domain-specific terms, acronyms, and concepts they will encounter. Extract these from the wiki content. Include brief definitions.

### Your First Week
A day-by-day plan (Day 1 through Day 5) with specific, actionable tasks:
- Day 1: Environment setup, read core docs
- Day 2: Explore the codebase, run tests
- Day 3-4: Pick up a starter task, pair with someone
- Day 5: Review what they've learned, identify gaps
Tailor tasks to the ${role} role.

### Who Owns What
Extract any ownership, team, or point-of-contact information from the wiki. If none exists, note that this information should be gathered from the team.

### Common Gotchas
Things that commonly trip people up — extract from incident reports, postmortems, or known issues in the wiki. If no incident data exists, note common patterns from the codebase.

### Useful Commands
ctx CLI commands relevant to their role:
- \`ctx chat\` — ask questions about the codebase
- \`ctx query "<question>"\` — quick one-shot questions
- \`ctx search "<term>"\` — search the wiki
- \`ctx status\` — see wiki freshness
- \`ctx diff\` — see what changed since last sync
Add any other commands that would be useful for a ${roleLabel}.

## Rules
- Base the guide ENTIRELY on the wiki content provided. Do not invent information.
- If information is missing for a section, explicitly note what is unknown and suggest they ask the team.
- Use markdown formatting throughout.
- Be specific, not generic. Reference actual pages, actual services, actual concepts from the wiki.`;

        const response = await claude.promptWithFiles(prompt, contextFiles, {
          systemPrompt:
            "You are an onboarding guide creator for software teams. Build a helpful, practical, role-specific guide from the wiki content provided. Be specific and reference real pages — never invent information that is not in the wiki.",
          maxTokens: 4096,
          cacheSystemPrompt: true,
        });

        spinner.stop();

        // Format output
        const guideHeader = `# Onboarding Guide${role !== "general" ? ` — ${role.toUpperCase()}` : ""}${options.name ? ` for ${options.name}` : ""}

_Generated by withctx on ${new Date().toISOString().slice(0, 10)} | Role: ${role} | Pages analysed: ${contextFiles.length}_

`;
        const guide = guideHeader + response.content;

        // Output
        if (options.output) {
          const outputPath = resolve(process.cwd(), options.output);
          writeFileSync(outputPath, guide, "utf-8");
          console.log(chalk.green(`Onboarding guide saved to ${outputPath}`));
        } else {
          console.log();
          console.log(guide);
        }

        // Token usage
        console.log();
        if (response.tokensUsed) {
          console.log(
            chalk.dim(
              formatTokenCost(response.tokensUsed.input, response.tokensUsed.output),
            ),
          );
        }
      } catch (error) {
        spinner.fail(chalk.red("Onboarding guide generation failed"));
        if (error instanceof Error) {
          console.error(chalk.red(`  ${error.message}`));
        }
        process.exit(1);
      }
    });
}
