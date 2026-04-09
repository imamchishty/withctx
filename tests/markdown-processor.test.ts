import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  detectDocType,
  extractSections,
  resolveLinks,
  processMarkdown,
  buildDocTree,
} from "../src/connectors/markdown-processor.js";
import type { ProcessedMarkdown, DocType } from "../src/connectors/markdown-processor.js";

// ── Frontmatter parsing ────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  it("should parse standard YAML frontmatter", () => {
    const content = `---
title: Architecture Overview
tags: [backend, system]
author: Alice
date: 2025-01-15
status: approved
category: design
---

# Architecture Overview

Some content here.`;

    const { metadata, body } = parseFrontmatter(content);
    expect(metadata.title).toBe("Architecture Overview");
    expect(metadata.tags).toEqual(["backend", "system"]);
    expect(metadata.author).toBe("Alice");
    expect(metadata.date).toBe("2025-01-15");
    expect(metadata.status).toBe("approved");
    expect(metadata.category).toBe("design");
    expect(body).toContain("# Architecture Overview");
  });

  it("should return empty metadata when no frontmatter exists", () => {
    const content = `# Just a heading\n\nSome content.`;
    const { metadata, body } = parseFrontmatter(content);
    expect(metadata.title).toBeUndefined();
    expect(metadata.tags).toBeUndefined();
    expect(body).toBe(content);
  });

  it("should collect unknown fields into custom", () => {
    const content = `---
title: Test
priority: high
team: platform
---
Body`;

    const { metadata } = parseFrontmatter(content);
    expect(metadata.custom).toEqual({ priority: "high", team: "platform" });
  });

  it("should handle quoted values", () => {
    const content = `---
title: "My Doc Title"
author: 'Bob Smith'
---
Body`;

    const { metadata } = parseFrontmatter(content);
    expect(metadata.title).toBe("My Doc Title");
    expect(metadata.author).toBe("Bob Smith");
  });
});

// ── Doc type detection ─────────────────────────────────────────────────

describe("detectDocType", () => {
  it("should detect architecture from filename", () => {
    expect(detectDocType("architecture-overview.md", "")).toBe("architecture");
    expect(detectDocType("adr-001-use-postgres.md", "")).toBe("architecture");
    expect(detectDocType("design-patterns.md", "")).toBe("architecture");
  });

  it("should detect deployment from filename", () => {
    expect(detectDocType("deploy-guide.md", "")).toBe("deployment");
    expect(detectDocType("runbook-production.md", "")).toBe("deployment");
    expect(detectDocType("ci-cd-pipeline.md", "")).toBe("deployment");
  });

  it("should detect api from filename", () => {
    expect(detectDocType("api.md", "")).toBe("api");
    expect(detectDocType("swagger-spec.md", "")).toBe("api");
  });

  it("should detect security from filename", () => {
    expect(detectDocType("security-policy.md", "")).toBe("security");
    expect(detectDocType("auth-flow.md", "")).toBe("security");
    expect(detectDocType("hipaa-compliance.md", "")).toBe("security");
  });

  it("should detect testing from filename", () => {
    expect(detectDocType("testing-strategy.md", "")).toBe("testing");
    expect(detectDocType("qa-process.md", "")).toBe("testing");
  });

  it("should detect from content when filename is generic", () => {
    expect(detectDocType("readme.md", "This is an architecture decision record for our services.")).toBe("architecture");
    expect(detectDocType("readme.md", "## Steps\nGET /api/users\nPOST /api/orders")).toBe("api");
    expect(detectDocType("notes.md", "Covers authentication and authorization flows")).toBe("security");
  });

  it("should return general when nothing matches", () => {
    expect(detectDocType("readme.md", "Just some notes about the project.")).toBe("general");
  });

  it("should detect incident from filename", () => {
    expect(detectDocType("postmortem-2025-01.md", "")).toBe("incident");
    expect(detectDocType("rca-database-outage.md", "")).toBe("incident");
  });

  it("should detect changelog from filename", () => {
    expect(detectDocType("changelog.md", "")).toBe("changelog");
    expect(detectDocType("release-notes-v2.md", "")).toBe("changelog");
  });
});

// ── Section extraction ─────────────────────────────────────────────────

