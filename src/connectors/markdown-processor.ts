import { resolve, dirname, basename, posix } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export type DocType =
  | "architecture"
  | "deployment"
  | "api"
  | "database"
  | "onboarding"
  | "persona"
  | "repo-structure"
  | "testing"
  | "security"
  | "incident"
  | "dependencies"
  | "feature-flags"
  | "roadmap"
  | "changelog"
  | "general";

export interface MarkdownMetadata {
  title: string;
  docType: DocType;
  tags: string[];
  author?: string;
  date?: string;
  status?: string;
  category?: string;
  custom: Record<string, unknown>;
}

export interface MarkdownSection {
  heading: string;
  content: string;
  level: number;
  lineStart: number;
  lineEnd: number;
}

export interface CrossReference {
  text: string;
  targetPath: string;
  rawPath: string;
}

export interface ProcessedMarkdown {
  filePath: string;
  metadata: MarkdownMetadata;
  sections: MarkdownSection[];
  crossReferences: CrossReference[];
  rawContent: string;
}

export interface DocTreeNode {
  filePath: string;
  metadata: MarkdownMetadata;
  children: DocTreeNode[];
  parent?: string;
}

// ── Filename patterns for doc type detection ───────────────────────────

interface DocTypeRule {
  type: DocType;
  filePatterns: RegExp[];
  contentPatterns: RegExp[];
}

const DOC_TYPE_RULES: DocTypeRule[] = [
  {
    type: "architecture",
    filePatterns: [/^architect/i, /^adr-/i, /^design-/i, /^system-/i],
    contentPatterns: [/architecture decision record/i, /system design/i],
  },
  {
    type: "deployment",
    filePatterns: [/^deploy/i, /^runbook-/i, /^infra/i, /^ci-cd/i],
    contentPatterns: [/deployment steps/i, /docker/i, /kubernetes|k8s/i],
  },
  {
    type: "api",
    filePatterns: [/^api\./i, /^endpoint/i, /^routes/i, /^swagger/i, /^openapi/i],
    contentPatterns: [/\b(GET|POST|PUT|DELETE)\s+\/\S+/],
  },
  {
    type: "database",
    filePatterns: [/^schema/i, /^database/i, /^db-/i, /^migration/i, /^erd/i],
    contentPatterns: [/\btables?\b.*\bcolumns?\b/i, /\bmigration/i],
  },
  {
    type: "onboarding",
    filePatterns: [/^onboard/i, /^getting-started/i, /^setup/i, /^new-hire/i],
    contentPatterns: [/setup steps/i, /prerequisites/i],
  },
  {
    type: "persona",
    filePatterns: [/^persona/i, /^user/i, /^customer/i],
    contentPatterns: [/user types/i, /pain points/i, /user journey/i],
  },
  {
    type: "repo-structure",
    filePatterns: [/^structure/i, /^monorepo/i, /^project-layout/i],
    contentPatterns: [/directory layout/i, /folder structure/i],
  },
  {
    type: "testing",
    filePatterns: [/^test/i, /^qa/i, /^coverage/i],
    contentPatterns: [/test strategy/i, /mocking/i, /fixtures/i],
  },
  {
    type: "security",
    filePatterns: [/^security/i, /^auth/i, /^compliance/i, /^hipaa/i, /^gdpr/i],
    contentPatterns: [/authentication/i, /authorization/i, /encryption/i],
  },
  {
    type: "incident",
    filePatterns: [/^postmortem/i, /^incident/i, /^outage/i, /^rca-/i],
    contentPatterns: [/root cause/i, /timeline/i, /resolution/i],
  },
  {
    type: "dependencies",
    filePatterns: [/^dependenc/i, /^third-party/i, /^vendor/i, /^licensing/i],
    contentPatterns: [],
  },
  {
    type: "feature-flags",
    filePatterns: [/^flag/i, /^feature-flag/i, /^toggle/i, /^config/i],
    contentPatterns: [],
  },
  {
    type: "roadmap",
    filePatterns: [/^rfc-/i, /^roadmap/i, /^proposal-/i, /^plan-/i],
    contentPatterns: [/proposed changes/i, /timelines/i],
  },
  {
    type: "changelog",
    filePatterns: [/^changelog/i, /^release-notes/i, /^history/i],
    contentPatterns: [],
  },
];

// ── Frontmatter parsing ────────────────────────────────────────────────

/**
 * Parse YAML-like frontmatter between `---` delimiters.
 * Handles simple key: value pairs, arrays (comma-separated or YAML list),
 * and quoted strings. Does NOT use a YAML parser library.
 */
