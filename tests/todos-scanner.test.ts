import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanForTodos,
  summariseTodos,
  renderTodosMarkdown,
} from "../src/todos/scanner.js";

/**
 * Tests for the TODO scanner. The scanner has ONE job: find TODO-style
 * markers across a source tree and return them as structured items.
 * These tests pin down:
 *   1. It actually finds the markers it claims to.
 *   2. It doesn't false-positive on words that merely contain "TODO".
 *   3. It honours ignore dirs and extension filters.
 *   4. It is pure — no .ctx/ writes, no network.
 */

function makeTempTree(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ctx-todos-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("scanForTodos", () => {
  let tree: ReturnType<typeof makeTempTree>;

  beforeEach(() => {
    tree = makeTempTree();
  });

  afterEach(() => {
    tree.cleanup();
  });

  it("finds a basic // TODO in TypeScript", () => {
    writeFileSync(
      join(tree.dir, "a.ts"),
      `function foo() {\n  // TODO: implement this\n  return 1;\n}\n`
    );

    const items = scanForTodos(tree.dir);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      file: "a.ts",
      line: 2,
      marker: "TODO",
      text: "implement this",
    });
  });

  it("finds FIXME, HACK, XXX, BUG, OPTIMIZE", () => {
    writeFileSync(
      join(tree.dir, "many.js"),
      [
        "// FIXME: broken",
        "// HACK workaround for now",
        "// XXX revisit this",
        "// BUG: off-by-one",
        "// OPTIMIZE: slow loop",
      ].join("\n")
    );

    const items = scanForTodos(tree.dir);
    const markers = items.map((i) => i.marker).sort();
    expect(markers).toEqual(["BUG", "FIXME", "HACK", "OPTIMIZE", "XXX"]);
  });

  it("does NOT match words that merely contain a marker substring", () => {
    // "mastodon" contains TODO, "VOODOO" contains OO + a partial match.
    // Neither should trip the scanner.
    writeFileSync(
      join(tree.dir, "noise.ts"),
      [
        "const mastodon = true;",
        "const voodoo = false;",
        "// not a real todoList variable",
      ].join("\n")
    );

    const items = scanForTodos(tree.dir);
    expect(items).toHaveLength(0);
  });

  it("matches TODO at start of line and inside block comments", () => {
    writeFileSync(
      join(tree.dir, "styles.css"),
      `/* TODO: tidy up colors */\n.foo { color: red; }\nTODO: top-level too\n`
    );

    const items = scanForTodos(tree.dir);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.line)).toEqual([1, 3]);
  });

  it("skips ignored directories (node_modules, .git, dist)", () => {
    mkdirSync(join(tree.dir, "node_modules"));
    writeFileSync(
      join(tree.dir, "node_modules", "dep.ts"),
      "// TODO: third party\n"
    );
    mkdirSync(join(tree.dir, "dist"));
    writeFileSync(join(tree.dir, "dist", "bundle.js"), "// TODO: built\n");

    writeFileSync(join(tree.dir, "src.ts"), "// TODO: mine\n");

    const items = scanForTodos(tree.dir);
    expect(items).toHaveLength(1);
    expect(items[0].file).toBe("src.ts");
    expect(items[0].text).toBe("mine");
  });

  it("skips files with non-scanned extensions", () => {
    writeFileSync(join(tree.dir, "image.png"), "TODO: not real binary");
    writeFileSync(join(tree.dir, "doc.pdf"), "TODO: not real pdf");
    writeFileSync(join(tree.dir, "code.ts"), "// TODO: yes\n");

    const items = scanForTodos(tree.dir);
    expect(items).toHaveLength(1);
    expect(items[0].file).toBe("code.ts");
  });

  it("honours a custom marker list", () => {
    writeFileSync(
      join(tree.dir, "f.ts"),
      "// TODO: one\n// FIXME: two\n// NOTE: three\n"
    );

    const items = scanForTodos(tree.dir, { markers: ["NOTE"] });
    expect(items).toHaveLength(1);
    expect(items[0].marker).toBe("NOTE");
    expect(items[0].text).toBe("three");
  });

  it("honours a limit", () => {
    const content = Array.from({ length: 50 }, (_, i) => `// TODO: item ${i}`).join("\n");
    writeFileSync(join(tree.dir, "many.ts"), content);

    const items = scanForTodos(tree.dir, { limit: 5 });
    expect(items).toHaveLength(5);
  });

  it("returns relative paths with forward slashes regardless of platform", () => {
    mkdirSync(join(tree.dir, "src", "nested"), { recursive: true });
    writeFileSync(
      join(tree.dir, "src", "nested", "deep.ts"),
      "// TODO: deep\n"
    );

    const items = scanForTodos(tree.dir);
    expect(items).toHaveLength(1);
    expect(items[0].file).toBe("src/nested/deep.ts");
  });

  it("handles empty description (just 'TODO')", () => {
    writeFileSync(join(tree.dir, "bare.ts"), "// TODO\n");
    const items = scanForTodos(tree.dir);
    expect(items).toHaveLength(1);
    expect(items[0].marker).toBe("TODO");
    expect(items[0].text).toBe("");
  });

  it("returns [] for a non-existent directory", () => {
    const items = scanForTodos(join(tree.dir, "does-not-exist"));
    expect(items).toEqual([]);
  });
});

describe("summariseTodos", () => {
  it("counts markers", () => {
    const summary = summariseTodos([
      { file: "a", line: 1, marker: "TODO", text: "" },
      { file: "a", line: 2, marker: "TODO", text: "" },
      { file: "b", line: 3, marker: "FIXME", text: "" },
    ]);
    expect(summary).toEqual({ TODO: 2, FIXME: 1 });
  });
});

describe("renderTodosMarkdown", () => {
  it("renders an empty state when no items", () => {
    const md = renderTodosMarkdown([], {
      generatedAt: new Date("2026-04-10T00:00:00Z"),
    });
    expect(md).toContain("# TODOs");
    expect(md).toContain("No TODOs found");
  });

  it("renders a summary table and grouped file list", () => {
    const md = renderTodosMarkdown(
      [
        { file: "src/a.ts", line: 10, marker: "TODO", text: "implement" },
        { file: "src/a.ts", line: 20, marker: "FIXME", text: "bug" },
        { file: "src/b.ts", line: 5, marker: "TODO", text: "" },
      ],
      { generatedAt: new Date("2026-04-10T00:00:00Z"), rootLabel: "." }
    );

    expect(md).toContain("| Marker | Count |");
    expect(md).toContain("| FIXME | 1 |");
    expect(md).toContain("| TODO | 2 |");
    expect(md).toContain("| **Total** | **3** |");
    expect(md).toContain("### `src/a.ts`");
    expect(md).toContain("### `src/b.ts`");
    expect(md).toContain("**TODO** (L10): implement");
    expect(md).toContain("**FIXME** (L20): bug");
    expect(md).toContain("**TODO** (L5): _(no description)_");
  });
});