describe("extractSections", () => {
  it("should return entire doc as one section when no H2 headings", () => {
    const content = `# Title\n\nSome paragraph.\n\nAnother paragraph.`;
    const sections = extractSections(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("Title");
    expect(sections[0].level).toBe(1);
    expect(sections[0].content).toBe(content);
  });

  it("should split on H2 headings", () => {
    const content = `## Overview\n\nIntro text.\n\n## Installation\n\nRun npm install.\n\n## Usage\n\nImport the module.`;
    const sections = extractSections(content);
    expect(sections).toHaveLength(3);
    expect(sections[0].heading).toBe("Overview");
    expect(sections[0].level).toBe(2);
    expect(sections[1].heading).toBe("Installation");
    expect(sections[2].heading).toBe("Usage");
  });

  it("should capture preamble before first H2", () => {
    const content = `# Title\n\nIntro paragraph.\n\n## Section One\n\nContent.`;
    const sections = extractSections(content);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe(""); // preamble
    expect(sections[0].content).toContain("Title");
    expect(sections[1].heading).toBe("Section One");
  });

  it("should keep nested H3 within their parent H2", () => {
    const content = `## Parent\n\nSome text.\n\n### Child\n\nChild text.\n\n## Next`;
    const sections = extractSections(content);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe("Parent");
    expect(sections[0].content).toContain("### Child");
    expect(sections[0].content).toContain("Child text.");
    expect(sections[1].heading).toBe("Next");
  });

  it("should provide correct line ranges", () => {
    const content = `## First\n\nLine 2.\n\n## Second\n\nLine 6.`;
    const sections = extractSections(content);
    expect(sections[0].lineStart).toBe(1);
    expect(sections[1].lineStart).toBe(5);
  });
});

// ── Link resolution ────────────────────────────────────────────────────

describe("resolveLinks", () => {
  it("should resolve relative paths", () => {
    const content = `See [setup guide](./setup.md) for details.`;
    const refs = resolveLinks(content, "docs/intro.md", "/project");
    expect(refs).toHaveLength(1);
    expect(refs[0].text).toBe("setup guide");
    expect(refs[0].rawPath).toBe("./setup.md");
    expect(refs[0].targetPath).toBe("/project/docs/setup.md");
  });

  it("should resolve parent directory paths", () => {
    const content = `See [root readme](../README.md).`;
    const refs = resolveLinks(content, "docs/guide/intro.md", "/project");
    expect(refs).toHaveLength(1);
    expect(refs[0].targetPath).toBe("/project/docs/README.md");
  });

  it("should ignore absolute URLs", () => {
    const content = `Check [Google](https://google.com) and [local](./local.md).`;
    const refs = resolveLinks(content, "docs/intro.md", "/project");
    expect(refs).toHaveLength(1);
    expect(refs[0].text).toBe("local");
  });

  it("should ignore anchor-only links", () => {
    const content = `Jump to [section](#overview).`;
    const refs = resolveLinks(content, "docs/intro.md", "/project");
    expect(refs).toHaveLength(0);
  });

  it("should strip anchor fragments from paths", () => {
    const content = `See [setup](./setup.md#step-1).`;
    const refs = resolveLinks(content, "docs/intro.md", "/project");
    expect(refs).toHaveLength(1);
    expect(refs[0].targetPath).toBe("/project/docs/setup.md");
    expect(refs[0].rawPath).toBe("./setup.md#step-1");
  });
});

// ── Doc tree building ──────────────────────────────────────────────────

describe("buildDocTree", () => {
  function makeDocs(paths: string[]): ProcessedMarkdown[] {
    return paths.map((p) => ({
      filePath: p,
      metadata: {
        title: p,
        docType: "general" as DocType,
        tags: [],
        custom: {},
      },
      sections: [],
      crossReferences: [],
      rawContent: "",
    }));
  }

  it("should make root README the top node", () => {
    const docs = makeDocs(["README.md", "docs/setup.md"]);
    const tree = buildDocTree(docs);
    expect(tree).toHaveLength(1);
    expect(tree[0].filePath).toBe("README.md");
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].filePath).toBe("docs/setup.md");
  });

  it("should nest package README under root README", () => {
    const docs = makeDocs(["README.md", "packages/api/README.md"]);
    const tree = buildDocTree(docs);
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].filePath).toBe("packages/api/README.md");
    expect(tree[0].children[0].parent).toBe("README.md");
  });

  it("should nest files under their directory README", () => {
    const docs = makeDocs([
      "README.md",
      "docs/auth/README.md",
      "docs/auth/setup.md",
    ]);
    const tree = buildDocTree(docs);
    expect(tree).toHaveLength(1);
    // docs/auth/README.md is child of root README
    const authReadme = tree[0].children.find((c) => c.filePath === "docs/auth/README.md");
    expect(authReadme).toBeDefined();
    // docs/auth/setup.md is child of docs/auth/README.md
    expect(authReadme!.children[0].filePath).toBe("docs/auth/setup.md");
  });

  it("should fall back to nearest parent README when no direct README exists", () => {
    const docs = makeDocs(["README.md", "docs/auth/setup.md"]);
    const tree = buildDocTree(docs);
    expect(tree).toHaveLength(1);
    // docs/auth/setup.md should be a child of README.md (no docs/README.md or docs/auth/README.md)
    expect(tree[0].children[0].filePath).toBe("docs/auth/setup.md");
    expect(tree[0].children[0].parent).toBe("README.md");
  });
});

// ── Full integration test ──────────────────────────────────────────────

describe("processMarkdown", () => {
  it("should process a full document end-to-end", () => {
    const content = `---
title: API Reference
tags: [api, rest]
author: Dev Team
date: 2025-03-01
status: published
---

# API Reference

This documents our REST API.

## Authentication

Use bearer tokens. See [auth setup](../auth/setup.md).

## Endpoints

GET /api/users — list all users.
POST /api/users — create a user.

## Error Codes

Standard HTTP error codes apply.`;

    const result = processMarkdown("docs/api/api.md", content, "/project");

    // Metadata
    expect(result.metadata.title).toBe("API Reference");
    expect(result.metadata.docType).toBe("api");
    expect(result.metadata.tags).toEqual(["api", "rest"]);
    expect(result.metadata.author).toBe("Dev Team");
    expect(result.metadata.status).toBe("published");

    // Sections — body has preamble + 3 H2 sections
    expect(result.sections.length).toBeGreaterThanOrEqual(3);

    // Cross-references
    expect(result.crossReferences).toHaveLength(1);
    expect(result.crossReferences[0].targetPath).toBe("/project/docs/auth/setup.md");

    // Raw content preserved
    expect(result.rawContent).toBe(content);
  });

  it("should infer title from first heading when no frontmatter", () => {
    const content = `# Getting Started\n\nWelcome to the project.`;
    const result = processMarkdown("onboarding.md", content, "/project");
    expect(result.metadata.title).toBe("Getting Started");
    expect(result.metadata.docType).toBe("onboarding");
  });

  it("should fall back to filename for title when no heading", () => {
    const content = `Just some text without any headings.`;
    const result = processMarkdown("notes.md", content, "/project");
    expect(result.metadata.title).toBe("notes");
  });
});