export function parseFrontmatter(content: string): {
  metadata: Partial<MarkdownMetadata>;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { metadata: {}, body: content };
  }

  // Find the closing --- delimiter
  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { metadata: {}, body: content };
  }

  const frontmatterBlock = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 4); // skip past \n---

  const metadata: Partial<MarkdownMetadata> = {};
  const custom: Record<string, unknown> = {};

  // Known fields that map directly into MarkdownMetadata
  const knownFields = new Set(["title", "tags", "author", "date", "category", "status"]);

  for (const line of frontmatterBlock.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key === "tags") {
      // Support both [a, b, c] and comma-separated
      const cleaned = value.replace(/^\[|\]$/g, "");
      metadata.tags = cleaned.split(",").map((t) => t.trim()).filter(Boolean);
    } else if (knownFields.has(key)) {
      (metadata as Record<string, unknown>)[key] = value;
    } else {
      custom[key] = value;
    }
  }

  metadata.custom = custom;
  return { metadata, body };
}

// ── Doc type detection ─────────────────────────────────────────────────

/**
 * Detect the document type from filename patterns and content heuristics.
 * Filename matching takes priority; content is checked as fallback.
 */
export function detectDocType(filename: string, content: string): DocType {
  const base = basename(filename).toLowerCase();

  // Check filename patterns first
  for (const rule of DOC_TYPE_RULES) {
    for (const pattern of rule.filePatterns) {
      if (pattern.test(base)) {
        return rule.type;
      }
    }
  }

  // Fall back to content heuristics
  for (const rule of DOC_TYPE_RULES) {
    for (const pattern of rule.contentPatterns) {
      if (pattern.test(content)) {
        return rule.type;
      }
    }
  }

  return "general";
}

// ── Section extraction ─────────────────────────────────────────────────

/**
 * Split a markdown document into sections based on H2 (##) headings.
 * Nested H3 headings remain within their parent H2 section.
 * If the document has no H2 headings, the entire content is one section.
 */
export function extractSections(content: string): MarkdownSection[] {
  const lines = content.split("\n");
  const sections: MarkdownSection[] = [];

  // Find all H2 heading positions
  const h2Positions: { index: number; heading: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^##\s+(.+)/);
    if (match) {
      h2Positions.push({ index: i, heading: match[1].trim() });
    }
  }

  // No H2 headings — treat entire doc as one section
  if (h2Positions.length === 0) {
    // Try to detect the first heading of any level for the section
    let heading = "";
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
      const hMatch = lines[i].match(/^(#{1,6})\s+(.+)/);
      if (hMatch) {
        heading = hMatch[2].trim();
        level = hMatch[1].length;
        break;
      }
    }
    sections.push({
      heading,
      content: content,
      level,
      lineStart: 1,
      lineEnd: lines.length,
    });
    return sections;
  }

  // If there's content before the first H2, capture it as a preamble section
  if (h2Positions[0].index > 0) {
    const preambleLines = lines.slice(0, h2Positions[0].index);
    const preambleContent = preambleLines.join("\n").trim();
    if (preambleContent) {
      sections.push({
        heading: "",
        content: preambleContent,
        level: 0,
        lineStart: 1,
        lineEnd: h2Positions[0].index, // line before the first H2
      });
    }
  }

  // Create a section for each H2 heading
  for (let i = 0; i < h2Positions.length; i++) {
    const start = h2Positions[i].index;
    const end = i + 1 < h2Positions.length ? h2Positions[i + 1].index : lines.length;
    const sectionLines = lines.slice(start, end);

    sections.push({
      heading: h2Positions[i].heading,
      content: sectionLines.join("\n").trim(),
      level: 2,
      lineStart: start + 1, // 1-indexed
      lineEnd: end,         // 1-indexed (exclusive becomes inclusive of last line)
    });
  }

  return sections;
}

// ── Link resolution ────────────────────────────────────────────────────

/**
 * Find all markdown links with relative file paths (not http/https/mailto)
 * and resolve them against the document's directory.
 */
export function resolveLinks(
  content: string,
  filePath: string,
  basePath: string,
): CrossReference[] {
  const refs: CrossReference[] = [];
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  const docDir = dirname(resolve(basePath, filePath));

  while ((match = linkRegex.exec(content)) !== null) {
    const text = match[1];
    const rawPath = match[2];

    // Skip absolute URLs and anchors
    if (/^(https?:|mailto:|#|ftp:)/.test(rawPath)) continue;

    // Strip any anchor fragment
    const pathWithoutAnchor = rawPath.split("#")[0];
    if (!pathWithoutAnchor) continue;

    const targetPath = resolve(docDir, pathWithoutAnchor);

    refs.push({ text, targetPath, rawPath });
  }

  return refs;
}

// ── Main processing function ───────────────────────────────────────────

/**
 * Process a single markdown file: parse frontmatter, detect doc type,
 * extract sections, and resolve cross-references.
 */
export function processMarkdown(
  filePath: string,
  content: string,
  basePath: string,
): ProcessedMarkdown {
  const { metadata: frontmatter, body } = parseFrontmatter(content);
  const docType = detectDocType(filePath, content);
  const sections = extractSections(body);
  const crossReferences = resolveLinks(content, filePath, basePath);

  // Infer title: frontmatter title > first heading > filename
  let title = frontmatter.title as string | undefined;
  if (!title) {
    const headingMatch = body.match(/^#\s+(.+)/m);
    if (headingMatch) {
      title = headingMatch[1].trim();
    } else {
      title = basename(filePath, ".md");
    }
  }

  const metadata: MarkdownMetadata = {
    title,
    docType,
    tags: frontmatter.tags ?? [],
    author: frontmatter.author as string | undefined,
    date: frontmatter.date as string | undefined,
    status: frontmatter.status as string | undefined,
    category: frontmatter.category as string | undefined,
    custom: (frontmatter.custom as Record<string, unknown>) ?? {},
  };

  return {
    filePath,
    metadata,
    sections,
    crossReferences,
    rawContent: content,
  };
}

// ── Doc tree building ──────────────────────────────────────────────────

/**
 * Build a parent-child tree from a flat list of processed markdown docs.
 *
 * Rules:
 * - A README.md in a directory is the "index" for that directory.
 * - Non-README files in a directory are children of that directory's README.
 * - If no README exists in the directory, walk up to find the nearest parent README.
 * - Top-level files without a parent become root nodes.
 */
/**
 * Resolve cross-references across multiple repos.
 * Given a map of sourceName → basePath, re-resolves links that point outside
 * a doc's own repo to find the actual target in another repo.
 */
export function resolveCrossRepoLinks(
  docs: ProcessedMarkdown[],
  repoMap: Map<string, string>,  // sourceName → basePath
): Map<string, CrossReference[]> {
  // Build a lookup of all known file paths across all repos
  const allFilePaths = new Set<string>();
  for (const doc of docs) {
    allFilePaths.add(resolve(doc.filePath));
  }

  const crossRepoRefs = new Map<string, CrossReference[]>();

  for (const doc of docs) {
    const externalRefs: CrossReference[] = [];
    for (const ref of doc.crossReferences) {
      const resolvedTarget = resolve(ref.targetPath);
      // If the target exists in our known docs but is in a different repo, it's cross-repo
      if (allFilePaths.has(resolvedTarget)) {
        // Already resolved correctly
        continue;
      }
      // Try to find it in other repos
      for (const [_repoName, repoBasePath] of repoMap) {
        const candidate = resolve(repoBasePath, ref.rawPath);
        if (allFilePaths.has(candidate)) {
          externalRefs.push({
            text: ref.text,
            targetPath: candidate,
            rawPath: ref.rawPath,
          });
          break;
        }
      }
    }
    if (externalRefs.length > 0) {
      crossRepoRefs.set(doc.filePath, externalRefs);
    }
  }

  return crossRepoRefs;
}

export function buildDocTree(docs: ProcessedMarkdown[]): DocTreeNode[] {
  // Build a lookup of directory -> README doc
  const readmeByDir = new Map<string, string>();
  const allPaths = new Set<string>();

  for (const doc of docs) {
    allPaths.add(doc.filePath);
    const base = basename(doc.filePath).toLowerCase();
    if (base === "readme.md") {
      // Normalize directory: use posix-style for consistency
      const dir = dirname(doc.filePath);
      readmeByDir.set(dir, doc.filePath);
    }
  }

  // Create nodes
  const nodeMap = new Map<string, DocTreeNode>();
  for (const doc of docs) {
    nodeMap.set(doc.filePath, {
      filePath: doc.filePath,
      metadata: doc.metadata,
      children: [],
    });
  }

  const roots: DocTreeNode[] = [];

  for (const doc of docs) {
    const node = nodeMap.get(doc.filePath)!;
    const dir = dirname(doc.filePath);
    const base = basename(doc.filePath).toLowerCase();

    // READMEs: their parent is the README of an ancestor directory
    if (base === "readme.md") {
      let parentPath: string | undefined;
      let searchDir: string | null = dirname(dir); // go up one level from this README's dir

      while (searchDir) {
        const candidate = readmeByDir.get(searchDir);
        if (candidate && candidate !== doc.filePath) {
          parentPath = candidate;
          break;
        }
        const up = dirname(searchDir);
        if (up === searchDir) break; // reached root ("." or "/")
        searchDir = up;
      }

      if (parentPath) {
        node.parent = parentPath;
        nodeMap.get(parentPath)!.children.push(node);
      } else {
        roots.push(node);
      }
    } else {
      // Non-README: find the closest README up the directory tree
      let searchDir: string | null = dir;
      let parentPath: string | undefined;

      while (searchDir) {
        const candidate = readmeByDir.get(searchDir);
        if (candidate && candidate !== doc.filePath) {
          parentPath = candidate;
          break;
        }
        const up = dirname(searchDir);
        if (up === searchDir) break; // reached filesystem root
        searchDir = up;
      }

      if (parentPath) {
        node.parent = parentPath;
        nodeMap.get(parentPath)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
  }

  return roots;
}
